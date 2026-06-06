import chalk from "chalk";
import type { ModelProvider, ModelStreamEvent } from "../models/provider.js";
import { getModelContextWindowTokens } from "../models/resolve.js";
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
import type { AttachmentContentBlock, ContentBlock } from "../types/messages.js";
import type { StreamEvent } from "../types/stream.js";
import { ContextBuilder } from "./context-builder.js";
import { Executor } from "./executor.js";

const MAX_ITERATIONS = 50;
const COMPACTION_SUMMARY_HEADER = "Previous conversation summary:";
const COMPACTION_SUMMARIZER_SYSTEM_PROMPT = `You update a rolling summary for an AI coding agent conversation.

Preserve durable facts, user intent, decisions, constraints, files changed or inspected, tool results that matter, errors, and unresolved next steps.
Remove repetition, incidental chatter, and details that no longer affect future work.
Return only the updated summary text.`;
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  compactAtRatio: 0.8,
  reservedResponseTokens: 16_000,
  keepRecentTokens: 24_000,
  minSummarizableTokens: 8_000,
  targetSummaryTokens: 3_000,
};

export interface ContextBudgetOptions {
  compactAtRatio: number;
  reservedResponseTokens: number;
  keepRecentTokens: number;
  minSummarizableTokens: number;
  targetSummaryTokens: number;
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

