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
import type { ToolResult } from "../src/types/tools.js";

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
  executeTool: () => Promise<ToolResult> = async () => ({
    content: "unused",
  })
): { loop: AgentLoop; eventStore: EventStore; sessionStore: SessionStore } {
  const eventStore = new EventStore(path.join(cwd, "events"));
  const sessionStore = new SessionStore(path.join(cwd, "sessions"));
  const executor = {
    executeTool: async () => executeTool(),
  };

  return {
    loop: new AgentLoop(
      provider,
      executor as unknown as Executor,
      new ContextBuilder(cwd),
      new ToolRegistry(),
      eventStore,
      sessionStore
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
    })
  );

  try {
    await assert.rejects(
      silenceConsole(() => loop.run(session, "Read the README")),
      /second model call failed/
    );

    const saved = await sessionStore.load(session.id);
    assert.ok(saved);
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
