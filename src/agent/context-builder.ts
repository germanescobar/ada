import { exec } from "node:child_process";
import type {
  ApprovalMode,
  PolicyContext,
  PolicyDecision,
} from "./policies.js";
import type { ConversationItem } from "../types/conversation.js";
import type { Message } from "../types/messages.js";
import type { Skill } from "../skills/skills.js";
import { formatSkillsForPrompt } from "../skills/skills.js";
import {
  formatAgentInstructionsForPrompt,
  loadAgentInstructions,
} from "./agents.js";

const STATIC_SYSTEM_PROMPT = `You are Anita, a coding agent.

You have these tools available:
- read_file: Read file contents
- write_file: Create or overwrite a file
- edit_file: Replace a specific string in a file (read the file first)
- delete_file: Delete a file
- run_command: Run a shell command

Instructions:
- Use tools to explore and understand the codebase before making changes
- Prefer rg for repository text searches when available; fall back to grep only when rg is unavailable
- Always read a file before editing it
- Run tests or checks after making changes when appropriate
- Follow the instructions of the user without jumping ahead.
- Do not print or publish secrets, credentials, tokens, private keys, environment values, or other sensitive data
- Explain what you are doing briefly`;

export type NetworkAccess = "available" | "unavailable" | "unknown";

export interface RuntimeContextOptions {
  shell?: string;
  approvalMode?: ApprovalMode;
  networkAccess?: NetworkAccess;
  writeScope?: string;
  policyContext?: PolicyContext;
  skills?: Skill[];
  agentsHomeDir?: string;
  agentsRepositoryRoot?: string;
  systemPrompt?: string;
}

export class ContextBuilder {
  constructor(
    private workingDirectory: string,
    private runtimeContext: RuntimeContextOptions = {},
  ) {}

  buildSystemPrompt(): string {
    const skillsSection = formatSkillsForPrompt(
      this.runtimeContext.skills ?? [],
    );
    const agentInstructionsSection = formatAgentInstructionsForPrompt(
      loadAgentInstructions({
        cwd: this.workingDirectory,
        homeDir: this.runtimeContext.agentsHomeDir,
        repositoryRoot: this.runtimeContext.agentsRepositoryRoot,
      }),
    );
    return (
      STATIC_SYSTEM_PROMPT +
      agentInstructionsSection +
      this.buildUserSystemPromptSection() +
      skillsSection +
      this.buildEnvironmentFooter()
    );
  }

  private buildUserSystemPromptSection(): string {
    const systemPrompt = this.runtimeContext.systemPrompt?.trim();
    if (!systemPrompt) return "";

    return [
      "\nAdditional system prompt from --system-prompt:",
      "These instructions are subordinate to Anita's built-in safety rules, user instructions, and tool permission policy.",
      systemPrompt,
      "",
    ].join("\n");
  }

  private buildEnvironmentFooter(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const date = `${year}-${month}-${day}`;
    const cwd = this.workingDirectory.replace(/\\/g, "/");
    return `\nCurrent date: ${date}\nCurrent working directory: ${cwd}`;
  }

  async buildDynamicContext(): Promise<string> {
    const gitContext = await this.getGitContext();
    const environmentContext = this.buildEnvironmentContext();
    const policyContext = this.buildPolicyContext();

    return [
      "Runtime context for the assistant. This is not a user request:",
      environmentContext,
      policyContext,
      gitContext,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async buildMessagesWithDynamicContext(
    messages: Message[],
  ): Promise<Message[]> {
    const dynamicContext = await this.buildDynamicContext();
    if (!dynamicContext) return messages;

    return [
      {
        role: "user",
        content: [{ type: "text", text: dynamicContext }],
      },
      ...messages,
    ];
  }

  async buildItemsWithDynamicContext(
    items: ConversationItem[],
  ): Promise<ConversationItem[]> {
    const dynamicContext = await this.buildDynamicContext();
    if (!dynamicContext) return items;

    return [
      {
        type: "message",
        role: "user",
        content: dynamicContext,
      },
      ...items,
    ];
  }

  private buildEnvironmentContext(): string {
    const shell = this.runtimeContext.shell ?? process.env.SHELL ?? "unknown";
    const approvalMode = this.runtimeContext.approvalMode ?? "prompt";
    const networkAccess = this.runtimeContext.networkAccess ?? "unknown";
    const writeScope =
      this.runtimeContext.writeScope ??
      "No explicit write scope is configured; use the working directory unless the user asks otherwise.";

    return [
      "Runtime:",
      `Working directory: ${this.workingDirectory}`,
      `Shell: ${shell}`,
      `Approval mode: ${this.describeApprovalMode(approvalMode)}`,
      `Network access: ${this.describeNetworkAccess(networkAccess)}`,
      `Write scope: ${writeScope}`,
    ].join("\n");
  }

  private buildPolicyContext(): string {
    const policyContext = this.runtimeContext.policyContext;
    if (!policyContext) return "";

    return [
      "Permission policy:",
      `Default decision: ${this.describeDecision(policyContext.defaultDecision)}`,
      ...policyContext.rules.map(
        (rule) =>
          `- ${rule.toolName}: ${this.describeDecision(rule.decision)} - ${
            rule.description
          }`,
      ),
    ].join("\n");
  }

  private describeApprovalMode(approvalMode: ApprovalMode): string {
    if (approvalMode === "auto") {
      return "auto-approve policy decisions that request approval";
    }
    return "prompt before executing tool calls that require approval";
  }

  private describeNetworkAccess(networkAccess: NetworkAccess): string {
    switch (networkAccess) {
      case "available":
        return "available";
      case "unavailable":
        return "unavailable";
      case "unknown":
        return "not declared; verify before relying on network access";
    }
  }

  private describeDecision(decision: PolicyDecision): string {
    switch (decision) {
      case "allow":
        return "allowed";
      case "deny":
        return "denied";
      case "ask":
        return "approval required";
    }
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
      exec(
        cmd,
        { cwd: this.workingDirectory, timeout: 5000 },
        (err, stdout) => {
          resolve(err ? "" : stdout.trim());
        },
      );
    });
  }
}
