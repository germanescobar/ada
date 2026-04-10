import { exec } from "node:child_process";

export class ContextBuilder {
  constructor(private workingDirectory: string) {}

  async buildSystemPrompt(): Promise<string> {
    const gitContext = await this.getGitContext();

    return `You are Ada, a coding agent working in: ${this.workingDirectory}

You have these tools available:
- read_file: Read file contents
- write_file: Create or overwrite a file
- edit_file: Replace a specific string in a file (read the file first)
- delete_file: Delete a file
- run_command: Run a shell command

${gitContext}

Instructions:
- Use tools to explore and understand the codebase before making changes
- Always read a file before editing it
- Run tests or checks after making changes when appropriate
- Explain what you are doing briefly`;
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
