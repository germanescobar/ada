import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readFileTool } from "../src/tools/read-file.js";
import { runCommandTool } from "../src/tools/run-command.js";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ada-tool-results-"));
}

test("read_file returns bounded content and structured metadata", async () => {
  const cwd = createTempDir();
  const filePath = path.join(cwd, "sample.txt");

  try {
    writeFileSync(filePath, "one\ntwo\nthree\nfour\nfive", "utf-8");

    const result = await readFileTool.execute({
      path: filePath,
      start_line: 2,
      end_line: 4,
      max_chars: 7,
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.content, "two\nthr\n[truncated: output exceeded 7 characters]");
    assert.deepEqual(result.metadata, {
      path: filePath,
      bytes: 23,
      lineCount: 5,
      returnedBytes: 49,
      returnedLineStart: 2,
      returnedLineEnd: 3,
      truncated: true,
      maxChars: 7,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read_file validates invalid line ranges", async () => {
  const cwd = createTempDir();
  const filePath = path.join(cwd, "sample.txt");

  try {
    writeFileSync(filePath, "one\ntwo", "utf-8");

    const result = await readFileTool.execute({
      path: filePath,
      start_line: 3,
      end_line: 2,
    });

    assert.equal(result.isError, true);
    assert.equal(
      result.content,
      "Error reading file: end_line must be greater than or equal to start_line."
    );
    assert.deepEqual(result.metadata, {
      path: filePath,
      requestedStartLine: 3,
      requestedEndLine: 2,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run_command returns exit and output metadata", async () => {
  const result = await runCommandTool.execute({
    command: "printf 'hello\\nworld\\n'",
  });

  assert.equal(result.content, "hello\nworld\n");
  assert.equal(result.isError, false);
  assert.equal(result.metadata?.exitCode, 0);
  assert.equal(result.metadata?.timedOut, false);
  assert.equal(result.metadata?.truncated, false);
  assert.equal(result.metadata?.bytes, 12);
  assert.equal(result.metadata?.lineCount, 3);
  assert.equal(result.metadata?.stdoutBytes, 12);
  assert.equal(result.metadata?.stderrBytes, 0);
  assert.equal(result.metadata?.timeoutMs, 30_000);
});

test("run_command reports signal termination without an exit code", async () => {
  const result = await runCommandTool.execute({
    command: "node -e \"process.kill(process.pid, 15)\"",
  });

  assert.equal(result.isError, true);
  assert.match(result.content, /\[signal: SIGTERM\]/);
  assert.equal(result.metadata?.exitCode, null);
  assert.equal(result.metadata?.signal, "SIGTERM");
  assert.equal(result.metadata?.timedOut, false);
});
