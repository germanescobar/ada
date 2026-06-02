import type { ConversationItem, ConversationReasoningItem } from "./conversation.js";
import type { Message, ContentBlock } from "./messages.js";

export type SessionStatus = "active" | "paused" | "completed" | "archived";

export interface SessionState {
  id: string;
  title?: string;
  workingDirectory: string;
  model: string; // e.g., "anthropic/claude-sonnet-4-6"
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
  preservedRecentMessages: number;
  compactedAt?: string;
  lastProviderUsage?: ModelUsage;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export interface ModelResponse {
  stopReason: StopReason;
  content: ContentBlock[];
  reasoning?: string;
  reasoningItems?: ConversationReasoningItem[];
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}
