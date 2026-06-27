import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { askApprovalOn } from "../src/cli/index.js";

function createStreams(): {
  input: PassThrough;
  output: PassThrough;
} {
  return { input: new PassThrough(), output: new PassThrough() };
}

test("askApprovalOn resolves false when the signal aborts mid-prompt", async () => {
  const { input, output } = createStreams();
  const controller = new AbortController();

  const pending = askApprovalOn(
    { input, output },
    "run_command",
    { command: "rm -rf /tmp/important" },
    controller.signal
  );

  // Allow the readline prompt to register its abort listener before aborting.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  const approved = await pending;
  assert.equal(approved, false);
});

test("askApprovalOn resolves true when the user answers y", async () => {
  const { input, output } = createStreams();
  const controller = new AbortController();

  const pending = askApprovalOn(
    { input, output },
    "run_command",
    { command: "echo hi" },
    controller.signal
  );

  // Simulate the user typing "y\n" on the prompt.
  await new Promise((resolve) => setImmediate(resolve));
  input.write("y\n");

  const approved = await pending;
  assert.equal(approved, true);
});

test("askApprovalOn resolves false when the user answers n", async () => {
  const { input, output } = createStreams();
  const controller = new AbortController();

  const pending = askApprovalOn(
    { input, output },
    "run_command",
    { command: "echo hi" },
    controller.signal
  );

  await new Promise((resolve) => setImmediate(resolve));
  input.write("n\n");

  const approved = await pending;
  assert.equal(approved, false);
});

test("askApprovalOn resolves false when the signal is already aborted", async () => {
  const { input, output } = createStreams();
  const controller = new AbortController();
  controller.abort();

  const approved = await askApprovalOn(
    { input, output },
    "run_command",
    { command: "echo hi" },
    controller.signal
  );

  assert.equal(approved, false);
});
