import { exec } from "node:child_process";
import type { Message } from "../types/messages.js";

const STATIC_SYSTEM_PROMPT = `You are Ada, a coding agent.

You have these tools available:
- read_file: Read file contents
- write_file: Create or overwrite a file
- edit_file: Replace a specific string in a file (read the file first)
- delete_file: Delete a file
- run_command: Run a shell command

Instructions:
- Use tools to explore and understand the codebase before making changes
- Always read a file before editing it
- Run tests or checks after making changes when appropriate
- Explain what you are doing briefly`;

export class ContextBuilder {
  constructor(private workingDirectory: string) {}

  buildSystemPrompt(): string {
    return STATIC_SYSTEM_PROMPT;
  }

  async buildDynamicContext(): Promise<string> {
    const gitContext = await this.getGitContext();

    return [
      "Current environment context:",
      `Working directory: ${this.workingDirectory}`,
      gitContext,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async buildMessagesWithDynamicContext(messages: Message[]): Promise<Message[]> {
    const dynamicContext = await this.buildDynamicContext();
    if (!dynamicContext) return messages;

    return [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: dynamicContext }],
      },
    ];
  }

  private async getGitContext(): Promise<string> {
    const isGit = await this.runQuiet("git rev-parse --is-inside-work-tree");
    if (!isGit) return "";

    const [branch, status, diffStat] = await Promise.all([
      this.runQuiet("git branch --show-current"),
      this.runQuiet("git status --short"),
      this.runQuiet("git diff --stat"),
    ]);

    const parts = ["Git context:"];
    if (branch) parts.push(`Branch: ${branch}`);
    if (status) parts.push(`Status:\n${status}`);
    if (diffStat) parts.push(`Diff:\n${diffStat}`);
    return parts.join("\n");
  }

  private runQuiet(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      exec(cmd, { cwd: this.workingDirectory, timeout: 5000 }, (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      });
    });
  }
}
