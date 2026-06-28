import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextBuilder } from "../src/agent/context-builder.js";
import { Executor } from "../src/agent/executor.js";
import { AgentLoop } from "../src/agent/loop.js";
import type { ContextBudgetOptions } from "../src/agent/loop.js";
import { PolicyEngine } from "../src/agent/policies.js";
import type { ChatParams, ModelProvider } from "../src/models/provider.js";
import { EventStore } from "../src/storage/event-store.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { runCommandTool } from "../src/tools/run-command.js";
import type { ModelResponse, SessionState } from "../src/types/agent.js";
import type { Message } from "../src/types/messages.js";
import type { ToolDefinition } from "../src/types/tools.js";
function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ada-harness-behavior-"));
}

function createSession(cwd: string, messages: Message[] = []): SessionState {
  const now = new Date().toISOString();
  return {
    id: "test-session",
    workingDirectory: cwd,
    model: "test/model",
    messages,
    createdAt: now,
    lastActiveAt: now,
    status: "active",
  };
}

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    async execute() {
      return { content: `${name} executed` };
    },
  };
}

function createHarness(
  cwd: string,
  provider: ModelProvider,
  options: {
    registry?: ToolRegistry;
    policyEngine?: PolicyEngine;
    approve?: () => Promise<boolean>;
    approvalCallback?: import("../src/types/approval.js").ApprovalCallback;
    contextBudget?: ContextBudgetOptions;
    streamJson?: boolean;
  } = {}
): { loop: AgentLoop; eventStore: EventStore; sessionStore: SessionStore } {
  const eventStore = new EventStore(path.join(cwd, "events"));
  const sessionStore = new SessionStore(path.join(cwd, "sessions"));
  const executor = new Executor(
    options.registry ?? new ToolRegistry(),
    options.policyEngine ?? new PolicyEngine(),
    eventStore,
    options.approvalCallback ?? (async () => options.approve?.() ?? true)
  );

  return {
    loop: new AgentLoop(
      provider,
      executor,
      new ContextBuilder(cwd),
      options.registry ?? new ToolRegistry(),
      eventStore,
      sessionStore,
      options.streamJson ?? false,
      options.contextBudget
    ),
    eventStore,
    sessionStore,
  };
}

async function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

async function captureConsole<T>(
  fn: () => Promise<T>
): Promise<{ result: T; lines: string[] }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}

