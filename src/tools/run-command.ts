import { exec } from "node:child_process";
import type { ToolDefinition } from "../types/tools.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export const runCommandTool: ToolDefinition = {
  name: "run_command",
  description:
    "Run a shell command and return stdout/stderr. Has a 30 second timeout.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
    },
    required: ["command"],
  },
  async execute(input) {
    const command = input.command as string;

    return new Promise((resolve) => {
      exec(command, { timeout: DEFAULT_TIMEOUT }, (error, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (error && error.killed) {
          parts.push(`[timeout] Command timed out after ${DEFAULT_TIMEOUT}ms`);
        } else if (error) {
          parts.push(`[exit code: ${error.code}]`);
        }

        resolve({
          content: parts.join("\n") || "(no output)",
          isError: !!error,
        });
      });
    });
  },
};
