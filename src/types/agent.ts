import type { ConversationItem, ConversationReasoningItem } from "./conversation.js";
import type { Message, ContentBlock } from "./messages.js";

export type SessionStatus = "active" | "paused" | "completed" | "archived";

/**
 * Per-attempt diagnostics for the rolling-summary compactor. Mirrors
 * `SummarizerAttemptDiagnostics` in `src/agent/loop.ts`; duplicated here so
 * `SessionContextBudget` can cache it without a circular type dependency.
 */
export interface SessionSummarizerAttemptDiagnostics {
  contentBlockCount: number;
  textBlockCount: number;
  stopReason: string;
  providerStopReason?: string;
}

export interface SessionSummarizerDiagnostics {
  firstAttempt: SessionSummarizerAttemptDiagnostics;
  retryAttempt?: SessionSummarizerAttemptDiagnostics;
}

export interface SessionState {
  id: string;
  title?: string;
  workingDirectory: string;
  model: string; // e.g., "ollama/glm-4.7-flash:latest"
  conversationItems: ConversationItem[];
  messages: Message[];
  contextBudget?: SessionContextBudget;
  createdAt: string;
  lastActiveAt: string;
  status: SessionStatus;
}

export interface SessionContextBudget {
  approximateTokens: number;
  thresholdTokens: number;
  compactAtRatio: number;
  reservedResponseTokens: number;
  keepRecentTokens: number;
  minSummarizableTokens: number;
  targetSummaryTokens: number;
  preservedRecentTokens?: number;
  summaryTokens?: number;
  compactionSummary?: string;
  summarizedItemCount?: number;
  compactedAt?: string;
  lastProviderUsage?: ModelUsage;
  /**
   * Set after a `summarizer_returned_empty` skip; the compactor suppresses
   * further summarizer calls while the current run's iteration index is
   * below this value. Cleared when compaction succeeds, when the run ends,
   * or when the session is reloaded for a fresh run.
   */
  summarizerCooldownUntilIteration?: number;
  /**
   * Cached diagnostics from the last empty summarizer attempt; surfaced on
   * subsequent cooldown skips so operators can see why compaction is being
   * suppressed without re-querying the provider.
   */
  summarizerCooldownDiagnostics?: SessionSummarizerDiagnostics;
  summarizerCooldownAttempts?: 1 | 2;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export interface ModelResponse {
  stopReason: StopReason;
  providerStopReason?: string;
  content: ContentBlock[];
  reasoning?: string;
  reasoningItems?: ConversationReasoningItem[];
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
}
