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
    contextBudget?: ContextBudgetOptions;
  } = {}
): { loop: AgentLoop; eventStore: EventStore; sessionStore: SessionStore } {
  const eventStore = new EventStore(path.join(cwd, "events"));
  const sessionStore = new SessionStore(path.join(cwd, "sessions"));
  const executor = new Executor(
    options.registry ?? new ToolRegistry(),
    options.policyEngine ?? new PolicyEngine(),
    eventStore,
    async () => options.approve?.() ?? true
  );

  return {
    loop: new AgentLoop(
      provider,
      executor,
      new ContextBuilder(cwd),
      options.registry ?? new ToolRegistry(),
      eventStore,
      sessionStore,
      false,
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
    assert.deepEqual(requests[0].messages.slice(0, 3), [
      { role: "user", content: "Earlier request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier answer" }],
      },
      { role: "user", content: "Next request" },
    ]);
    assert.match(
      JSON.stringify(requests[0].messages.at(-1)),
      /Current environment context/
    );

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
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, eventStore, sessionStore } = createHarness(cwd, provider, {
    contextBudget: {
      thresholdTokens: 80,
      preserveRecentMessages: 2,
      summaryMaxCharacters: 2_000,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].messages[0].role, "user");
    assert.match(
      JSON.stringify(requests[0].messages[0].content),
      /Previous conversation summary/
    );
    assert.deepEqual(requests[0].messages.slice(1, 4), [
      preservedToolUse,
      preservedToolResult,
      { role: "user", content: "Current request" },
    ]);

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.match(
      JSON.stringify(saved.messages[0].content),
      /Previous conversation summary/
    );
    assert.deepEqual(saved.messages.slice(1, 4), [
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
    assert.equal(saved.contextBudget.preservedRecentMessages, 2);
    assert.ok(saved.contextBudget.compactedAt);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["user_message", "conversation_compaction", "assistant_response"]
    );
    assert.equal(events[1].data.summarizedMessages, 3);
    assert.equal(events[1].data.preservedRecentMessages, 3);
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
      thresholdTokens: 80,
      preserveRecentMessages: 4,
      summaryMaxCharacters: 2_000,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].messages.slice(1, 4), [
      oldMessages[3],
      oldMessages[4],
      { role: "user", content: "Current request" },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.equal(events[1].type, "conversation_compaction");
    assert.equal(events[1].data.summarizedMessages, 3);
    assert.equal(events[1].data.preservedRecentMessages, 5);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("repeated compaction keeps newly summarized messages when summary is capped", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd, [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Previous conversation summary:\n${"old summary ".repeat(80)}`,
        },
      ],
    },
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
  const provider: ModelProvider = {
    async chat() {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done" }],
      };
    },
  };
  const { loop, sessionStore } = createHarness(cwd, provider, {
    contextBudget: {
      thresholdTokens: 80,
      preserveRecentMessages: 1,
      summaryMaxCharacters: 220,
    },
  });

  try {
    await silenceConsole(() => loop.run(session, "Current request"));

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    const summary = JSON.stringify(saved.messages[0].content);
    assert.match(summary, /Previous conversation summary/);
    assert.match(summary, /earlier summary truncated/);
    assert.match(summary, /Important new request/);
    assert.match(summary, /Important new answer/);
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
      ["user_message", "assistant_response", "policy_decision", "assistant_response"]
    );
    assert.deepEqual(events[2].data, {
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
      ["user_message", "assistant_response", "policy_decision", "assistant_response"]
    );
    assert.equal(events[2].data.decision, "ask");
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
        "assistant_response",
        "policy_decision",
        "tool_call",
        "tool_result",
        "assistant_response",
      ]
    );
    assert.deepEqual(events[4].data, {
      toolCallId: "tool-1",
      tool: "missing_tool",
      content: "Unknown tool: missing_tool",
      isError: true,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