  async run(
    session: SessionState,
    userMessage: string,
    attachments: AttachmentContentBlock[] = []
  ): Promise<void> {
    try {
      this.normalizeSession(session);
      session.conversationItems.push({
        type: "message",
        role: "user",
        content: userMessage,
        contentFormat: attachments.length > 0 ? "block" : undefined,
      });
      session.conversationItems.push(
        ...attachments.map((attachment): ConversationItem => ({
          type: "attachment",
          role: "user",
          attachment,
        }))
      );
      if (!session.title) {
        session.title = this.generateTitle(userMessage);
      }
      await this.eventStore.append(session.id, "user_message", {
        text: userMessage,
        attachments: attachments.map((attachment) => ({
          type: attachment.type,
          name: attachment.name,
          mediaType:
            attachment.type === "file"
              ? attachment.mediaType
              : attachment.source.type === "data"
                ? attachment.source.mediaType
                : undefined,
          sourceType: attachment.source.type,
        })),
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
        const modelContextItems = await this.buildModelContextItems(session);
        const conversationItems = await this.contextBuilder.buildItemsWithDynamicContext(
          modelContextItems
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

  private async buildModelContextItems(
    session: SessionState
  ): Promise<ConversationItem[]> {
    this.normalizeSession(session);
    const thresholdTokens = this.getCompactionThresholdTokens(session.model);
    this.updateContextBudget(session);

    const existingSummary = session.contextBudget?.compactionSummary;
    const summarizedItemCount = Math.min(
      session.contextBudget?.summarizedItemCount ?? 0,
      session.conversationItems.length
    );
    const currentModelItems = this.buildCompactedItems(
      existingSummary,
      session.conversationItems.slice(summarizedItemCount)
    );
    const beforeTokens = this.estimateConversationTokens(currentModelItems);

    if (beforeTokens <= thresholdTokens) return currentModelItems;

    const desiredSplitIndex = this.findRecentTailSplitIndex(
      session.conversationItems,
      this.contextBudget.keepRecentTokens
    );
    const splitIndex = this.findSafeCompactionSplitIndex(
      session.conversationItems,
      desiredSplitIndex
    );
    const nextItemsToSummarize = session.conversationItems.slice(
      summarizedItemCount,
      splitIndex
    );
    const summarizableTokens = this.estimateConversationTokens(nextItemsToSummarize);

    if (
      splitIndex <= summarizedItemCount ||
      summarizableTokens < this.contextBudget.minSummarizableTokens
    ) {
      await this.appendCompactionSkipEvent(
        session,
        beforeTokens,
        currentModelItems,
        "eligible_prefix_too_small"
      );
      return currentModelItems;
    }

    const summary = await this.generateCompactionSummary(
      existingSummary,
      nextItemsToSummarize
    );
    const recentItems = session.conversationItems.slice(splitIndex);
    const compactedItems = this.buildCompactedItems(summary, recentItems);
    const afterTokens = this.estimateConversationTokens(compactedItems);

    if (afterTokens >= beforeTokens) {
      await this.appendCompactionSkipEvent(
        session,
        beforeTokens,
        currentModelItems,
        "no_meaningful_reduction"
      );
      return currentModelItems;
    }

    const summaryTokens = this.estimateConversationTokens([
      { type: "compaction_summary", summary },
    ]);
    const preservedRecentTokens = this.estimateConversationTokens(recentItems);
    const compactedAt = new Date().toISOString();

    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: this.estimateConversationTokens(session.conversationItems),
      thresholdTokens,
      compactAtRatio: this.contextBudget.compactAtRatio,
      reservedResponseTokens: this.contextBudget.reservedResponseTokens,
      keepRecentTokens: this.contextBudget.keepRecentTokens,
      minSummarizableTokens: this.contextBudget.minSummarizableTokens,
      targetSummaryTokens: this.contextBudget.targetSummaryTokens,
      preservedRecentTokens,
      summaryTokens,
      compactionSummary: summary,
      summarizedItemCount: splitIndex,
      compactedAt,
    };

    await this.eventStore.append(session.id, "conversation_compaction", {
      beforeApproximateTokens: beforeTokens,
      afterApproximateTokens: afterTokens,
      summarizedMessages: nextItemsToSummarize.length,
      preservedRecentTokens,
      summaryTokens,
    });
    await this.saveSession(session);
    return compactedItems;
  }

  private updateContextBudget(
    session: SessionState,
    usage?: { inputTokens: number; outputTokens: number }
  ): void {
    const thresholdTokens = this.getCompactionThresholdTokens(session.model);
    session.contextBudget = {
      ...session.contextBudget,
      approximateTokens: this.estimateConversationTokens(session.conversationItems),
      thresholdTokens,
      compactAtRatio: this.contextBudget.compactAtRatio,
      reservedResponseTokens: this.contextBudget.reservedResponseTokens,
      keepRecentTokens: this.contextBudget.keepRecentTokens,
      minSummarizableTokens: this.contextBudget.minSummarizableTokens,
      targetSummaryTokens: this.contextBudget.targetSummaryTokens,
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

  private async generateCompactionSummary(
    existingSummary: string | undefined,
    items: ConversationItem[]
  ): Promise<string> {
    const priorSummary = existingSummary
      ? `Existing rolling summary:\n${existingSummary}`
      : "Existing rolling summary: none";
    const transcript = items
      .map((item) => `- ${item.type}: ${conversationItemToText(item)}`)
      .join("\n");
    const response = await this.provider.chat({
      systemPrompt: `${COMPACTION_SUMMARIZER_SYSTEM_PROMPT}\n\nTarget about ${this.contextBudget.targetSummaryTokens} tokens.`,
      conversationItems: [
        {
          type: "message",
          role: "user",
          content: `${priorSummary}\n\nNew transcript segment to fold into the rolling summary:\n${transcript}`,
        },
      ],
      messages: [
        {
          role: "user",
          content: `${priorSummary}\n\nNew transcript segment to fold into the rolling summary:\n${transcript}`,
        },
      ],
      tools: [],
    });
    const summary = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");

    if (!summary) {
      throw new Error("Compaction summary model response did not include text.");
    }

    return summary.startsWith(COMPACTION_SUMMARY_HEADER)
      ? summary
      : `${COMPACTION_SUMMARY_HEADER}\n${summary}`;
  }

  private buildCompactedItems(
    summary: string | undefined,
    recentItems: ConversationItem[]
  ): ConversationItem[] {
    if (!summary) return recentItems;
    return [{ type: "compaction_summary", summary }, ...recentItems];
  }

  private findRecentTailSplitIndex(
    items: ConversationItem[],
    keepRecentTokens: number
  ): number {
    let recentTokens = 0;
    for (let index = items.length; index > 0; index--) {
      const itemTokens = this.estimateConversationTokens([items[index - 1]]);
      if (recentTokens > 0 && recentTokens + itemTokens > keepRecentTokens) {
        return index;
      }
      recentTokens += itemTokens;
    }
    return 0;
  }

  private getCompactionThresholdTokens(model: string): number {
    const contextWindowTokens = getModelContextWindowTokens(model);
    const usableTokens = Math.max(
      1,
      contextWindowTokens - this.contextBudget.reservedResponseTokens
    );
    return Math.floor(usableTokens * this.contextBudget.compactAtRatio);
  }

  private async appendCompactionSkipEvent(
    session: SessionState,
    beforeTokens: number,
    modelItems: ConversationItem[],
    skipReason: string
  ): Promise<void> {
    await this.eventStore.append(session.id, "conversation_compaction", {
      beforeApproximateTokens: beforeTokens,
      afterApproximateTokens: this.estimateConversationTokens(modelItems),
      summarizedMessages: 0,
      preservedRecentTokens: this.estimateConversationTokens(modelItems),
      summaryTokens: session.contextBudget?.summaryTokens ?? 0,
      skipReason,
    });
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
