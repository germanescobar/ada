import chalk from "chalk";
import type { ModelProvider, ModelStreamEvent } from "../models/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { SessionStore } from "../storage/session-store.js";
import type { SessionState } from "../types/agent.js";
import type { ModelResponse } from "../types/agent.js";
import {
  contentBlocksToConversationItems,
  conversationItemToText,
  conversationItemsToMessages,
  messagesToConversationItems,
  type ConversationItem,
} from "../types/conversation.js";
import type { ContentBlock } from "../types/messages.js";
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
  private pendingTerminalDelta = false;

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
      this.normalizeSession(session);
      session.conversationItems.push({
        type: "message",
        role: "user",
        content: userMessage,
      });
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
        const conversationItems = await this.contextBuilder.buildItemsWithDynamicContext(
          session.conversationItems
        );
        const response = await this.getModelResponse({
          systemPrompt,
          conversationItems,
          messages: conversationItemsToMessages(conversationItems),
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

        const assistantItems = contentBlocksToConversationItems(
          response.content,
          response.reasoning,
          response.reasoningItems
        );

        if (response.reasoning && !response.streamed) {
          this.emit({ type: "assistant.reasoning", text: response.reasoning });
        }

        // Print any text blocks
        if (!response.streamed) {
          for (const block of response.content) {
            if (block.type === "text") {
              this.emit({ type: "assistant.text", text: block.text });
            }
          }
        }

        // If no tool use, we're done
        finalStopReason = response.stopReason;
        if (response.stopReason !== "tool_use") {
          session.conversationItems.push(...assistantItems);
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

            session.conversationItems.push(...assistantItems);
            session.conversationItems.push(
              ...contentBlocksToConversationItems(resultBlocks)
            );
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
        session.conversationItems.push(...assistantItems);
        session.conversationItems.push(
          ...contentBlocksToConversationItems(resultBlocks)
        );
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
    this.normalizeSession(session);
    session.lastActiveAt = new Date().toISOString();
    await this.sessionStore.save(session);
  }

  private async compactSessionIfNeeded(session: SessionState): Promise<void> {
    this.normalizeSession(session);
    const beforeTokens = this.estimateConversationTokens(session.conversationItems);
    this.updateContextBudget(session);

    if (beforeTokens <= this.contextBudget.thresholdTokens) return;

    const existingSummary = this.extractCompactionSummary(session.conversationItems[0]);
    const compactableMessages = existingSummary
      ? session.conversationItems.slice(1)
      : session.conversationItems;
    const preserveCount = Math.max(1, this.contextBudget.preserveRecentMessages);

    if (compactableMessages.length <= preserveCount) return;

    const splitIndex = this.findSafeCompactionSplitIndex(
      compactableMessages,
      compactableMessages.length - preserveCount
    );
    if (splitIndex <= 0) return;

    const olderItems = compactableMessages.slice(0, splitIndex);
    const recentItems = compactableMessages.slice(splitIndex);
    const summary = this.buildCompactionSummary(existingSummary, olderItems);

    session.conversationItems = [
      {
        type: "compaction_summary",
        summary,
      },
      ...recentItems,
    ];

    const afterTokens = this.estimateConversationTokens(session.conversationItems);
    const compactedAt = new Date().toISOString();
    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: afterTokens,
      thresholdTokens: this.contextBudget.thresholdTokens,
      preservedRecentMessages: recentItems.length,
      compactedAt,
    };

    await this.eventStore.append(session.id, "conversation_compaction", {
      beforeApproximateTokens: beforeTokens,
      afterApproximateTokens: afterTokens,
      beforeMessages: compactableMessages.length + (existingSummary ? 1 : 0),
      afterMessages: session.conversationItems.length,
      summarizedMessages: olderItems.length,
      preservedRecentMessages: recentItems.length,
    });
    await this.saveSession(session);
  }

  private updateContextBudget(
    session: SessionState,
    usage?: { inputTokens: number; outputTokens: number }
  ): void {
    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: this.estimateConversationTokens(session.conversationItems),
      thresholdTokens: this.contextBudget.thresholdTokens,
      preservedRecentMessages: this.contextBudget.preserveRecentMessages,
      lastProviderUsage: usage ?? session.contextBudget?.lastProviderUsage,
    };
  }

  private estimateConversationTokens(items: ConversationItem[]): number {
    const characters = items.reduce(
      (total, item) => total + conversationItemToText(item).length,
      0
    );
    return Math.ceil(characters / 4);
  }

  private buildCompactionSummary(
    existingSummary: string | undefined,
    items: ConversationItem[]
  ): string {
    const newSummary = items
      .map((item) => `- ${item.type}: ${conversationItemToText(item)}`)
      .join("\n");
    const lines = [
      existingSummary ?? COMPACTION_SUMMARY_HEADER,
      newSummary,
    ].filter((line): line is string => Boolean(line));

    const summary = lines.join("\n");
    const maxCharacters = this.contextBudget.summaryMaxCharacters;
    if (!maxCharacters || summary.length <= maxCharacters) return summary;

    return this.truncateCompactionSummary(existingSummary, newSummary, maxCharacters);
  }

  private findSafeCompactionSplitIndex(
    items: ConversationItem[],
    desiredSplitIndex: number
  ): number {
    let splitIndex = Math.max(0, Math.min(items.length, desiredSplitIndex));

    while (
      splitIndex > 0 &&
      this.startsInsideFunctionBatch(items, splitIndex)
    ) {
      splitIndex--;
    }

    return splitIndex;
  }

  private startsInsideFunctionBatch(
    items: ConversationItem[],
    splitIndex: number
  ): boolean {
    const item = items[splitIndex];
    if (!item || !this.isFunctionBatchItem(item)) return false;

    const previous = items[splitIndex - 1];
    return Boolean(previous && this.isFunctionBatchItem(previous));
  }

  private isFunctionBatchItem(item: ConversationItem): boolean {
    return (
      item.type === "reasoning" ||
      item.type === "function_call" ||
      item.type === "function_output"
    );
  }

  private truncateCompactionSummary(
    existingSummary: string | undefined,
    newSummary: string,
    maxCharacters: number
  ): string {
    const truncatedSuffix = "\n[truncated]";
    if (!existingSummary) {
      const summary = `${COMPACTION_SUMMARY_HEADER}\n${newSummary}`;
      const contentLimit = Math.max(0, maxCharacters - truncatedSuffix.length);
      return `${summary.slice(0, contentLimit).trimEnd()}${truncatedSuffix}`;
    }

    const marker = "[earlier summary truncated]";
    const prefix = `${COMPACTION_SUMMARY_HEADER}\n${marker}\n`;
    const existingBody = existingSummary.replace(COMPACTION_SUMMARY_HEADER, "").trim();

    if (prefix.length + newSummary.length <= maxCharacters) {
      const existingLimit = Math.max(
        0,
        maxCharacters - prefix.length - newSummary.length - 1
      );
      const existingTail = existingBody.slice(-existingLimit).trim();
      return [prefix.trimEnd(), existingTail, newSummary]
        .filter(Boolean)
        .join("\n");
    }

    const contentLimit = Math.max(
      0,
      maxCharacters - prefix.length - truncatedSuffix.length
    );
    return `${prefix}${newSummary.slice(0, contentLimit).trimEnd()}${truncatedSuffix}`;
  }

  private extractCompactionSummary(item: ConversationItem | undefined): string | undefined {
    if (!item) return undefined;
    const text =
      item.type === "compaction_summary"
        ? item.summary
        : item.type === "message" && item.role === "user"
          ? item.content
          : undefined;
    if (!text) return undefined;
    if (!text.startsWith(COMPACTION_SUMMARY_HEADER)) return undefined;
    return text;
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

  private normalizeSession(session: SessionState): void {
    session.conversationItems ??= [];
    if (session.conversationItems.length === 0 && session.messages.length > 0) {
      session.conversationItems = messagesToConversationItems(session.messages);
    }
    session.messages = conversationItemsToMessages(session.conversationItems);
  }

  private async getModelResponse(
    params: Parameters<ModelProvider["chat"]>[0]
  ): Promise<ModelResponse & { streamed?: boolean }> {
    if (!this.provider.streamChat) {
      return this.provider.chat(params);
    }

    let response: ModelResponse | undefined;
    for await (const event of this.provider.streamChat(params)) {
      if (event.type === "response") {
        response = event.response;
        continue;
      }
      this.emitModelStreamEvent(event);
    }

    if (!response) {
      throw new Error("Streaming model provider completed without a final response.");
    }

    return { ...response, streamed: true };
  }

  private emitModelStreamEvent(event: ModelStreamEvent): void {
    switch (event.type) {
      case "assistant_text_delta":
        this.emit({ type: "assistant.text.delta", text: event.text });
        return;
      case "assistant_reasoning_delta":
        this.emit({ type: "assistant.reasoning.delta", text: event.text });
        return;
      case "tool_call_delta":
        this.emit({
          type: "tool.call.delta",
          index: event.index,
          id: event.id,
          name: event.name,
          inputDelta: event.inputDelta,
        });
        return;
      case "response":
        return;
    }
  }

  private emit(event: StreamEvent): void {
    if (this.streamJson) {
      console.log(JSON.stringify(event));
      return;
    }

    switch (event.type) {
      case "run.started":
        return;
      case "run.completed":
      case "run.failed":
        this.finishPendingTerminalDelta();
        return;
      case "assistant.text.delta":
        process.stdout.write(chalk.cyan(event.text));
        this.pendingTerminalDelta = true;
        return;
      case "assistant.text":
        this.finishPendingTerminalDelta();
        console.log(chalk.cyan(event.text));
        return;
      case "assistant.reasoning.delta":
        process.stdout.write(chalk.magenta(event.text));
        this.pendingTerminalDelta = true;
        return;
      case "assistant.reasoning":
        this.finishPendingTerminalDelta();
        console.log(chalk.magenta(event.text));
        return;
      case "tool.call.delta":
        this.finishPendingTerminalDelta();
        if (event.name) {
          console.log(chalk.yellow(`→ ${event.name}(...)`));
        }
        return;
      case "tool.call":
        this.finishPendingTerminalDelta();
        console.log(chalk.yellow(`→ ${event.name}(${JSON.stringify(event.input)})`));
        return;
      case "tool.result": {
        this.finishPendingTerminalDelta();
        const preview = event.content.slice(0, 500);
        console.log(
          event.isError ? chalk.red(`  ✗ ${preview}`) : chalk.gray(`  ${preview}`)
        );
        return;
      }
    }
  }

  private finishPendingTerminalDelta(): void {
    if (!this.pendingTerminalDelta) return;
    process.stdout.write("\n");
    this.pendingTerminalDelta = false;
  }
}
