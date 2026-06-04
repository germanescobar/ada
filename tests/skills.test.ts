import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadSkillsFromDir,
  loadSkills,
  formatSkillsForPrompt,
  type Skill,
} from "../src/skills/skills.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;

function makeDir(...segments: string[]): string {
  const dir = path.join(tmpDir, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function makeSkill(dir: string, frontmatter: string, body = ""): string {
  fs.mkdirSync(dir, { recursive: true });
  const skillMd = path.join(dir, "SKILL.md");
  fs.writeFileSync(skillMd, `---\n${frontmatter}\n---\n\n${body}`, "utf-8");
  return skillMd;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ada-skills-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── loadSkillsFromDir ───────────────────────────────────────────────────

describe("loadSkillsFromDir", () => {
  it("discovers a directory with SKILL.md as a skill", () => {
    const skillDir = makeDir("my-skill");
    makeSkill(skillDir, "name: my-skill\ndescription: A test skill.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "my-skill");
    assert.equal(result.skills[0].description, "A test skill.");
    assert.equal(result.skills[0].filePath, path.join(skillDir, "SKILL.md"));
    assert.equal(result.skills[0].baseDir, skillDir);
  });

  it("does not recurse into a directory that contains SKILL.md", () => {
    const skillDir = makeDir("my-skill");
    makeSkill(skillDir, "name: my-skill\ndescription: A test skill.");
    // Put a SKILL.md in a subdir — it should NOT be discovered
    const subDir = path.join(skillDir, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    writeFile(path.join(subDir, "SKILL.md"), "---\nname: inner\ndescription: Inner\n---\n");

    const result = loadSkillsFromDir(skillDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "my-skill");
  });

  it("recurses into subdirectories to find SKILL.md", () => {
    const skillDir = makeDir("pdf-processing");
    makeSkill(skillDir, "name: pdf-processing\ndescription: Handles PDFs.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "pdf-processing");
  });

  it("skips dot directories and node_modules", () => {
    const validDir = makeDir("valid-skill");
    makeSkill(validDir, "name: valid-skill\ndescription: Valid.");

    // Create hidden and node_modules dirs (no SKILL.md should be found)
    makeDir(".hidden");
    makeDir("node_modules", "pkg-skill");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "valid-skill");
  });

  it("discovers root .md files as individual skills when includeRootFiles is true", () => {
    writeFile(
      path.join(tmpDir, "standalone.md"),
      "---\nname: standalone\ndescription: A standalone skill.\n---\n"
    );

    const result = loadSkillsFromDir(tmpDir, { includeRootFiles: true });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "standalone");
  });

  it("does not discover root .md files when includeRootFiles is false", () => {
    writeFile(
      path.join(tmpDir, "standalone.md"),
      "---\nname: standalone\ndescription: A standalone skill.\n---\n"
    );

    const result = loadSkillsFromDir(tmpDir, { includeRootFiles: false });
    assert.equal(result.skills.length, 0);
  });

  it("returns empty for nonexistent directory", () => {
    const result = loadSkillsFromDir(path.join(tmpDir, "nonexistent"));
    assert.equal(result.skills.length, 0);
    assert.equal(result.diagnostics.length, 0);
  });
});

// ── Validation ───────────────────────────────────────────────────────────

describe("validation", () => {
  it("skips skills with missing description", () => {
    const skillDir = makeDir("no-desc");
    makeSkill(skillDir, "name: no-desc");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 0);
    assert.ok(result.diagnostics.some((d) => d.message.includes("description is required")));
  });

  it("skips skills with empty description", () => {
    const skillDir = makeDir("empty-desc");
    makeSkill(skillDir, "name: empty-desc\ndescription: ");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 0);
  });

  it("warns when name does not match parent directory", () => {
    const skillDir = makeDir("wrong-dir-name");
    makeSkill(skillDir, "name: different-name\ndescription: Has a mismatched name.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.type === "warning" &&
          d.message.includes("does not match parent directory"),
      ),
    );
  });

  it("warns when name contains invalid characters", () => {
    const skillDir = makeDir("My-Skill");
    makeSkill(skillDir, "name: My-Skill\ndescription: Uppercase name.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.type === "warning" &&
          d.message.includes("invalid characters"),
      ),
    );
  });

  it("warns when name starts with a hyphen", () => {
    const skillDir = makeDir("-bad-name");
    makeSkill(skillDir, "name: -bad-name\ndescription: Starts with hyphen.");

    const result = loadSkillsFromDir(tmpDir);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.type === "warning" &&
          d.message.includes("must not start or end with a hyphen"),
      ),
    );
  });

  it("warns when name contains consecutive hyphens", () => {
    const skillDir = makeDir("bad--name");
    makeSkill(skillDir, "name: bad--name\ndescription: Double hyphens.");

    const result = loadSkillsFromDir(tmpDir);
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.type === "warning" &&
          d.message.includes("consecutive hyphens"),
      ),
    );
  });

  it("warns when description exceeds 1024 characters", () => {
    const skillDir = makeDir("long-desc");
    const longDesc = "x".repeat(1025);
    makeSkill(skillDir, `name: long-desc\ndescription: ${longDesc}`);

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1); // still loads
    assert.ok(
      result.diagnostics.some(
        (d) =>
          d.message.includes("description exceeds 1024 characters"),
      ),
    );
  });

  it("falls back to parent directory name when frontmatter name is absent", () => {
    const skillDir = makeDir("fallback-name");
    makeSkill(skillDir, "description: No name field.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "fallback-name");
  });

  it("handles disable-model-invocation flag", () => {
    const skillDir = makeDir("hidden-skill");
    makeSkill(skillDir, "name: hidden-skill\ndescription: Shh.\ndisable-model-invocation: true");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].disableModelInvocation, true);
  });
});

