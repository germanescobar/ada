import readline from "node:readline";
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
import { Executor } from "../agent/executor.js";
import { AgentLoop } from "../agent/loop.js";
import { SessionManager } from "../agent/session.js";
import { createProvider } from "../models/resolve.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

function getStoragePaths(cwd: string) {
  const base = path.join(cwd, ".coding-agent");
  return {
    events: path.join(base, "events"),
    sessions: path.join(base, "sessions"),
  };
}

async function askApproval(
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const summary =
    toolName === "run_command" ? (input.command as string) : JSON.stringify(input);

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow(`Allow ${toolName}: ${summary}? [y/n] `), resolve);
  });
  rl.close();
  return answer.toLowerCase().startsWith("y");
}

export function createCLI() {
  const program = new Command();

  program
    .name("ada")
    .description("An AI coding agent")
    .version("0.1.0")
    .option("--model <model>", "Model to use (provider/model)", DEFAULT_MODEL)
    .option("--stream-json", "Emit structured JSON events to stdout")
    .option("--auto-approve", "Auto-approve tool calls (dangerous commands are still denied)");

  program
    .command("chat")
    .argument("<message>", "Message to send to the agent")
    .option("--resume <sessionId>", "Resume a previous session")
    .option("--model <model>", "Model to use (provider/model)")
    .option("--stream-json", "Emit structured JSON events to stdout")
    .option("--auto-approve", "Auto-approve tool calls (dangerous commands are still denied)")
    .action(async (
      message: string,
      options: {
        resume?: string;
        model?: string;
        autoApprove?: boolean;
        streamJson?: boolean;
      }
    ) => {
      const parentOpts = program.opts() as {
        model: string;
        autoApprove?: boolean;
        streamJson?: boolean;
      };
      const model = options.model ?? parentOpts.model;
      const autoApprove = options.autoApprove ?? parentOpts.autoApprove;
      const streamJson = options.streamJson ?? parentOpts.streamJson ?? false;
      const cwd = process.cwd();
      const paths = getStoragePaths(cwd);

      const eventStore = new EventStore(paths.events);
      const sessionStore = new SessionStore(paths.sessions);
      const sessionManager = new SessionManager(sessionStore, eventStore);

      // Create or resume session
      const session = options.resume
        ? await sessionManager.resumeSession(options.resume)
        : await sessionManager.createSession(cwd, model);

      const modelString = session.model;
      const provider = createProvider(modelString);

      // Set up tools
      const registry = new ToolRegistry();
      registry.register(readFileTool);
      registry.register(writeFileTool);
      registry.register(editFileTool);
      registry.register(runCommandTool);
      registry.register(deleteFileTool);

      const policyEngine = PolicyEngine.withDefaults();
      const contextBuilder = new ContextBuilder(cwd);
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

      try {
        await loop.run(session, message);
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
