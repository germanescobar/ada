import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  "allowed-tools"?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path: string;
  collision?: { name: string; winnerPath: string; loserPath: string };
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface LoadSkillsOptions {
  /** Working directory for project-local skills. Default: process.cwd() */
  cwd?: string;
  /** Explicit skill paths (files or directories). Additive even with noSkills. */
  skillPaths?: string[];
  /** Include default discovery directories. Default: true */
  includeDefaults?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// ── Frontmatter parsing ────────────────────────────────────────────────────

/**
 * Extract YAML frontmatter from a markdown file.
 * Returns `{ frontmatter, body }` where frontmatter is parsed key-value pairs
 * and body is the markdown content after the closing `---`.
 */
function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const trimmed = content.replace(/^\uFEFF/, ""); // strip BOM
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const closingIndex = trimmed.indexOf("---", 3);
  if (closingIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlBlock = trimmed.slice(3, closingIndex).trim();
  const body = trimmed.slice(closingIndex + 3).trim();

  const frontmatter: SkillFrontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value: unknown = line.slice(colonIndex + 1).trim();

    // Handle quoted strings
    if (
      (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) ||
      (typeof value === "string" && value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Handle boolean
    if (value === "true") value = true;
    if (value === "false") value = false;

    if (key === "metadata") {
      // Skip nested metadata parsing for now; store as empty
      continue;
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(
      `name "${name}" does not match parent directory "${parentDirName}"`,
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
    );
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }
  return errors;
}

// ── XML escaping ───────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Single file loading ────────────────────────────────────────────────────

function loadSkillFromFile(
  filePath: string,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  try {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter(rawContent);

    const skillDir = path.dirname(filePath);
    const parentDirName = path.basename(skillDir);

    // Validate description
    const descErrors = validateDescription(frontmatter.description);
    for (const error of descErrors) {
      diagnostics.push({ type: "error", message: error, path: filePath });
    }

    // Use name from frontmatter, or fall back to parent directory name
    const name = (frontmatter.name as string) || parentDirName;

    // Validate name
    const nameErrors = validateName(name, parentDirName);
    for (const error of nameErrors) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Missing description → skip skill entirely
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        name,
        description: frontmatter.description as string,
        filePath,
        baseDir: skillDir,
        disableModelInvocation:
          frontmatter["disable-model-invocation"] === true,
      },
      diagnostics,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "failed to parse skill file";
    diagnostics.push({ type: "error", message, path: filePath });
    return { skill: null, diagnostics };
  }
}

// ── Directory scanning ────────────────────────────────────────────────────

/**
 * Load skills from a directory.
 *
 * Discovery rules (following the Agent Skills spec):
 * - If a directory contains SKILL.md, treat it as a skill root (no further recursion)
 * - Otherwise, recurse into subdirectories to find SKILL.md files
 * - In agent-specific directories (~/.anita/skills/, .anita/skills/), root .md files
 *   are also discovered as individual skills
 * - Skip dot-dirs, node_modules
 */
export function loadSkillsFromDir(
  dir: string,
  options: { includeRootFiles?: boolean } = {},
): LoadSkillsResult {
  return loadSkillsFromDirInternal(dir, options.includeRootFiles ?? false);
}

function loadSkillsFromDirInternal(
  dir: string,
  includeRootFiles: boolean,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  if (!fs.existsSync(dir)) {
    return { skills, diagnostics };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, diagnostics };
  }

  // Check for SKILL.md at root → this directory IS a skill
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;

    const fullPath = path.join(dir, entry.name);
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        isFile = fs.statSync(fullPath).isFile();
      } catch {
        continue;
      }
    }
    if (!isFile) continue;

    const result = loadSkillFromFile(fullPath);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);

    // This directory is a skill root; do not recurse further
    return { skills, diagnostics };
  }

  // No SKILL.md at root → scan subdirectories and optionally root .md files
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(fullPath);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      const subResult = loadSkillsFromDirInternal(fullPath, false);
      skills.push(...subResult.skills);
      diagnostics.push(...subResult.diagnostics);
      continue;
    }

    if (isFile && includeRootFiles && entry.name.endsWith(".md")) {
      const result = loadSkillFromFile(fullPath);
      if (result.skill) skills.push(result.skill);
      diagnostics.push(...result.diagnostics);
    }
  }

  return { skills, diagnostics };
}

