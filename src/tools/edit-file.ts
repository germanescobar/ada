import fs from "node:fs/promises";
import type { ToolDefinition } from "../types/tools.js";

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string match. The old_text must appear exactly once in the file. Use read_file first to see the current content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path" },
      old_text: {
        type: "string",
        description: "The exact text to find and replace",
      },
      new_text: {
        type: "string",
        description: "The text to replace it with",
      },
    },
    required: ["path", "old_text", "new_text"],
  },
  async execute(input) {
    const filePath = input.path as string;
    const oldText = input.old_text as string;
    const newText = input.new_text as string;

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        return {
          content: `Error: old_text not found in ${filePath}. Use read_file to check the current content.`,
          isError: true,
        };
      }
      if (occurrences > 1) {
        return {
          content: `Error: old_text found ${occurrences} times in ${filePath}. Provide a more specific string.`,
          isError: true,
        };
      }

      const newContent = content.replace(oldText, newText);
      await fs.writeFile(filePath, newContent);
      return { content: `File edited: ${filePath}` };
    } catch (err) {
      return {
        content: `Error editing file: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
