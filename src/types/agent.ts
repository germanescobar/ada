import type { Message, ContentBlock } from "./messages.js";

export type SessionStatus = "active" | "paused" | "completed" | "archived";

export interface SessionState {
  id: string;
  workingDirectory: string;
  model: string; // e.g., "anthropic/claude-sonnet-4-6"
  messages: Message[];
  createdAt: string;
  lastActiveAt: string;
  status: SessionStatus;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";

export interface ModelResponse {
  stopReason: StopReason;
  content: ContentBlock[];
  reasoning?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
