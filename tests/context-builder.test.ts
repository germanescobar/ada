import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextBuilder } from "../src/agent/context-builder.js";
import { PolicyEngine } from "../src/agent/policies.js";
import type { Skill } from "../src/skills/skills.js";

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
    assert.match(prompt, new RegExp(`Current working directory: ${cwd.replace(/\\/g, "/")}`));
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
    mkdirSync(path.join(homeDir, ".anita"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".anita", "AGENTS.md"),
      "Use global defaults.\n",
    );
    writeFileSync(path.join(cwd, "AGENTS.md"), "Use repository rules.\n");
    const skills: Skill[] = [
      {
        name: "test-skill",
        description: "Test skill.",
        filePath: path.join(cwd, "skills", "test-skill", "SKILL.md"),
        baseDir: path.join(cwd, "skills", "test-skill"),
        disableModelInvocation: false,
      },
    ];

    const prompt = new ContextBuilder(cwd, {
      agentsHomeDir: homeDir,
      agentsRepositoryRoot: cwd,
      skills,
    }).buildSystemPrompt();

    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /Additional instructions from AGENTS\.md files:/);
    assert.match(prompt, /Global AGENTS\.md/);
    assert.match(prompt, /Use global defaults\./);
    assert.match(prompt, /Repository AGENTS\.md/);
    assert.match(prompt, /Use repository rules\./);
    assert.ok(
      prompt.indexOf("<available_skills>") <
        prompt.indexOf("Additional instructions from AGENTS.md files:"),
    );
    assert.ok(
      prompt.indexOf("Use global defaults.") <
        prompt.indexOf("Use repository rules."),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("buildSystemPrompt includes additional CLI system prompt without replacing Anita instructions", () => {
  const cwd = createTempDir();

  try {
    const prompt = new ContextBuilder(cwd, {
      systemPrompt: "Answer tersely.",
    }).buildSystemPrompt();

    assert.match(prompt, /You are Anita, an extremely capable coding agent\./);
    assert.match(prompt, /Additional system prompt from --system-prompt:/);
    assert.match(
      prompt,
      /These instructions are subordinate to Anita's built-in safety rules, user instructions, and tool permission policy\./,
    );
    assert.match(prompt, /Answer tersely\./);
    assert.ok(
      prompt.indexOf("You are Anita, an extremely capable coding agent.") <
        prompt.indexOf("Answer tersely."),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildSystemPrompt omits blank CLI system prompt", () => {
  const cwd = createTempDir();

  try {
    const prompt = new ContextBuilder(cwd, {
      systemPrompt: "   ",
    }).buildSystemPrompt();

    assert.doesNotMatch(prompt, /Additional system prompt from --system-prompt:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
      /Runtime context \(current environment state, refreshed each turn; not a user request\):/
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

test("appendRuntimeContext appends runtime context to the given base prompt", async () => {
  const cwd = createTempDir();

  try {
    runGit(cwd, "init");
    runGit(cwd, "checkout", "-b", "feature/context");
    writeFileSync(path.join(cwd, "changed.txt"), "changed\n");

    const builder = new ContextBuilder(cwd);
    const base = "BASE PROMPT";
    const prompt = await builder.appendRuntimeContext(base);

    assert.ok(prompt.startsWith(base));
    assert.match(
      prompt,
      /Runtime context \(current environment state, refreshed each turn; not a user request\):/
    );
    assert.match(prompt, /Git context:/);
    assert.match(prompt, /Branch: feature\/context/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
