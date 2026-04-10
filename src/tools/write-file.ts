import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types/tools.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file. Creates the file and any parent directories if they don't exist. Overwrites existing content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  async execute(input) {
    const filePath = input.path as string;
    const content = input.content as string;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
      return { content: `File written: ${filePath}` };
    } catch (err) {
      return {
        content: `Error writing file: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