// ── Full skills loading ────────────────────────────────────────────────────

/**
 * Load skills from all configured locations.
 *
 * Discovery order (later entries override earlier on name collision):
 * 1. User-level: ~/.anita/skills/ and ~/.agents/skills/
 * 2. Project-level: .anita/skills/ and .agents/skills/ (in cwd)
 * 3. Explicit --skill paths (additive even with --no-skills)
 *
 * The agent-specific directory falls back to the legacy `.ada` location when
 * `.anita` does not exist, so existing skill setups keep working.
 */
/*
 * Resolve the agent-specific skills directory under `base`, preferring the
 * canonical `.anita/skills` and falling back to the legacy `.ada/skills` when
 * the canonical directory does not exist.
 */
function resolveAgentSkillsDir(base: string): string {
  const primary = path.join(base, ".anita", "skills");
  if (fs.existsSync(primary)) return primary;

  const legacy = path.join(base, ".ada", "skills");
  if (fs.existsSync(legacy)) return legacy;

  return primary;
}

export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
  const { cwd = process.cwd(), skillPaths = [], includeDefaults = true } =
    options;

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const allDiagnostics: SkillDiagnostic[] = [];

  function addSkills(result: LoadSkillsResult): void {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      // Resolve symlinks to detect duplicate files
      let realPath: string;
      try {
        realPath = fs.realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }

      // Skip if already loaded via symlink
      if (realPathSet.has(realPath)) continue;

      const existing = skillMap.get(skill.name);
      if (existing) {
        allDiagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          collision: {
            name: skill.name,
            winnerPath: existing.filePath,
            loserPath: skill.filePath,
          },
        });
      } else {
        skillMap.set(skill.name, skill);
        realPathSet.add(realPath);
      }
    }
  }

  if (includeDefaults) {
    const homeDir = os.homedir();

    // User-level (agent-specific directory: includeRootFiles for standalone .md skills)
    addSkills(
      loadSkillsFromDirInternal(
        resolveAgentSkillsDir(homeDir),
        true, // root .md files are skills in agent dir
      ),
    );
    // User-level (cross-client .agents directory: no root .md files)
    addSkills(
      loadSkillsFromDirInternal(
        path.join(homeDir, ".agents", "skills"),
        false,
      ),
    );

    // Project-level
    addSkills(
      loadSkillsFromDirInternal(
        resolveAgentSkillsDir(cwd),
        true, // root .md files are skills in agent dir
      ),
    );
    addSkills(
      loadSkillsFromDirInternal(
        path.join(cwd, ".agents", "skills"),
        false,
      ),
    );
  }

  // Explicit skill paths (always additive)
  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);

    if (!fs.existsSync(resolvedPath)) {
      allDiagnostics.push({
        type: "warning",
        message: "skill path does not exist",
        path: resolvedPath,
      });
      continue;
    }

    try {
      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, true));
      } else if (stat.isFile() && resolvedPath.endsWith(".md")) {
        const result = loadSkillFromFile(resolvedPath);
        if (result.skill) {
          addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
        } else {
          allDiagnostics.push(...result.diagnostics);
        }
      } else {
        allDiagnostics.push({
          type: "warning",
          message: "skill path is not a markdown file or directory",
          path: resolvedPath,
        });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to read skill path";
      allDiagnostics.push({ type: "warning", message, path: resolvedPath });
    }
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: allDiagnostics,
  };
}

// ── Path resolution ────────────────────────────────────────────────────────

function resolveSkillPath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~"))
    return path.join(os.homedir(), trimmed.slice(1));
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

// ── Prompt formatting ─────────────────────────────────────────────────────

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per the Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via --skill or future command support).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read_file tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent directory of SKILL.md) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}