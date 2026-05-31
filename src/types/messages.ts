import type { ToolResultMetadata } from "./tools.js";

export type MessageRole = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
      metadata?: Record<string, ToolResultMetadata>;
    };

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}
