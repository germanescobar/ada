export type EventType =
  | "session_start"
  | "user_message"
  | "assistant_reasoning"
  | "assistant_response"
  | "conversation_compaction"
  | "tool_call"
  | "tool_result"
  | "policy_decision"
  | "error"
  | "run_cancelled"
  | "session_end"
  | "session_archived"
  | "skills_loaded";

export interface AgentEvent {
  id: string;
  sessionId: string;
  timestamp: string; // ISO 8601
  type: EventType;
  data: Record<string, unknown>;
}