test("run preserves prior messages and passes deterministic tool schemas", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd, [
    { role: "user", content: "Earlier request" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer" }],
    },
  ]);
  const registry = new ToolRegistry();
  registry.register(createTool("zeta"));
  registry.register(createTool("alpha"));
  const requests: ChatParams[] = [];
  const provider: ModelProvider = {
    async chat(request) {
      requests.push(request);
      if (request.systemPrompt.includes("rolling summary")) {
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "Summary of earlier work" }],
        };
      }
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, sessionStore } = createHarness(cwd, provider, { registry });

  try {
    await silenceConsole(() => loop.run(session, "Next request"));

    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.name),
      ["alpha", "zeta"]
    );
    assert.match(requests[0].systemPrompt, /Runtime context/);
    assert.doesNotMatch(
      JSON.stringify(requests[0].messages),
      /Runtime context/
    );
    assert.deepEqual(requests[0].messages.slice(0, 3), [
      { role: "user", content: "Earlier request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
      { role: "user", content: "Next request" },
    ]);

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages, [
      { role: "user", content: "Earlier request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
      { role: "user", content: "Next request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run compacts older messages when the approximate context budget is exceeded", async () => {
  const cwd = createTempDir();
  const oldMessages: Message[] = [
    { role: "user", content: "Earlier request " + "x".repeat(160) },
    {
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer " + "y".repeat(160) }],
    },
    { role: "user", content: "Second request " + "z".repeat(160) },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "old-tool",
          name: "read_file",
          input: { path: "old.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "old-tool",
          content: "old result " + "r".repeat(160),
        },
      ],
    },
  ];
  const preservedToolUse = oldMessages[3];
  const preservedToolResult = oldMessages[4];
  const session = createSession(cwd, oldMessages);
  const requests: ChatParams[] = [];
  const provider: ModelProvider = {
    async chat(request) {
      requests.push(request);
      if (request.systemPrompt.includes("rolling summary")) {
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "Summary of earlier work" }],
        };
      }
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider, {
    contextBudget: {
      compactAtRatio: 0.8,
      reservedResponseTokens: 127_900,
      keepRecentTokens: 100,
      minSummarizableTokens: 20,
      targetSummaryTokens: 100,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    assert.equal(requests.length, 2);
    assert.match(
      JSON.stringify(requests[0].messages[0].content),
      /Earlier request/
    );
    assert.match(
      JSON.stringify(requests[0].messages[0].content),
      /Second request/
    );
    assert.match(requests[1].systemPrompt, /Runtime context/);
    assert.equal(requests[1].messages[0].role, "user");
    assert.match(
      JSON.stringify(requests[1].messages[0].content),
      /Previous conversation summary/
    );
    assert.deepEqual(requests[1].messages.slice(1, 4), [
      preservedToolUse,
      preservedToolResult,
      { role: "user", content: "Current request" },
    ]);

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.slice(0, 6), [
      ...oldMessages,
      { role: "user", content: "Current request" },
    ]);
    assert.deepEqual(saved.messages.slice(3, 6), [
      preservedToolUse,
      preservedToolResult,
      { role: "user", content: "Current request" },
    ]);
    assert.deepEqual(saved.messages.at(-1), {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    });
    assert.ok(saved.contextBudget);
    assert.equal(saved.contextBudget.thresholdTokens, 80);
    assert.equal(saved.contextBudget.keepRecentTokens, 100);
    assert.ok((saved.contextBudget.preservedRecentTokens ?? 0) <= 100);
    assert.match(saved.contextBudget.compactionSummary ?? "", /Summary of earlier work/);
    assert.ok(saved.contextBudget.compactedAt);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "conversation_compaction",
        "model_request",
        "assistant_response",
      ]
    );
    assert.equal(events[1].data.summarizedMessages, 3);
    assert.equal(typeof events[1].data.preservedRecentTokens, "number");
    assert.equal(typeof events[1].data.summaryTokens, "number");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run compaction keeps parallel tool-call batches intact", async () => {
  const cwd = createTempDir();
  const oldMessages: Message[] = [
    { role: "user", content: "First request " + "a".repeat(160) },
    {
      role: "assistant",
      content: [{ type: "text", text: "First answer " + "b".repeat(160) }],
    },
    { role: "user", content: "Read two files " + "c".repeat(160) },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "one.txt" },
        },
        {
          type: "tool_use",
          id: "tool-2",
          name: "read_file",
          input: { path: "two.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: "one result " + "d".repeat(80),
        },
        {
          type: "tool_result",
          toolUseId: "tool-2",
          content: "two result " + "e".repeat(80),
        },
      ],
    },
  ];
  const session = createSession(cwd, oldMessages);
  const requests: ChatParams[] = [];
  const provider: ModelProvider = {
    async chat(request) {
      requests.push(request);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, eventStore } = createHarness(cwd, provider, {
    contextBudget: {
      compactAtRatio: 0.8,
      reservedResponseTokens: 127_900,
      keepRecentTokens: 120,
      minSummarizableTokens: 20,
      targetSummaryTokens: 100,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    assert.equal(requests.length, 2);
    assert.match(requests[1].systemPrompt, /Runtime context/);
    assert.deepEqual(requests[1].messages.slice(1, 4), [
      oldMessages[3],
      oldMessages[4],
      { role: "user", content: "Current request" },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.equal(events[1].type, "conversation_compaction");
    assert.equal(events[1].data.summarizedMessages, 3);
    assert.equal(typeof events[1].data.preservedRecentTokens, "number");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run compaction skips tiny eligible prefix with telemetry reason", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd, [
    { role: "user", content: "Small old request" },
    {
      role: "assistant",
      content: [{ type: "text", text: "Huge recent answer " + "x".repeat(900) }],
    },
  ]);
  const requests: ChatParams[] = [];
  const provider: ModelProvider = {
    async chat(request) {
      requests.push(request);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, eventStore } = createHarness(cwd, provider, {
    contextBudget: {
      compactAtRatio: 0.8,
      reservedResponseTokens: 127_900,
      keepRecentTokens: 240,
      minSummarizableTokens: 100,
      targetSummaryTokens: 100,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    assert.equal(requests.length, 1);
    assert.doesNotMatch(
      JSON.stringify(requests[0].messages),
      /Previous conversation summary/
    );

    const events = await eventStore.getEvents(session.id);
    assert.equal(events[1].type, "conversation_compaction");
    assert.equal(events[1].data.summarizedMessages, 0);
    assert.equal(events[1].data.skipReason, "eligible_prefix_too_small");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repeated compaction folds existing summary into model-generated summary", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd, [
    { role: "user", content: `Important new request ${"a".repeat(20)}` },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Important new answer ${"b".repeat(20)}`,
        },
      ],
    },
  ]);
  session.contextBudget = {
    approximateTokens: 0,
    thresholdTokens: 80,
    compactAtRatio: 0.8,
    reservedResponseTokens: 127_970,
    keepRecentTokens: 10,
    minSummarizableTokens: 10,
    targetSummaryTokens: 100,
    compactionSummary: `Previous conversation summary:\n${"old summary ".repeat(10)}`,
    summarizedItemCount: 0,
  };
  const provider: ModelProvider = {
    async chat(request) {
      if (request.systemPrompt.includes("rolling summary")) {
        const prompt = JSON.stringify(request.messages);
        assert.match(prompt, /old summary/);
        assert.match(prompt, /Important new request/);
        assert.match(prompt, /Important new answer/);
        return {
          stopReason: "end_turn",
          content: [
            {
              type: "text",
              text: "Previous conversation summary:\nold summary retained\nImportant new request and answer retained",
            },
          ],
        };
      }
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, sessionStore } = createHarness(cwd, provider, {
    contextBudget: {
      compactAtRatio: 0.8,
      reservedResponseTokens: 127_970,
      keepRecentTokens: 10,
      minSummarizableTokens: 10,
      targetSummaryTokens: 100,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    const summary = saved.contextBudget?.compactionSummary ?? "";
    assert.match(summary, /Previous conversation summary/);
    assert.match(summary, /old summary retained/);
    assert.match(summary, /Important new request/);
    assert.match(summary, /answer retained/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("policy-denied tool calls are returned as error tool results", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "run_command",
          input: { command: "rm -rf /" },
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "I could not run that command." }],
    },
  ];
  const requests: ChatParams[] = [];
  const provider: ModelProvider = {
    async chat(request) {
      requests.push(request);
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const policyEngine = new PolicyEngine();
  policyEngine.addRule({ toolName: "run_command", decide: () => "deny" });
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider, {
    policyEngine,
  });

  try {
    await silenceConsole(() => loop.run(session, "Delete everything"));

    const secondRequestToolResults = requests[1].messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result")
    );
    assert.deepEqual(secondRequestToolResults, {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: 'Tool "run_command" was denied by policy.',
          isError: true,
        },
      ],
    });

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.at(-2), {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: 'Tool "run_command" was denied by policy.',
          isError: true,
        },
      ],
    });

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "model_request",
        "assistant_response",
        "policy_decision",
        "assistant_response",
      ]
    );
    assert.deepEqual(events[3].data, {
      tool: "run_command",
      input: { command: "rm -rf /" },
      decision: "deny",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("approval-denied tool calls are returned as error tool results", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "run_command",
          input: { command: "npm test" },
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "The command was not approved." }],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const policyEngine = new PolicyEngine();
  policyEngine.addRule({ toolName: "run_command", decide: () => "ask" });
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider, {
    policyEngine,
    approve: async () => false,
  });

  try {
    await silenceConsole(() => loop.run(session, "Run the tests"));

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.at(-2), {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: 'Tool "run_command" was denied by user.',
          isError: true,
        },
      ],
    });

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "model_request",
        "assistant_response",
        "policy_decision",
        "assistant_response",
      ]
    );
    assert.equal(events[3].data.decision, "ask");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown tool calls are logged and returned as error tool results", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "missing_tool",
          input: {},
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "That tool is unavailable." }],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider);

  try {
    await silenceConsole(() => loop.run(session, "Use a missing tool"));

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.at(-2), {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content: "Unknown tool: missing_tool",
          isError: true,
        },
      ],
    });

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "model_request",
        "assistant_response",
        "policy_decision",
        "tool_call",
        "tool_result",
        "assistant_response",
      ]
    );
    assert.deepEqual(events[5].data, {
      toolCallId: "tool-1",
      tool: "missing_tool",
      content: "Unknown tool: missing_tool",
      isError: true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("malformed run_command input returns a tool error without policy evaluation", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const registry = new ToolRegistry();
  registry.register(runCommandTool);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "run_command",
          input: {},
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "I need to include a command." }],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider, {
    registry,
    policyEngine: PolicyEngine.withDefaults(),
  });

  try {
    await silenceConsole(() => loop.run(session, "Run a command"));

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.at(-2), {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "tool-1",
          content:
            'Invalid input for tool "run_command": missing required field "command".',
          isError: true,
          metadata: {
            validationErrors: ['missing required field "command".'],
          },
        },
      ],
    });

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "model_request",
        "assistant_response",
        "tool_call",
        "tool_result",
        "assistant_response",
      ]
    );
    assert.deepEqual(events[4].data, {
      toolCallId: "tool-1",
      tool: "run_command",
      content:
        'Invalid input for tool "run_command": missing required field "command".',
      isError: true,
      metadata: {
        validationErrors: ['missing required field "command".'],
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run emits approval.request and approval.resolved events around an ask-decision tool call", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "run_command",
          input: { command: "npm test" },
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Tests ran." }],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const policyEngine = new PolicyEngine();
  policyEngine.addRule({ toolName: "run_command", decide: () => "ask" });
  const { loop, eventStore } = createHarness(cwd, provider, {
    policyEngine,
    approve: async () => true,
    streamJson: true,
  });

  try {
    const { lines } = await captureConsole(() =>
      loop.run(session, "Run the tests")
    );
    const events = lines.map((line) => JSON.parse(line) as { type: string });

    // approval.request must fire before any tool.call / tool.result for the
    // same toolCallId, and approval.resolved must fire afterwards. This is
    // the audit trail consumers rely on (issue #75 §1).
    const types = events.map((event) => event.type);
    assert.deepEqual(types, [
      "run.started",
      "tool.call",
      "approval.request",
      "approval.resolved",
      "tool.result",
      "assistant.text",
      "run.completed",
    ]);
    assert.equal(events[2].id, "toolu_abc");
    assert.equal(events[2].tool, "run_command");
    assert.deepEqual(events[2].input, { command: "npm test" });
    assert.equal(events[3].id, "toolu_abc");
    assert.equal(events[3].approved, true);
    assert.equal(events[3].reason, "user");

    // The approval events are stream-only and must not be persisted to the
    // event log; the persisted sequence stays the same.
    const persisted = await eventStore.getEvents(session.id);
    assert.deepEqual(
      persisted.map((event) => event.type),
      [
        "user_message",
        "model_request",
        "assistant_response",
        "policy_decision",
        "tool_call",
        "tool_result",
        "assistant_response",
      ]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run emits approval.resolved with reason=aborted when the signal aborts mid-prompt", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_xyz",
          name: "run_command",
          input: { command: "npm test" },
        },
      ],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const policyEngine = new PolicyEngine();
  policyEngine.addRule({ toolName: "run_command", decide: () => "ask" });

  const controller = new AbortController();
  // Responder that aborts the signal before resolving, simulating a slow
  // stream-json consumer that lost its run.
  const responder = async () => {
    controller.abort();
    return true;
  };
  const { loop } = createHarness(cwd, provider, {
    policyEngine,
    approvalCallback: responder,
    streamJson: true,
  });

  try {
    const { lines } = await captureConsole(() =>
      loop.run(session, "Run the tests", [], controller.signal)
    );
    const events = lines.map(
      (line) => JSON.parse(line) as { type: string; reason?: string }
    );
    const resolved = events.find((event) => event.type === "approval.resolved");
    assert.ok(resolved, "expected an approval.resolved event");
    assert.equal(resolved.reason, "aborted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run emits approval.resolved with reason=eof when the resolver signals stdin closed", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_eof",
          name: "run_command",
          input: { command: "npm test" },
        },
      ],
    },
    {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Skipped." }],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  };
  const policyEngine = new PolicyEngine();
  policyEngine.addRule({ toolName: "run_command", decide: () => "ask" });

  // Resolver mimics the stdin responder's EOF behavior: returns a structured
  // answer that explicitly carries `reason: "eof"` so the executor's audit
  // event reflects the actual cause instead of a generic "user" denial.
  const { loop } = createHarness(cwd, provider, {
    policyEngine,
    approvalCallback: async () => ({ approved: false, reason: "eof" }),
    streamJson: true,
  });

  try {
    const { lines } = await captureConsole(() =>
      loop.run(session, "Run the tests")
    );
    const events = lines.map(
      (line) => JSON.parse(line) as {
        type: string;
        approved?: boolean;
        reason?: string;
      }
    );
    const resolved = events.find((event) => event.type === "approval.resolved");
    assert.ok(resolved, "expected an approval.resolved event");
    assert.equal(resolved.approved, false);
    assert.equal(resolved.reason, "eof");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
