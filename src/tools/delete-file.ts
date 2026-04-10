import fs from "node:fs/promises";
import type { ToolDefinition } from "../types/tools.js";

export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description:
    "Delete a file at the given path. Fails if the file does not exist.",
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
      await fs.unlink(filePath);
      return { content: `File deleted: ${filePath}` };
    } catch (err) {
      return {
        content: `Error deleting file: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
