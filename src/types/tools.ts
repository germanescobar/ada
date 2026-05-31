export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export type ToolResultMetadata =
  | string
  | number
  | boolean
  | null
  | ToolResultMetadata[]
  | { [key: string]: ToolResultMetadata };

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, ToolResultMetadata>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}
