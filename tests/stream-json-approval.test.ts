import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createStdinApprovalResponder } from "../src/cli/index.js";
import type { ApprovalRequest } from "../src/types/approval.js";

function createRequest(
  overrides: Partial<ApprovalRequest> = {}
): ApprovalRequest {
  return {
    toolCallId: "toolu_1",
    toolName: "run_command",
    input: { command: "npm test" },
    ...overrides,
  };
}

function createStreams(): { input: PassThrough; stderr: PassThrough } {
  return { input: new PassThrough(), stderr: new PassThrough() };
}

async function flush(): Promise<void> {
  // Yield enough times for the readline 'line' listener to fire on the
  // synthesized input chunks. The responder uses readline to split stdin,
  // which schedules its handler on the next tick.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("stdin approval responder resolves true on a matching approval.response line", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, true);
});

test("stdin approval responder resolves false on an explicit approval.response with approved=false", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: false }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, false);
});

test("stdin approval responder discards responses for a different id and keeps waiting", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  // Wrong id: must be discarded, not resolve.
  input.write(
    JSON.stringify({ type: "approval.response", id: "other_tool", approved: true }) + "\n"
  );
  await flush();
  assert.ok(stderr.read().length > 0, "expected the responder to log a mismatch to stderr");
  // Now send the matching response.
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, true);
});

test("stdin approval responder discards malformed JSON without resolving", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  input.write("not-json-at-all\n");
  await flush();
  // Still pending: send the matching line next.
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, true);
  // The malformed line was logged to stderr so consumers can debug.
  assert.match(stderr.read().toString(), /malformed approval\.response/);
});

test("stdin approval responder discards unknown message types without resolving", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  input.write(JSON.stringify({ type: "tool.call", id: "x" }) + "\n");
  await flush();
  // Still pending: send the matching response.
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, true);
});

test("stdin approval responder resolves with reason=eof on EOF when no answer arrives", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());

  await flush();
  input.end();
  const answer = await pending;
  assert.deepEqual(answer, { approved: false, reason: "eof" });
});

test("stdin approval responder resolves false on AbortSignal", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const controller = new AbortController();
  const pending = responder(createRequest(), controller.signal);

  await flush();
  controller.abort();
  const approved = await pending;
  assert.equal(approved, false);
});

test("stdin approval responder discards responses received before any request", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });

  // Send a response first (no pending request); it should be discarded.
  await flush();
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  await flush();
  assert.match(stderr.read().toString(), /no pending request/);

  // A subsequent request should still work.
  const pending = responder(createRequest());
  await flush();
  input.write(
    JSON.stringify({ type: "approval.response", id: "toolu_1", approved: true }) + "\n"
  );
  const approved = await pending;
  assert.equal(approved, true);
});

test("stdin approval responder close() resolves pending requests with reason=eof", async () => {
  const { input, stderr } = createStreams();
  const responder = createStdinApprovalResponder({ input, stderr });
  const pending = responder(createRequest());
  await flush();
  // Close without sending an answer or closing stdin.
  responder.close();
  const answer = await pending;
  assert.deepEqual(answer, { approved: false, reason: "eof" });
});

test("stdin approval responder close() is idempotent and short-circuits later calls", async () => {
  const { input } = createStreams();
  const responder = createStdinApprovalResponder({ input });
  responder.close();
  responder.close();
  const answer = await responder(createRequest());
  assert.deepEqual(answer, { approved: false, reason: "eof" });
});
