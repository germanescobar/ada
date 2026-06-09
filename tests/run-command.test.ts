import assert from "node:assert/strict";
import test from "node:test";

import { runCommandTool } from "../src/tools/run-command.js";

test("run_command terminates the child process when the signal aborts", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();

  const resultPromise = runCommandTool.execute(
    { command: "sleep 10" },
    { signal: controller.signal }
  );
  // Abort shortly after the process starts.
  setTimeout(() => controller.abort(), 50);

  const result = await resultPromise;
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 5_000, `expected quick termination, took ${elapsed}ms`);
  assert.equal(result.isError, true);
  assert.equal(result.metadata?.aborted, true);
  assert.equal(result.metadata?.timedOut, false);
  assert.match(result.content, /\[cancelled\]/);
});

test("run_command returns a cancelled result when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runCommandTool.execute(
    { command: "echo hello" },
    { signal: controller.signal }
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata?.aborted, true);
  assert.match(result.content, /\[cancelled\]/);
});

test("run_command still completes normally without a signal", async () => {
  const result = await runCommandTool.execute({ command: "echo hello" });

  assert.equal(result.isError, false);
  assert.equal(result.metadata?.aborted, false);
  assert.match(result.content, /hello/);
});
