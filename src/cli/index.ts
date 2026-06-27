import readline from "node:readline";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";

import { EventStore } from "../storage/event-store.js";
import { SessionStore } from "../storage/session-store.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { editFileTool } from "../tools/edit-file.js";
import { runCommandTool } from "../tools/run-command.js";
import { deleteFileTool } from "../tools/delete-file.js";
import { PolicyEngine } from "../agent/policies.js";
import { ContextBuilder } from "../agent/context-builder.js";
import {
  getGlobalAgentsPath,
  getRepositoryAgentsPath,
} from "../agent/agents.js";
import { Executor } from "../agent/executor.js";
import {
  AgentLoop,
} from "../agent/loop.js";
import { SessionManager } from "../agent/session.js";
import { loadAttachments } from "../attachments.js";
import {
  createProvider,
  getModelCapabilities,
  getModelOptions,
  groupModelOptions,
  MODEL_OPTIONS,
  type ModelOption,
  type ModelOptionsResult,
} from "../models/resolve.js";
import { loadSkills, type Skill } from "../skills/skills.js";

const DEFAULT_MODEL = "ollama/glm-4.7-flash:latest";
const AGENTS_TEMPLATE = `# AGENTS.md

Describe the coding guidelines, project conventions, and operational constraints Anita should follow.
`;

function getStoragePaths(cwd: string) {
  const base = resolveStorageBase(cwd);
  return {
    events: path.join(base, "events"),
    sessions: path.join(base, "sessions"),
  };
}

/*
 * Resolve the session-storage directory, preferring the canonical `.anita`
 * location. Because `.anita` may already exist for skills, presence of a
 * `sessions/` subdirectory is used to detect real storage: fall back to the
 * legacy `.coding-agent` directory only when it holds existing sessions.
 */
function resolveStorageBase(cwd: string): string {
  const primary = path.join(cwd, ".anita");
  if (existsSync(path.join(primary, "sessions"))) return primary;

  const legacy = path.join(cwd, ".coding-agent");
  if (existsSync(path.join(legacy, "sessions"))) return legacy;

  return primary;
}

export function formatModelOptions(
  options: readonly ModelOption[] = MODEL_OPTIONS
): string {
  return groupModelOptions(options)
    .map((group) => {
      const lines = group.options.map(
        (option) =>
          `  ${option.value.padEnd(38)} ${option.label}${formatCapabilities(option)}`
      );
      return [group.group, ...lines].join("\n");
    })
    .join("\n\n");
}

export function formatModelOptionsJson(result: ModelOptionsResult): string {
  return JSON.stringify(
    {
      models: result.options,
      ollamaDiscoveryFailed: result.ollamaDiscoveryFailed,
    },
    null,
    2
  );
}

function formatCapabilities(option: ModelOption): string {
  const attachments = option.capabilities?.attachments;
  if (!attachments) return "";

  const supported = [
    attachments.images ? "images" : undefined,
    attachments.files ? "files" : undefined,
  ].filter((item): item is string => item !== undefined);

  return supported.length > 0 ? ` [${supported.join(", ")}]` : "";
}

async function createAgentsFile(filePath: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, AGENTS_TEMPLATE, {
      encoding: "utf-8",
      flag: force ? "w" : "wx",
    });
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      throw new Error(
        `AGENTS.md already exists at ${filePath}. Use --force to overwrite it.`,
      );
    }
    throw err;
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

async function askApproval(
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  return askApprovalOn(
    { input: process.stdin, output: process.stdout },
    toolName,
    input,
    signal
  );
}

export async function askApprovalOn(
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  const rl = readline.createInterface({
    input: streams.input,
    output: streams.output,
  });

  const summary =
    toolName === "run_command" ? (input.command as string) : JSON.stringify(input);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => settle(false);

    if (signal?.aborted) {
      settle(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    rl.question(
      chalk.yellow(`Allow ${toolName}: ${summary}? [y/n] `),
      (answer) => settle(answer.toLowerCase().startsWith("y"))
    );
  });
}

