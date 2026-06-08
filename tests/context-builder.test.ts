import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextBuilder } from "../src/agent/context-builder.js";
import { PolicyEngine } from "../src/agent/policies.js";
import type { Message } from "../src/types/messages.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ada-context-builder-"));
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("buildSystemPrompt includes cwd and current date and excludes other runtime context", () => {
  const cwd = createTempDir();

  try {
    runGit(cwd, "init");
    const prompt = new ContextBuilder(cwd).buildSystemPrompt();
    const now = new Date();
    const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    assert.match(prompt, new RegExp(`Current date: ${expectedDate}`));
    assert.match(prompt, new RegExp(`Current working directory: ${cwd.replace(/\\\\/g, "/")}`));
    assert.doesNotMatch(prompt, /Git context:/);
    assert.doesNotMatch(prompt, /Permission policy:/);
    assert.doesNotMatch(prompt, /Runtime:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildSystemPrompt includes global and repository AGENTS.md instructions", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    mkdirSync(path.join(homeDir, ".ada"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".ada", "AGENTS.md"),
      "Use global defaults.\n",
    );
    writeFileSync(path.join(cwd, "AGENTS.md"), "Use repository rules.\n");

    const prompt = new ContextBuilder(cwd, {
      agentsHomeDir: homeDir,
      agentsRepositoryRoot: cwd,
    }).buildSystemPrompt();

    assert.match(prompt, /Additional instructions from AGENTS\.md files:/);
    assert.match(prompt, /Global AGENTS\.md/);
    assert.match(prompt, /Use global defaults\./);
    assert.match(prompt, /Repository AGENTS\.md/);
    assert.match(prompt, /Use repository rules\./);
    assert.ok(
      prompt.indexOf("Use global defaults.") <
        prompt.indexOf("Use repository rules."),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("buildDynamicContext includes cwd and current git context", async () => {
  const cwd = createTempDir();

  try {
    runGit(cwd, "init");
    runGit(cwd, "checkout", "-b", "feature/context");
    writeFileSync(path.join(cwd, "changed.txt"), "changed\n");

    const context = await new ContextBuilder(cwd).buildDynamicContext();

    assert.match(
      context,
      /Runtime context for the assistant\. This is not a user request:/
    );
    assert.match(context, /Runtime:/);
    assert.match(context, new RegExp(`Working directory: ${cwd}`));
    assert.match(context, /Shell: /);
    assert.match(
      context,
      /Approval mode: prompt before executing tool calls that require approval/
    );
    assert.match(
      context,
      /Network access: not declared; verify before relying on network access/
    );
    assert.match(context, /Git context:/);
    assert.match(context, /Branch: feature\/context/);
    assert.match(context, /\?\? changed\.txt/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildDynamicContext includes explicit permission policy when provided", async () => {
  const cwd = createTempDir();

  try {
    const context = await new ContextBuilder(cwd, {
      approvalMode: "auto",
      networkAccess: "available",
      shell: "/bin/zsh",
      writeScope: "Only write under the repository root.",
      policyContext: PolicyEngine.withDefaults().describe(),
    }).buildDynamicContext();

    assert.match(
      context,
      /Approval mode: auto-approve policy decisions that request approval/
    );
    assert.match(context, /Network access: available/);
    assert.match(context, /Write scope: Only write under the repository root\./);
    assert.match(context, /Permission policy:/);
    assert.match(context, /Default decision: allowed/);
    assert.match(context, /read_file: allowed - File reads are allowed\./);
    assert.match(context, /run_command: denied - Commands matching dangerous patterns/);
    assert.match(context, /rg, grep fallback when rg is unavailable/);
    assert.match(
      context,
      /run_command: approval required - Other shell commands require approval/
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildMessagesWithDynamicContext does not mutate saved messages", async () => {
  const cwd = createTempDir();
  const messages: Message[] = [{ role: "user", content: "hello" }];

  try {
    const result = await new ContextBuilder(cwd).buildMessagesWithDynamicContext(
      messages
    );

    assert.equal(messages.length, 1);
    assert.equal(result.length, 2);
    assert.notEqual(result, messages);
    assert.equal(result[0]?.role, "user");
    assert.match(
      JSON.stringify(result[0]?.content),
      /Runtime context for the assistant/
    );
    assert.deepEqual(result[1], messages[0]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