// ── loadSkills (full loading with multiple locations) ───────────────────

describe("loadSkills", () => {
  it("discovers skills from explicit skillPaths", () => {
    const skillDir = makeDir("explicit-skill");
    makeSkill(skillDir, "name: explicit-skill\ndescription: Explicitly loaded.");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [skillDir],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "explicit-skill");
  });

  it("loads a single .md file as a skill via skillPaths", () => {
    const skillMd = path.join(makeDir("standalone-file"), "my-tool.md");
    writeFile(skillMd, "---\nname: my-tool\ndescription: Standalone file skill.\n---\n");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [skillMd],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "my-tool");
  });

  it("warns on nonexistent skillPaths", () => {
    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [path.join(tmpDir, "does-not-exist")],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 0);
    assert.ok(
      result.diagnostics.some((d) => d.message.includes("does not exist")),
    );
  });

  it("warns on non-markdown skillPaths", () => {
    const filePath = path.join(tmpDir, "script.js");
    writeFile(filePath, "console.log('hi');");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [filePath],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 0);
    assert.ok(
      result.diagnostics.some((d) => d.message.includes("not a markdown file or directory")),
    );
  });

  it("detects name collisions (first-found wins)", () => {
    const dir1 = makeDir("collision-a");
    const dir2 = makeDir("collision-b");
    makeSkill(dir1, "name: same-name\ndescription: First one.");
    makeSkill(dir2, "name: same-name\ndescription: Second one.");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [dir1, dir2],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].description, "First one.");
    assert.ok(
      result.diagnostics.some((d) => d.type === "collision"),
    );
  });

  it("resolves absolute paths in skillPaths", () => {
    const skillDir = makeDir("abs-skill");
    makeSkill(skillDir, "name: abs-skill\ndescription: From absolute path.");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [skillDir],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "abs-skill");
  });

  it("does not discover default locations when includeDefaults is false", () => {
    const result = loadSkills({
      cwd: tmpDir,
      includeDefaults: false,
    });
    assert.ok(Array.isArray(result.skills));
    assert.equal(result.skills.length, 0);
  });

  it("explicit skillPaths are additive even when includeDefaults is false", () => {
    const skillDir = makeDir("additive-skill");
    makeSkill(skillDir, "name: additive-skill\ndescription: Added explicitly.");

    const result = loadSkills({
      cwd: tmpDir,
      skillPaths: [skillDir],
      includeDefaults: false,
    });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "additive-skill");
  });
});

