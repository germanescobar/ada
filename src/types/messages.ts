import type { ToolResultMetadata } from "./tools.js";

export type MessageRole = "user" | "assistant";

export type AttachmentSource =
  | { type: "url"; url: string }
  | { type: "data"; mediaType: string; data: string };

export type AttachmentContentBlock =
  | {
      type: "image";
      name?: string;
      source: AttachmentSource;
    }
  | {
      type: "file";
      name: string;
      mediaType: string;
      source: AttachmentSource;
    };

export type ContentBlock =
  | { type: "text"; text: string }
  | AttachmentContentBlock
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
