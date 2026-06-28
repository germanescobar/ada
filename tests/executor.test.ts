import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Executor } from "../src/agent/executor.js";
import { PolicyEngine } from "../src/agent/policies.js";
import { EventStore } from "../src/storage/event-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/types/tools.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "anita-executor-"));
}

function createAskTool(): ToolDefinition {
  return {
    name: "ask_tool",
    description: "always asks for approval",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: "ok" };
    },
  };
}

test("executeTool forwards the abort signal to the approval callback", async () => {
  const cwd = createTempDir();
  try {
    const registry = new ToolRegistry();
    registry.register(createAskTool());

    const policyEngine = new PolicyEngine();
    policyEngine.addRule({
      toolName: "ask_tool",
      decide: () => "ask",
    });
    const eventStore = new EventStore(path.join(cwd, "events"));

    let receivedSignal: AbortSignal | undefined;
    let receivedToolCallId: string | undefined;
    const approvalCallback: Parameters<typeof Executor>[3] = (
      request,
      signal
    ) => {
      receivedToolCallId = request.toolCallId;
      receivedSignal = signal;
      return Promise.resolve(true);
    };

    const executor = new Executor(
      registry,
      policyEngine,
      eventStore,
      approvalCallback
    );

    const controller = new AbortController();
    const result = await executor.executeTool(
      "session-1",
      { id: "tc-1", name: "ask_tool", input: {} },
      { signal: controller.signal }
    );

    assert.equal(receivedSignal, controller.signal);
    assert.equal(receivedToolCallId, "tc-1");
    assert.equal(result.isError, undefined);
    assert.equal(result.content, "ok");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool returns a denied result when the approval callback returns false", async () => {
  const cwd = createTempDir();
  try {
    const registry = new ToolRegistry();
    registry.register(createAskTool());

    const policyEngine = new PolicyEngine();
    policyEngine.addRule({
      toolName: "ask_tool",
      decide: () => "ask",
    });
    const eventStore = new EventStore(path.join(cwd, "events"));
    const executor = new Executor(registry, policyEngine, eventStore, async () => false);

    const result = await executor.executeTool(
      "session-1",
      { id: "tc-1", name: "ask_tool", input: {} }
    );

    assert.equal(result.isError, true);
    assert.match(result.content ?? "", /denied by user/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool notifies before and after the approval callback resolves", async () => {
  const cwd = createTempDir();
  try {
    const registry = new ToolRegistry();
    registry.register(createAskTool());

    const policyEngine = new PolicyEngine();
    policyEngine.addRule({
      toolName: "ask_tool",
      decide: () => "ask",
    });
    const eventStore = new EventStore(path.join(cwd, "events"));

    const calls: string[] = [];
    let resolveApproval!: (value: boolean) => void;
    const approvalCallback = () =>
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      });
    const notifier = {
      notifyApprovalRequest: () => {
        calls.push("request");
      },
      notifyApprovalResolved: (event: { approved: boolean }) => {
        calls.push(event.approved ? "resolved:approved" : "resolved:denied");
      },
    };

    const executor = new Executor(
      registry,
      policyEngine,
      eventStore,
      approvalCallback,
      notifier
    );

    const promise = executor.executeTool("session-1", {
      id: "tc-1",
      name: "ask_tool",
      input: {},
    });
    // Wait for the executor to reach the await on approvalCallback. The
    // callback synchronously registers `resolveApproval`, so polling for it
    // is more reliable than a fixed number of microtask yields (the executor
    // first awaits the policy_decision event-store append).
    while (typeof resolveApproval !== "function") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls, ["request"]);
    resolveApproval(true);
    await promise;
    assert.deepEqual(calls, ["request", "resolved:approved"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("executeTool reports an aborted approval when the signal aborts before the callback returns", async () => {
  const cwd = createTempDir();
  try {
    const registry = new ToolRegistry();
    registry.register(createAskTool());

    const policyEngine = new PolicyEngine();
    policyEngine.addRule({
      toolName: "ask_tool",
      decide: () => "ask",
    });
    const eventStore = new EventStore(path.join(cwd, "events"));

    let resolveApproval!: (value: boolean) => void;
    const approvalCallback = () =>
      new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
      });
    const reasons: string[] = [];
    const notifier = {
      notifyApprovalRequest: () => {},
      notifyApprovalResolved: (event: { reason: string }) => {
        reasons.push(event.reason);
      },
    };

    const executor = new Executor(
      registry,
      policyEngine,
      eventStore,
      approvalCallback,
      notifier
    );

    const controller = new AbortController();
    const promise = executor.executeTool(
      "session-1",
      { id: "tc-1", name: "ask_tool", input: {} },
      { signal: controller.signal }
    );
    while (typeof resolveApproval !== "function") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Simulate the responder returning the answer after the signal was
    // already aborted. The notifier must record `aborted`, not `user`.
    controller.abort();
    resolveApproval(true);
    await promise;
    assert.deepEqual(reasons, ["aborted"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});