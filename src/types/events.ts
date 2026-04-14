export type EventType =
  | "session_start"
  | "user_message"
  | "assistant_reasoning"
  | "assistant_response"
  | "tool_call"
  | "tool_result"
  | "policy_decision"
  | "error"
  | "session_end"
  | "session_archived";

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string; // ISO 8601
  type: EventType;
  data: Record<string, unknown>;
}
