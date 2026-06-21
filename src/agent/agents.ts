import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentInstructionsScope = "global" | "repository";

export interface AgentInstructionsFile {
  scope: AgentInstructionsScope;
  path: string;
  content: string;
}

export interface LoadAgentInstructionsOptions {
  cwd: string;
  homeDir?: string;
  repositoryRoot?: string;
}

const AGENTS_FILE_NAME = "AGENTS.md";
const CONFIG_DIR_NAME = ".anita";
const LEGACY_CONFIG_DIR_NAME = ".ada";

/* Canonical location for the global AGENTS.md. Used when writing the file. */
export function getGlobalAgentsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, CONFIG_DIR_NAME, AGENTS_FILE_NAME);
}

/*
 * Resolve the global AGENTS.md for reading, preferring the canonical `.anita`
 * directory and falling back to the legacy `.ada` directory so existing
 * configurations keep working after the rename.
 */
function resolveReadableGlobalAgentsPath(homeDir: string): string {
  const primary = path.join(homeDir, CONFIG_DIR_NAME, AGENTS_FILE_NAME);
  if (fs.existsSync(primary)) return primary;

  const legacy = path.join(homeDir, LEGACY_CONFIG_DIR_NAME, AGENTS_FILE_NAME);
  if (fs.existsSync(legacy)) return legacy;

  return primary;
}

export function getProjectAgentsPath(cwd: string): string {
  return path.join(cwd, AGENTS_FILE_NAME);
}

export function getRepositoryAgentsPath(cwd: string): string {
  return getProjectAgentsPath(findRepositoryRoot(cwd) ?? cwd);
}

export function loadAgentInstructions(
  options: LoadAgentInstructionsOptions,
): AgentInstructionsFile[] {
  const repositoryRoot =
    options.repositoryRoot ?? findRepositoryRoot(options.cwd) ?? options.cwd;
  const candidates: Array<{ scope: AgentInstructionsScope; path: string }> = [
    {
      scope: "global",
      path: resolveReadableGlobalAgentsPath(options.homeDir ?? os.homedir()),
    },
    { scope: "repository", path: getProjectAgentsPath(repositoryRoot) },
  ];

  const loaded: AgentInstructionsFile[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidates) {
    const file = readInstructionsFile(candidate.scope, candidate.path);
    if (!file) continue;

    let realPath = file.path;
    try {
      realPath = fs.realpathSync(file.path);
    } catch {
      realPath = file.path;
    }

    if (seenPaths.has(realPath)) continue;
    seenPaths.add(realPath);
    loaded.push(file);
  }

  return loaded;
}

export function formatAgentInstructionsForPrompt(
  files: AgentInstructionsFile[],
): string {
  if (files.length === 0) return "";

  const lines = [
    "",
    "Additional instructions from AGENTS.md files:",
    "AGENTS.md instructions are subordinate to Anita's built-in safety rules, user instructions, and tool permission policy.",
    "Instructions from later AGENTS.md files override earlier AGENTS.md files only when they conflict with each other.",
  ];

  for (const file of files) {
    const label = file.scope === "global" ? "Global" : "Repository";
    lines.push("");
    lines.push(`${label} AGENTS.md (${file.path}):`);
    lines.push(file.content.trimEnd());
  }

  return lines.join("\n");
}

function findRepositoryRoot(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const root = output.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

function readInstructionsFile(
  scope: AgentInstructionsScope,
  filePath: string,
): AgentInstructionsFile | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      scope,
      path: filePath,
      content: fs.readFileSync(filePath, "utf-8"),
    };
  } catch (err) {
    if (isMissingPathError(err)) return null;

    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${filePath}: ${message}`);
  }
}

function isMissingPathError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}
