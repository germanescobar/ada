import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/storage/session-store.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ada-session-store-"));
}

test("load migrates legacy message-only sessions to conversation items", async () => {
  const cwd = createTempDir();
  const sessionId = "legacy-session";
  const now = new Date().toISOString();

  try {
    writeFileSync(
      path.join(cwd, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        workingDirectory: cwd,
        model: "test/model",
        messages: [
          { role: "user", content: "Read the file" },
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
        ],
        createdAt: now,
        lastActiveAt: now,
        status: "active",
      })
    );

    const session = await new SessionStore(cwd).load(sessionId);

    assert.ok(session);
    assert.deepEqual(session.conversationItems, [
      {
        type: "message",
        role: "user",
        content: "Read the file",
        contentFormat: "string",
      },
      {
        type: "function_call",
        id: "tool-1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
