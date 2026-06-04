import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("buildSystemPrompt is stable and excludes environment context", () => {
  const first = new ContextBuilder("/tmp/first");
  const second = new ContextBuilder("/tmp/second");

  assert.equal(first.buildSystemPrompt(), second.buildSystemPrompt());
  assert.doesNotMatch(first.buildSystemPrompt(), /Working directory:/);
  assert.doesNotMatch(first.buildSystemPrompt(), /Git context:/);
  assert.doesNotMatch(first.buildSystemPrompt(), /Permission policy:/);
  assert.doesNotMatch(first.buildSystemPrompt(), /\/tmp\/first/);
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
