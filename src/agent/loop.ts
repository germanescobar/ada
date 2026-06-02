import chalk from "chalk";
import type { ModelProvider } from "../models/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { SessionState } from "../types/agent.js";
import type { ContentBlock, Message } from "../types/messages.js";
import type { StreamEvent } from "../types/stream.js";
import { ContextBuilder } from "./context-builder.js";
import { Executor } from "./executor.js";

const MAX_ITERATIONS = 50;
const COMPACTION_SUMMARY_HEADER = "Previous conversation summary:";
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  thresholdTokens: 120_000,
  preserveRecentMessages: 8,
  summaryMaxCharacters: 6_000,
};

export interface ContextBudgetOptions {
  thresholdTokens: number;
  preserveRecentMessages: number;
  summaryMaxCharacters?: number;
}

export class AgentLoop {
  constructor(
    private provider: ModelProvider,
    private executor: Executor,
    private contextBuilder: ContextBuilder,
    private registry: ToolRegistry,
    private eventStore: EventStore,
    private sessionStore: SessionStore,
    private streamJson = false,
    private contextBudget: ContextBudgetOptions = DEFAULT_CONTEXT_BUDGET
  ) {}

  async run(session: SessionState, userMessage: string): Promise<void> {
    try {
      // Append user message
      session.messages.push({ role: "user", content: userMessage });
      if (!session.title) {
        session.title = this.generateTitle(userMessage);
      }
      await this.eventStore.append(session.id, "user_message", {
        text: userMessage,
      });
      await this.saveSession(session);

      const systemPrompt = this.contextBuilder.buildSystemPrompt();
      const tools = this.registry.toSchemas();
      let finalStopReason = "max_iterations";
      let status: "completed" | "max_iterations" = "max_iterations";

      this.emit({
        type: "run.started",
        sessionId: session.id,
        model: session.model,
        workingDirectory: session.workingDirectory,
        timestamp: new Date().toISOString(),
      });

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        await this.compactSessionIfNeeded(session);
        const messages = await this.contextBuilder.buildMessagesWithDynamicContext(
          session.messages
        );
        const response = await this.provider.chat({
          systemPrompt,
          messages,
          tools,
        });

        if (response.reasoning) {
          await this.eventStore.append(session.id, "assistant_reasoning", {
            text: response.reasoning,
          });
        }

        await this.eventStore.append(session.id, "assistant_response", {
          stopReason: response.stopReason,
          content: response.content,
          reasoning: response.reasoning,
          usage: response.usage,
        });
        this.updateContextBudget(session, response.usage);

        const assistantMessage: Message = {
          role: "assistant",
          content: response.content,
        };

        if (response.reasoning) {
          this.emit({ type: "assistant.reasoning", text: response.reasoning });
        }

        // Print any text blocks
        for (const block of response.content) {
          if (block.type === "text") {
            this.emit({ type: "assistant.text", text: block.text });
          }
        }

        // If no tool use, we're done
        finalStopReason = response.stopReason;
        if (response.stopReason !== "tool_use") {
          session.messages.push(assistantMessage);
          await this.saveSession(session);
          status = "completed";
          break;
        }

        // Execute tool calls
        const toolUseBlocks = response.content.filter(
          (b) => b.type === "tool_use"
        ) as Array<{
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
        }>;

        const resultBlocks: ContentBlock[] = [];

        for (let toolIndex = 0; toolIndex < toolUseBlocks.length; toolIndex++) {
          const toolUse = toolUseBlocks[toolIndex];
          this.emit({
            type: "tool.call",
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          });

          let result;
          try {
            result = await this.executor.executeTool(session.id, {
              id: toolUse.id,
              name: toolUse.name,
              input: toolUse.input,
            });
          } catch (err) {
            resultBlocks.push(
              this.createErrorToolResult(
                toolUse,
                `Tool "${toolUse.name}" failed before returning a result: ${
                  err instanceof Error ? err.message : String(err)
                }`
              )
            );

            for (const skippedToolUse of toolUseBlocks.slice(toolIndex + 1)) {
              resultBlocks.push(
                this.createErrorToolResult(
                  skippedToolUse,
                  `Tool "${skippedToolUse.name}" was not executed because a previous tool failed.`
                )
              );
            }

            session.messages.push(assistantMessage);
            session.messages.push({ role: "user", content: resultBlocks });
            await this.saveSession(session);
            throw err;
          }

          this.emit({
            type: "tool.result",
            id: toolUse.id,
            name: toolUse.name,
            content: result.content,
            isError: Boolean(result.isError),
            metadata: result.metadata,
          });

          resultBlocks.push({
            type: "tool_result",
            toolUseId: toolUse.id,
            content: result.content,
            isError: result.isError,
            metadata: result.metadata,
          });
        }

        // Append tool results as user message
        session.messages.push(assistantMessage);
        session.messages.push({ role: "user", content: resultBlocks });
        await this.saveSession(session);
      }

      await this.saveSession(session);
      this.emit({
        type: "run.completed",
        sessionId: session.id,
        status,
        stopReason: finalStopReason as "end_turn" | "tool_use" | "max_tokens" | "error",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      try {
        await this.saveSession(session);
      } catch {
        // Preserve the original run failure.
      }
      try {
        await this.eventStore.append(session.id, "error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Preserve the original run failure.
      }
      throw err;
    }
  }

  private generateTitle(message: string): string {
    const firstLine = message.split('\n')[0].trim();
    if (!firstLine) return 'Chat session';
    if (firstLine.length <= 72) return firstLine;
    return firstLine.slice(0, 69) + '...';
  }

  private async saveSession(session: SessionState): Promise<void> {
    session.lastActiveAt = new Date().toISOString();
    await this.sessionStore.save(session);
  }

  private async compactSessionIfNeeded(session: SessionState): Promise<void> {
    const beforeTokens = this.estimateMessagesTokens(session.messages);
    this.updateContextBudget(session);

    if (beforeTokens <= this.contextBudget.thresholdTokens) return;

    const existingSummary = this.extractCompactionSummary(session.messages[0]);
    const compactableMessages = existingSummary
      ? session.messages.slice(1)
      : session.messages;
    const preserveCount = Math.max(1, this.contextBudget.preserveRecentMessages);

    if (compactableMessages.length <= preserveCount) return;

    const splitIndex = compactableMessages.length - preserveCount;
    const olderMessages = compactableMessages.slice(0, splitIndex);
    const recentMessages = compactableMessages.slice(splitIndex);
    const summary = this.buildCompactionSummary(existingSummary, olderMessages);

    session.messages = [
      {
        role: "user",
        content: [{ type: "text", text: summary }],
      },
      ...recentMessages,
    ];

    const afterTokens = this.estimateMessagesTokens(session.messages);
    const compactedAt = new Date().toISOString();
    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: afterTokens,
      thresholdTokens: this.contextBudget.thresholdTokens,
      preservedRecentMessages: recentMessages.length,
      compactedAt,
    };

    await this.eventStore.append(session.id, "conversation_compaction", {
      beforeApproximateTokens: beforeTokens,
      afterApproximateTokens: afterTokens,
      beforeMessages: compactableMessages.length + (existingSummary ? 1 : 0),
      afterMessages: session.messages.length,
      summarizedMessages: olderMessages.length,
      preservedRecentMessages: recentMessages.length,
    });
    await this.saveSession(session);
  }

  private updateContextBudget(
    session: SessionState,
    usage?: { inputTokens: number; outputTokens: number }
  ): void {
    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: this.estimateMessagesTokens(session.messages),
      thresholdTokens: this.contextBudget.thresholdTokens,
      preservedRecentMessages: this.contextBudget.preserveRecentMessages,
      lastProviderUsage: usage ?? session.contextBudget?.lastProviderUsage,
    };
  }

