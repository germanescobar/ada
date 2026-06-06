import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAttachments } from "../src/attachments.js";

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ada-attachments-"));
}

test("loadAttachments encodes local images and PDFs", async () => {
  const cwd = tmpDir();
  writeFileSync(path.join(cwd, "screen.png"), "png bytes");
  writeFileSync(path.join(cwd, "doc.pdf"), "pdf bytes");

  const attachments = await loadAttachments(
    ["screen.png", "doc.pdf"],
    { attachments: { images: true, files: true } },
    cwd
  );

  assert.deepEqual(attachments, [
    {
      type: "image",
      name: "screen.png",
      source: {
        type: "data",
        mediaType: "image/png",
        data: Buffer.from("png bytes").toString("base64"),
      },
    },
    {
      type: "file",
      name: "doc.pdf",
      mediaType: "application/pdf",
      source: {
        type: "data",
        mediaType: "application/pdf",
        data: Buffer.from("pdf bytes").toString("base64"),
      },
    },
  ]);
});

test("loadAttachments rejects unsupported attachment capabilities", async () => {
  const cwd = tmpDir();
  writeFileSync(path.join(cwd, "screen.png"), "png bytes");

  await assert.rejects(
    loadAttachments(
      ["screen.png"],
      { attachments: { images: false, files: true } },
      cwd
    ),
    /does not support image attachments/
  );
});
