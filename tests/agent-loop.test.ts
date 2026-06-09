import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextBuilder } from "../src/agent/context-builder.js";
import type { Executor } from "../src/agent/executor.js";
import { AgentLoop } from "../src/agent/loop.js";
import type { ModelProvider } from "../src/models/provider.js";
import { EventStore } from "../src/storage/event-store.js";
import { SessionStore } from "../src/storage/session-store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelResponse, SessionState } from "../src/types/agent.js";
import type { Message } from "../src/types/messages.js";
import type { ToolCall, ToolResult } from "../src/types/tools.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ada-agent-loop-"));
}

function createSession(cwd: string): SessionState {
  const now = new Date().toISOString();
  return {
    id: "test-session",
    workingDirectory: cwd,
    model: "test/model",
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    status: "active",
  };
}

function createLoop(
  cwd: string,
  provider: ModelProvider,
  executeTool: (toolCall: ToolCall) => Promise<ToolResult> = async () => ({
    content: "unused",
  }),
  streamJson = false
): { loop: AgentLoop; eventStore: EventStore; sessionStore: SessionStore } {
  const eventStore = new EventStore(path.join(cwd, "events"));
  const sessionStore = new SessionStore(path.join(cwd, "sessions"));
  const executor = {
    executeTool: async (_sessionId: string, toolCall: ToolCall) =>
      executeTool(toolCall),
  };

  return {
    loop: new AgentLoop(
      provider,
      executor as unknown as Executor,
      new ContextBuilder(cwd),
      new ToolRegistry(),
      eventStore,
      sessionStore,
      streamJson
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

test("run saves the user message before model failure", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const provider: ModelProvider = {
    async chat() {
      throw new Error("model failed");
    },
  };
  const { loop, eventStore, sessionStore } = createLoop(cwd, provider);

  try {
    await assert.rejects(
      silenceConsole(() => loop.run(session, "Please inspect the project")),
      /model failed/
    );

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.conversationItems, [
      { type: "message", role: "user", content: "Please inspect the project" },
    ]);
    assert.equal(saved.title, "Please inspect the project");
    assert.deepEqual(saved.messages, [
      { role: "user", content: "Please inspect the project" },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["user_message", "error"]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run saves assistant responses and tool-result batches before later failure", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const responses: ModelResponse[] = [
    {
      stopReason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "README.md" },
        },
      ],
    },
  ];
  const provider: ModelProvider = {
    async chat() {
      const response = responses.shift();
      if (!response) throw new Error("second model call failed");
      return response;
    },
  };
  const { loop, eventStore, sessionStore } = createLoop(
    cwd,
    provider,
    async () => ({
      content: "file contents",
      metadata: {
        bytes: 13,
        lineCount: 1,
        truncated: false,
      },
    })
  );

  try {
    await assert.rejects(
      silenceConsole(() => loop.run(session, "Read the README")),
      /second model call failed/
    );

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.conversationItems, [
      { type: "message", role: "user", content: "Read the README" },
      {
        type: "function_call",
        id: "tool-1",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "function_output",
        callId: "tool-1",
        content: "file contents",
        metadata: {
          bytes: 13,
          lineCount: 1,
          truncated: false,
        },
      },
    ]);
    assert.deepEqual(saved.messages, [
      { role: "user", content: "Read the README" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tool-1",
            content: "file contents",
            metadata: {
              bytes: 13,
              lineCount: 1,
              truncated: false,
            },
          },
        ],
      },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["user_message", "assistant_response", "error"]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime context is not sent as the latest user turn after tool results", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const modelMessages: Message[][] = [];
  let calls = 0;
  const provider: ModelProvider = {
    async chat(params) {
      modelMessages.push(params.messages);
      calls += 1;
      if (calls === 1) {
        return {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        };
      }
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      };
    },
  };
  const { loop } = createLoop(
    cwd,
    provider,
    async () => ({ content: "file contents" })
  );

  try {
    await silenceConsole(() => loop.run(session, "Read the README"));

    assert.equal(modelMessages.length, 2);
    assert.match(
      JSON.stringify(modelMessages[0]?.[0]?.content),
      /Runtime context for the assistant/
    );
    assert.deepEqual(modelMessages[0]?.at(-1), {
      role: "user",
      content: "Read the README",
    });

    const secondLast = modelMessages[1]?.at(-1);
    assert.equal(secondLast?.role, "user");
    assert.ok(Array.isArray(secondLast?.content));
    assert.equal(secondLast.content[0]?.type, "tool_result");
    assert.equal(secondLast.content[0]?.content, "file contents");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run saves synthetic error tool results when tool execution throws", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  const provider: ModelProvider = {
    async chat() {
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "run_command",
            input: { command: "npm test" },
          },
        ],
      };
    },
  };
  const { loop, eventStore, sessionStore } = createLoop(
    cwd,
    provider,
    async () => {
      throw new Error("disk read failed");
    }
  );

  try {
    await assert.rejects(
      silenceConsole(() => loop.run(session, "Read and test")),
      /disk read failed/
    );

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages, [
      { role: "user", content: "Read and test" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "run_command",
            input: { command: "npm test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tool-1",
            content:
              'Tool "read_file" failed before returning a result: disk read failed',
            isError: true,
          },
          {
            type: "tool_result",
            toolUseId: "tool-2",
            content:
              'Tool "run_command" was not executed because a previous tool failed.',
            isError: true,
          },
        ],
      },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["user_message", "assistant_response", "error"]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run fails when tool use never reaches a final response", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  let callCount = 0;
  const provider: ModelProvider = {
    async chat() {
      callCount += 1;
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: `tool-${callCount}`,
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      };
    },
  };
  const { loop, eventStore } = createLoop(
    cwd,
    provider,
    async () => ({ content: "file contents" })
  );

  try {
    await assert.rejects(
      silenceConsole(() => loop.run(session, "Keep reading")),
      /Agent stopped after 300 iterations before producing a final response/
    );

    const events = await eventStore.getEvents(session.id);
    assert.equal(
      events.some((event) => event.type === "run.completed"),
      false
    );
    assert.equal(events.at(-1)?.type, "error");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run emits normalized stream-json model deltas before tool execution", async () => {
  const cwd = createTempDir();
  const session = createSession(cwd);
  let modelCalls = 0;
  const provider: ModelProvider = {
    async chat() {
      throw new Error("non-streaming chat should not be used");
    },
    async *streamChat() {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "assistant_text_delta", text: "Reading " };
        yield { type: "assistant_text_delta", text: "the file." };
        yield {
          type: "tool_call_delta",
          index: 0,
          id: "tool-1",
          name: "read_file",
          inputDelta: '{"path":"README.md"}',
        };
        yield {
          type: "response",
          response: {
            stopReason: "tool_use",
            content: [
              { type: "text", text: "Reading the file." },
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "README.md" },
              },
            ],
          },
        };
        return;
      }

      yield { type: "assistant_text_delta", text: "Done." };
      yield {
        type: "response",
        response: {
          stopReason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      };
    },
  };
  const { loop, eventStore, sessionStore } = createLoop(
    cwd,
    provider,
    async () => ({ content: "file contents" }),
    true
  );

  try {
    const { lines } = await captureConsole(() =>
      loop.run(session, "Read the README")
    );
    const streamEvents = lines.map((line) => JSON.parse(line) as { type: string });

    assert.deepEqual(
      streamEvents.map((event) => event.type),
      [
        "run.started",
        "assistant.text.delta",
        "assistant.text.delta",
        "tool.call.delta",
        "tool.call",
        "tool.result",
        "assistant.text.delta",
        "run.completed",
      ]
    );
    assert.deepEqual(JSON.parse(lines[3]), {
      type: "tool.call.delta",
      index: 0,
      id: "tool-1",
      name: "read_file",
      inputDelta: '{"path":"README.md"}',
    });

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.conversationItems, [
      { type: "message", role: "user", content: "Read the README" },
      {
        type: "message",
        role: "assistant",
        content: "Reading the file.",
        contentFormat: "block",
      },
      {
        type: "function_call",
        id: "tool-1",
        name: "read_file",
        input: { path: "README.md" },
      },
      {
        type: "function_output",
        callId: "tool-1",
        content: "file contents",
      },
      {
        type: "message",
        role: "assistant",
        content: "Done.",
        contentFormat: "block",
      },
    ]);

    const events = await eventStore.getEvents(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["user_message", "assistant_response", "assistant_response"]
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
