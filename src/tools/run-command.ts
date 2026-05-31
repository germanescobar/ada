import { exec } from "node:child_process";
import process from "node:process";
import type { ToolDefinition } from "../types/tools.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT_CHARS = 10_000;

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

        const rawContent = parts.join("\n") || "(no output)";
        let content = rawContent;
        const truncated = content.length > MAX_OUTPUT_CHARS;
        if (content.length > MAX_OUTPUT_CHARS) {
          content = content.slice(0, MAX_OUTPUT_CHARS) + `\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} characters]`;
        }

        resolve({
          content,
          isError: !!error,
          metadata: {
            command,
            cwd: process.cwd(),
            exitCode: typeof error?.code === "number" ? error.code : 0,
            signal: error?.signal ?? null,
            timedOut: Boolean(error?.killed),
            truncated,
            bytes: Buffer.byteLength(rawContent, "utf-8"),
            lineCount: countLines(rawContent),
            stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
            stderrBytes: Buffer.byteLength(stderr, "utf-8"),
            timeoutMs: DEFAULT_TIMEOUT,
            maxOutputChars: MAX_OUTPUT_CHARS,
          },
        });
      });
    });
  },
};

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}