// ── formatSkillsForPrompt ───────────────────────────────────────────────

describe("formatSkillsForPrompt", () => {
  it("returns empty string when no skills", () => {
    assert.equal(formatSkillsForPrompt([]), "");
  });

  it("formats skills in XML per Agent Skills standard", () => {
    const skills: Skill[] = [
      {
        name: "pdf-processing",
        description: "Extracts text from PDFs.",
        filePath: "/home/user/.ada/skills/pdf-processing/SKILL.md",
        baseDir: "/home/user/.ada/skills/pdf-processing",
        disableModelInvocation: false,
      },
    ];

    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("<available_skills>"));
    assert.ok(result.includes("</available_skills>"));
    assert.ok(result.includes("<name>pdf-processing</name>"));
    assert.ok(result.includes("<description>Extracts text from PDFs.</description>"));
    assert.ok(
      result.includes(
        "<location>/home/user/.ada/skills/pdf-processing/SKILL.md</location>",
      ),
    );
    assert.ok(result.includes("Use the read_file tool to load a skill's file"));
  });

  it("includes instructions about relative paths", () => {
    const skills: Skill[] = [
      {
        name: "test-skill",
        description: "Test.",
        filePath: "/tmp/test-skill/SKILL.md",
        baseDir: "/tmp/test-skill",
        disableModelInvocation: false,
      },
    ];

    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("resolve it against the skill directory"));
  });

  it("excludes skills with disableModelInvocation=true", () => {
    const skills: Skill[] = [
      {
        name: "visible",
        description: "I am visible.",
        filePath: "/tmp/visible/SKILL.md",
        baseDir: "/tmp/visible",
        disableModelInvocation: false,
      },
      {
        name: "hidden",
        description: "I am hidden.",
        filePath: "/tmp/hidden/SKILL.md",
        baseDir: "/tmp/hidden",
        disableModelInvocation: true,
      },
    ];

    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("<name>visible</name>"));
    assert.ok(!result.includes("<name>hidden</name>"));
  });

  it("escapes XML special characters in skill fields", () => {
    const skills: Skill[] = [
      {
        name: "xml-skill",
        description: 'Uses <tags> & "quotes"',
        filePath: "/tmp/xml-skill/SKILL.md",
        baseDir: "/tmp/xml-skill",
        disableModelInvocation: false,
      },
    ];

    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("&lt;tags&gt;"));
    assert.ok(result.includes("&amp;"));
    assert.ok(result.includes("&quot;"));
    assert.ok(!result.includes("<tags>"));
  });
});

// ── Multiple skills in one directory ─────────────────────────────────────

describe("multiple skills", () => {
  it("discovers multiple skill subdirectories", () => {
    makeDir("multi-root");
    makeSkill(makeDir("multi-root", "skill-a"), "name: skill-a\ndescription: Skill A.");
    makeSkill(makeDir("multi-root", "skill-b"), "name: skill-b\ndescription: Skill B.");

    const result = loadSkillsFromDir(path.join(tmpDir, "multi-root"));
    assert.equal(result.skills.length, 2);
    const names = result.skills.map((s) => s.name).sort();
    assert.deepEqual(names, ["skill-a", "skill-b"]);
  });
});

// ── Malformed frontmatter ───────────────────────────────────────────────

describe("malformed content", () => {
  it("skips files with completely unparseable YAML (no frontmatter delimiters)", () => {
    const skillDir = makeDir("bad-yaml-dir");
    writeFile(path.join(skillDir, "SKILL.md"), "This is just text with no frontmatter.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 0);
  });

  it("handles SKILL.md with only frontmatter (no body)", () => {
    const skillDir = makeDir("no-body");
    makeSkill(skillDir, "name: no-body\ndescription: No body here.");

    const result = loadSkillsFromDir(tmpDir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "no-body");
  });
});