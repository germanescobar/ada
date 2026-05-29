import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextBuilder } from "../src/agent/context-builder.js";
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
  assert.doesNotMatch(first.buildSystemPrompt(), /\/tmp\/first/);
});

test("buildDynamicContext includes cwd and current git context", async () => {
  const cwd = createTempDir();

  try {
    runGit(cwd, "init");
    runGit(cwd, "checkout", "-b", "feature/context");
    writeFileSync(path.join(cwd, "changed.txt"), "changed\n");

    const context = await new ContextBuilder(cwd).buildDynamicContext();

    assert.match(context, /Current environment context:/);
    assert.match(context, new RegExp(`Working directory: ${cwd}`));
    assert.match(context, /Git context:/);
    assert.match(context, /Branch: feature\/context/);
    assert.match(context, /\?\? changed\.txt/);
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
    assert.deepEqual(result[0], messages[0]);
    assert.equal(result[1]?.role, "user");
    assert.match(JSON.stringify(result[1]?.content), /Current environment context/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