  private estimateMessagesTokens(messages: Message[]): number {
    const characters = messages.reduce(
      (total, message) => total + this.messageToText(message).length,
      0
    );
    return Math.ceil(characters / 4);
  }

  private buildCompactionSummary(
    existingSummary: string | undefined,
    messages: Message[]
  ): string {
    const lines = [
      existingSummary ?? COMPACTION_SUMMARY_HEADER,
      ...messages.map((message) => `- ${message.role}: ${this.messageToText(message)}`),
    ].filter((line): line is string => Boolean(line));

    const summary = lines.join("\n");
    const maxCharacters = this.contextBudget.summaryMaxCharacters;
    if (!maxCharacters || summary.length <= maxCharacters) return summary;

    const contentLimit = Math.max(0, maxCharacters - 15);
    return `${summary.slice(0, contentLimit).trimEnd()}\n[truncated]`;
  }

  private extractCompactionSummary(message: Message | undefined): string | undefined {
    if (!message || message.role !== "user") return undefined;
    const text = this.messageToText(message);
    if (!text.startsWith(COMPACTION_SUMMARY_HEADER)) return undefined;
    return text;
  }

  private messageToText(message: Message): string {
    if (typeof message.content === "string") return message.content;

    return message.content
      .map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "tool_use":
            return `tool_use ${block.id} ${block.name} ${JSON.stringify(block.input)}`;
          case "tool_result":
            return `tool_result ${block.toolUseId} ${
              block.isError ? "error" : "ok"
            } ${block.content} ${JSON.stringify(block.metadata ?? {})}`;
        }
      })
      .join("\n");
  }

  private createErrorToolResult(
    toolUse: { id: string; name: string },
    content: string
  ): ContentBlock {
    return {
      type: "tool_result",
      toolUseId: toolUse.id,
      content,
      isError: true,
    };
  }

  private emit(event: StreamEvent): void {
    if (this.streamJson) {
      console.log(JSON.stringify(event));
      return;
    }

    switch (event.type) {
      case "run.started":
      case "run.completed":
      case "run.failed":
        return;
      case "assistant.text":
        console.log(chalk.cyan(event.text));
        return;
      case "assistant.reasoning":
        console.log(chalk.magenta(event.text));
        return;
      case "tool.call":
        console.log(chalk.yellow(`→ ${event.name}(${JSON.stringify(event.input)})`));
        return;
      case "tool.result": {
        const preview = event.content.slice(0, 500);
        console.log(
          event.isError ? chalk.red(`  ✗ ${preview}`) : chalk.gray(`  ${preview}`)
        );
        return;
      }
    }
  }
}
