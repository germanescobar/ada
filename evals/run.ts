import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { v4 as uuidv4 } from "uuid";

import { EventStore } from "../src/storage/event-store.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { PolicyEngine } from "../src/agent/policies.js";
import { ContextBuilder } from "../src/agent/context-builder.js";
import { Executor } from "../src/agent/executor.js";
import { AgentLoop } from "../src/agent/loop.js";
import { createProvider } from "../src/models/resolve.js";
import type { SessionState } from "../src/types/agent.js";

import { evalCases } from "./cases.js";
import type { EvalCase, EvalResult } from "./types.js";

const DEFAULT_MODEL = "ollama/glm-4.7-flash:latest";

async function runEval(evalCase: EvalCase, model: string): Promise<EvalResult> {
  const start = Date.now();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `ada-eval-`));
  const storagePath = path.join(tmpDir, ".ada-eval");

  try {
    // Write setup files
    if (evalCase.setupFiles) {
      for (const [filePath, content] of Object.entries(evalCase.setupFiles)) {
        const fullPath = path.join(tmpDir, filePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content);
      }
    }

    // Build the agent
    const eventStore = new EventStore(path.join(storagePath, "events"));
    const sessionStore = new SessionStore(path.join(storagePath, "sessions"));
    const provider = createProvider(model);

    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(editFileTool);
    registry.register(runCommandTool);

    // Allow all tools without prompting during evals
    const policyEngine = new PolicyEngine();
    policyEngine.addRule({ toolName: "read_file", decide: () => "allow" });
    policyEngine.addRule({ toolName: "write_file", decide: () => "allow" });
    policyEngine.addRule({ toolName: "edit_file", decide: () => "allow" });
    policyEngine.addRule({ toolName: "run_command", decide: () => "allow" });

    const autoApprove = async () => true;
    const contextBuilder = new ContextBuilder(tmpDir);
    const executor = new Executor(registry, policyEngine, eventStore, autoApprove);
    const loop = new AgentLoop(
      provider,
      executor,
      contextBuilder,
      registry,
      eventStore,
      sessionStore
    );

    const session: SessionState = {
      id: uuidv4(),
      workingDirectory: tmpDir,
      model,
      messages: [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: "active",
    };

    // Run the agent in the temp directory
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      await loop.run(session, evalCase.prompt);
    } finally {
      process.chdir(originalCwd);
    }

    // Verify the result
    execSync(evalCase.verify, { cwd: tmpDir, timeout: 10_000, stdio: "pipe" });

    return {
      name: evalCase.name,
      passed: true,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name: evalCase.name,
      passed: false,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const model = process.argv[2] || DEFAULT_MODEL;
  const filterName = process.argv[3]; // optional: run a single eval

  const cases = filterName
    ? evalCases.filter((c) => c.name === filterName)
    : evalCases;

  if (cases.length === 0) {
    console.error(`No eval found matching "${filterName}"`);
    process.exit(1);
  }

  console.log(`Running ${cases.length} evals with model: ${model}\n`);

  const results: EvalResult[] = [];

  for (const evalCase of cases) {
    process.stdout.write(`  ${evalCase.name} ... `);
    const result = await runEval(evalCase, model);
    results.push(result);

    if (result.passed) {
      console.log(`✓ (${(result.durationMs / 1000).toFixed(1)}s)`);
    } else {
      console.log(`✗ (${(result.durationMs / 1000).toFixed(1)}s)`);
      console.log(`    ${result.error?.split("\n")[0]}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} passed`);

  process.exit(passed === results.length ? 0 : 1);
}

main();
