import assert from "node:assert/strict";
import test from "node:test";

import { serializeError } from "../src/errors.js";

test("serializeError extracts plain-text API error bodies from SDK messages", () => {
  const err = Object.assign(
    new Error('500 "Internal Server Error (ref: abc-123)"'),
    {
      status: 500,
      request_id: "req_123",
    }
  );

  assert.deepEqual(serializeError(err), {
    message: '500 "Internal Server Error (ref: abc-123)"',
    name: "Error",
    status: 500,
    requestId: "req_123",
    body: "Internal Server Error (ref: abc-123)",
  });
});

test("serializeError preserves JSON API error bodies", () => {
  const err = Object.assign(new Error("500 server_error"), {
    status: 500,
    error: {
      message: "server_error",
      ref: "abc-123",
    },
    code: "server_error",
    type: "internal_server_error",
    param: null,
  });

  assert.deepEqual(serializeError(err), {
    message: "500 server_error",
    name: "Error",
    status: 500,
    code: "server_error",
    type: "internal_server_error",
    param: null,
    body: {
      message: "server_error",
      ref: "abc-123",
    },
  });
});
