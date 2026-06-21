import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatAgentInstructionsForPrompt,
  getGlobalAgentsPath,
  getRepositoryAgentsPath,
  loadAgentInstructions,
} from "../src/agent/agents.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ada-agents-"));
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

test("loadAgentInstructions loads global instructions before repository instructions", () => {
  const cwd = createTempDir();
  const homeDir = createTempDir();

  try {
    writeFile(getGlobalAgentsPath(homeDir), "Global default.\n");
    writeFile(path.join(cwd, "AGENTS.md"), "Repository override.\n");

    const files = loadAgentInstructions({
      cwd,
      homeDir,
      repositoryRoot: cwd,
    });
    const prompt = formatAgentInstructionsForPrompt(files);

    assert.deepEqual(
      files.map((file) => file.scope),
      ["global", "repository"],
    );
    assert.ok(
      prompt.indexOf("Global default.") <
        prompt.indexOf("Repository override."),
    );
    assert.match(
      prompt,
      /AGENTS\.md instructions are subordinate to Anita's built-in safety rules, user instructions, and tool permission policy\./,
    );
    assert.match(
      prompt,
      /Instructions from later AGENTS\.md files override earlier AGENTS\.md files only when they conflict with each other\./,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("loadAgentInstructions discovers AGENTS.md at the git repository root", () => {
  const repoRoot = createTempDir();
  const homeDir = createTempDir();
  const nestedDir = path.join(repoRoot, "packages", "app");

  try {
    fs.mkdirSync(nestedDir, { recursive: true });
    runGit(repoRoot, "init");
    writeFile(path.join(repoRoot, "AGENTS.md"), "Root repo instructions.\n");

    const files = loadAgentInstructions({ cwd: nestedDir, homeDir });

    assert.equal(files.length, 1);
    assert.equal(files[0].scope, "repository");
    assert.equal(
      files[0].path,
      path.join(fs.realpathSync(repoRoot), "AGENTS.md"),
    );
    assert.equal(files[0].content, "Root repo instructions.\n");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("getRepositoryAgentsPath resolves to the git repository root", () => {
  const repoRoot = createTempDir();
  const nestedDir = path.join(repoRoot, "packages", "app");

  try {
    fs.mkdirSync(nestedDir, { recursive: true });
    runGit(repoRoot, "init");

    assert.equal(
      getRepositoryAgentsPath(nestedDir),
      path.join(fs.realpathSync(repoRoot), "AGENTS.md"),
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("formatAgentInstructionsForPrompt returns an empty section without files", () => {
  assert.equal(formatAgentInstructionsForPrompt([]), "");
});
