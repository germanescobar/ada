import type { StopReason } from "./agent.js";
import type { ToolResultMetadata } from "./tools.js";

export type StreamEvent =
  | {
      type: "run.started";
      sessionId: string;
      model: string;
      workingDirectory: string;
      timestamp: string;
    }
  | {
      type: "assistant.reasoning";
      text: string;
    }
  | {
      type: "assistant.text";
      text: string;
    }
  | {
      type: "tool.call";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool.result";
      id: string;
      name: string;
      content: string;
      isError: boolean;
      metadata?: Record<string, ToolResultMetadata>;
    }
  | {
      type: "run.completed";
      sessionId: string;
      status: "completed" | "max_iterations";
      stopReason: StopReason;
      timestamp: string;
    }
  | {
      type: "run.failed";
      sessionId: string;
      error: string;
      timestamp: string;
    };
