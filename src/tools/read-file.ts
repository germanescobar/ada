import fs from "node:fs/promises";
import type { ToolDefinition } from "../types/tools.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file at the given path. Returns the file content as a string.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
    },
    required: ["path"],
  },
  async execute(input) {
    const filePath = input.path as string;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return { content };
    } catch (err) {
      return {
        content: `Error reading file: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
