import fs from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types/tools.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. Supports optional 1-based inclusive line ranges and max_chars bounds.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      start_line: {
        type: "integer",
        minimum: 1,
        description: "Optional 1-based first line to read",
      },
      end_line: {
        type: "integer",
        minimum: 1,
        description: "Optional 1-based last line to read, inclusive",
      },
      max_chars: {
        type: "integer",
        minimum: 1,
        description: "Optional maximum number of characters to return",
      },
    },
    required: ["path"],
  },
  async execute(input): Promise<ToolResult> {
    const filePath = input.path as string;
    try {
      const fullContent = await fs.readFile(filePath, "utf-8");
      const lineCount = countLines(fullContent);
      const startLine = readPositiveInteger(input.start_line);
      const endLine = readPositiveInteger(input.end_line);
      const maxChars = readPositiveInteger(input.max_chars);

      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        return {
          content: "Error reading file: end_line must be greater than or equal to start_line.",
          isError: true,
          metadata: {
            path: filePath,
            requestedStartLine: startLine,
            requestedEndLine: endLine,
          },
        };
      }

      const ranged = applyLineRange(fullContent, startLine, endLine);
      const truncated = maxChars !== undefined && ranged.content.length > maxChars;
      const content = truncated
        ? `${ranged.content.slice(0, maxChars)}\n[truncated: output exceeded ${maxChars} characters]`
        : ranged.content;

      return {
        content,
        metadata: {
          path: filePath,
          bytes: Buffer.byteLength(fullContent, "utf-8"),
          lineCount,
          returnedBytes: Buffer.byteLength(content, "utf-8"),
          returnedLineStart: ranged.returnedLineStart,
          returnedLineEnd: ranged.returnedLineEnd,
          truncated,
          maxChars: maxChars ?? null,
        },
      };
    } catch (err) {
      return {
        content: `Error reading file: ${(err as Error).message}`,
        isError: true,
        metadata: {
          path: filePath,
        },
      };
    }
  },
};

function applyLineRange(
  content: string,
  startLine?: number,
  endLine?: number
): { content: string; returnedLineStart: number | null; returnedLineEnd: number | null } {
  if (startLine === undefined && endLine === undefined) {
    return {
      content,
      returnedLineStart: content.length > 0 ? 1 : null,
      returnedLineEnd: content.length > 0 ? countLines(content) : null,
    };
  }

  const lines = content.split("\n");
  const startIndex = (startLine ?? 1) - 1;
  const endIndex = endLine ?? lines.length;
  const selectedLines = lines.slice(startIndex, endIndex);

  return {
    content: selectedLines.join("\n"),
    returnedLineStart: selectedLines.length > 0 ? startIndex + 1 : null,
    returnedLineEnd: selectedLines.length > 0 ? startIndex + selectedLines.length : null,
  };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return undefined;
  }
  return value;
}
