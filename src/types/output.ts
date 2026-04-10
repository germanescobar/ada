export type OutputMode = "default" | "human" | "json";

export interface ToolCallResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  content: string;
  isError: boolean;
}

export interface AgentRunResult {
  schemaVersion: "ada.v1";
  sessionId: string;
  model: string;
  workingDirectory: string;
  status: "completed" | "max_iterations";
  stopReason: string;
  finalText: string;
  textBlocks: string[];
  toolCalls: ToolCallResult[];
}