export function createCLI() {
  const program = new Command();

  program
    .name("anita")
    .description("An AI coding agent")
    .version("0.3.0")
    .option("--model <model>", "Model to use (provider/model)", DEFAULT_MODEL)
    .option("--system-prompt <prompt>", "Additional system prompt instructions")
    .option("--stream-json", "Emit structured JSON events to stdout")
    .option("--auto-approve", "Auto-approve tool calls (dangerous commands are still denied)");

  program
    .command("models")
    .description("List supported model choices")
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      const result = await getModelOptions();
      if (options.json) {
        console.log(formatModelOptionsJson(result));
        return;
      }

      console.log(formatModelOptions(result.options));
      if (result.ollamaDiscoveryFailed) {
        console.error(
          chalk.gray(
            "Note: Local Ollama discovery unavailable; showing built-in local models."
          )
        );
      }
    });

  program
    .command("agents")
    .description("Manage AGENTS.md instruction files")
    .command("init")
    .description("Create an AGENTS.md instruction file")
    .option(
      "--global",
      "Create ~/.anita/AGENTS.md instead of repository AGENTS.md",
    )
    .option("--force", "Overwrite an existing AGENTS.md")
    .action(async (options: { global?: boolean; force?: boolean }) => {
      const filePath = options.global
        ? getGlobalAgentsPath()
        : getRepositoryAgentsPath(process.cwd());

      try {
        await createAgentsFile(filePath, options.force ?? false);
        console.log(chalk.green(`Created ${filePath}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  program
    .command("chat")
    .argument("<message>", "Message to send to the agent")
    .option("--resume <sessionId>", "Resume a previous session")
    .option("--model <model>", "Model to use (provider/model)")
    .option("--system-prompt <prompt>", "Additional system prompt instructions")
    .option("--stream-json", "Emit structured JSON events to stdout")
    .option("--auto-approve", "Auto-approve tool calls (dangerous commands are still denied)")
    .option("--attach <path-or-url>", "Attach an image or PDF to the user message (repeatable)", (val, prev: string[]) => prev.concat(val), [] as string[])
    .option("--skill <path>", "Load a skill from a file or directory (repeatable)", (val, prev: string[]) => prev.concat(val), [] as string[])
    .option("--no-skills", "Disable automatic skill discovery (explicit --skill paths still load)")
    .action(async (
      message: string,
      options: {
        resume?: string;
        model?: string;
        systemPrompt?: string;
        autoApprove?: boolean;
        streamJson?: boolean;
        attach?: string[];
        skill?: string[];
        skills?: boolean;
      }
    ) => {
      const parentOpts = program.opts() as {
        model: string;
        systemPrompt?: string;
        autoApprove?: boolean;
        streamJson?: boolean;
      };
      const model = options.model ?? parentOpts.model;
      const autoApprove = options.autoApprove ?? parentOpts.autoApprove;
      const streamJson = options.streamJson ?? parentOpts.streamJson ?? false;
      const systemPrompt = options.systemPrompt ?? parentOpts.systemPrompt;
      const cwd = process.cwd();
      const paths = getStoragePaths(cwd);

      const eventStore = new EventStore(paths.events);
      const sessionStore = new SessionStore(paths.sessions);
      const sessionManager = new SessionManager(sessionStore, eventStore);

      // Create or resume session
      const session = options.resume
        ? await sessionManager.resumeSession(options.resume)
        : await sessionManager.createSession(cwd, model);

      const explicitModel = options.model ?? (program.getOptionValueSource("model") === "cli" ? parentOpts.model : undefined);
      const modelString = options.resume ? (explicitModel ?? session.model) : model;
      const provider = createProvider(modelString);
      const attachments = await loadAttachments(
        options.attach ?? [],
        getModelCapabilities(modelString),
        cwd
      );

      // Set up tools
      const registry = new ToolRegistry();
      registry.register(readFileTool);
      registry.register(writeFileTool);
      registry.register(editFileTool);
      registry.register(runCommandTool);
      registry.register(deleteFileTool);

      const policyEngine = PolicyEngine.withDefaults();

      // Load skills
      const skillPaths = options.skill ?? [];
      const includeDefaults = options.skills !== false;
      const { skills, diagnostics } = loadSkills({ cwd, skillPaths, includeDefaults });

      // Log diagnostics for skill loading issues
      for (const diag of diagnostics) {
        if (diag.type === "error" || diag.type === "collision") {
          console.error(chalk.yellow(`Skill warning: ${diag.message} (${diag.path})`));
        }
      }

      // Log skills_loaded event
      if (skills.length > 0) {
        await eventStore.append(session.id, "skills_loaded", {
          skills: skills.map((s: Skill) => ({
            name: s.name,
            description: s.description,
            filePath: s.filePath,
          })),
        });
        if (!streamJson) {
          console.log(chalk.gray(`Skills: ${skills.map((s: Skill) => s.name).join(", ")}`));
        }
      }

      const contextBuilder = new ContextBuilder(cwd, {
        approvalMode: autoApprove ? "auto" : "prompt",
        networkAccess: "unknown",
        shell: process.env.SHELL,
        writeScope:
          "Prefer the working directory and its descendants unless the user explicitly asks for another path.",
        policyContext: policyEngine.describe(),
        skills,
        systemPrompt,
      });
      const approvalFn = autoApprove ? async () => true : askApproval;
      const executor = new Executor(registry, policyEngine, eventStore, approvalFn);
      const loop = new AgentLoop(
        provider,
        executor,
        contextBuilder,
        registry,
        eventStore,
        sessionStore,
        streamJson
      );

      if (!streamJson) {
        console.log(chalk.gray(`Session: ${session.id}`));
        if (session.title) {
          console.log(chalk.gray(`Title: ${session.title}`));
        }
        console.log(chalk.gray(`Model: ${modelString}`));
        console.log();
      }

      const abortController = new AbortController();
      let interrupted = false;
      const onSigint = () => {
        if (interrupted) {
          // A second Ctrl-C forces an immediate exit if cancellation hangs.
          process.exit(130);
        }
        interrupted = true;
        abortController.abort();
        if (!streamJson) {
          console.log(
            chalk.yellow("\nCancelling run… (press Ctrl-C again to force quit)")
          );
        }
      };
      process.on("SIGINT", onSigint);

      try {
        await loop.run(session, message, attachments, abortController.signal);
      } catch (err) {
        const errorMessage = (err as Error).message;
        if (streamJson) {
          console.log(
            JSON.stringify({
              type: "run.failed",
              sessionId: session.id,
              error: errorMessage,
              timestamp: new Date().toISOString(),
            })
          );
        } else {
          console.error(chalk.red(`Error: ${errorMessage}`));
        }
        process.exit(1);
      } finally {
        process.off("SIGINT", onSigint);
      }

      if (interrupted) {
        process.exit(130);
      }
    });

  program
    .command("sessions")
    .description("List past sessions")
    .option("--archived", "Include archived sessions")
    .action(async (options: { archived?: boolean }) => {
      const cwd = process.cwd();
      const paths = getStoragePaths(cwd);
      const sessionStore = new SessionStore(paths.sessions);
      const sessions = await sessionStore.list(options.archived ?? false);

      if (sessions.length === 0) {
        console.log("No sessions found.");
        return;
      }

      for (const s of sessions) {
        const msgCount = s.messages.length;
        const title = s.title ?? '(untitled)';
        const archived = s.status === "archived" ? chalk.yellow(" [archived]") : "";
        console.log(
          `${chalk.cyan(s.id.slice(0, 8))}  ${chalk.white.bold(title)}${archived}  ${chalk.gray(`${s.model}  ${msgCount} msgs  ${s.lastActiveAt}`)}`
        );
      }
    });

  program
    .command("archive")
    .argument("<sessionId>", "Session ID to archive")
    .description("Archive a session")
    .action(async (sessionId: string) => {
      const cwd = process.cwd();
      const paths = getStoragePaths(cwd);
      const eventStore = new EventStore(paths.events);
      const sessionStore = new SessionStore(paths.sessions);
      const sessionManager = new SessionManager(sessionStore, eventStore);

      try {
        await sessionManager.archiveSession(sessionId);
        console.log(chalk.green(`Session ${sessionId.slice(0, 8)} archived.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  program
    .command("events")
    .argument("<sessionId>", "Session ID to view events for")
    .description("View event log for a session")
    .action(async (sessionId: string) => {
      const cwd = process.cwd();
      const paths = getStoragePaths(cwd);
      const eventStore = new EventStore(paths.events);
      const events = await eventStore.getEvents(sessionId);

      if (events.length === 0) {
        console.log("No events found.");
        return;
      }

      for (const e of events) {
        console.log(
          `${chalk.gray(e.timestamp)}  ${chalk.yellow(e.type)}  ${JSON.stringify(e.data).slice(0, 120)}`
        );
      }
    });

  return program;
}
