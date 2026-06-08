import assert from "node:assert/strict";
import test from "node:test";

import type { ContentBlock, Message } from "../src/types/messages.js";
import type { ToolSchema } from "../src/types/tools.js";
import {
  conversationItemsToInputItems,
  messagesToInputItems,
  toFunctionTool,
  responseToModelResponse,
  mapStopReason,
} from "../src/models/openai-responses.js";

// ─── messagesToInputItems ────────────────────────────────────────────────

test("messagesToInputItems converts a simple user text message", () => {
  const messages: Message[] = [
    { role: "user", content: "Hello, how are you?" },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "message",
    role: "user",
    content: "Hello, how are you?",
  });
});

test("messagesToInputItems converts an assistant text message", () => {
  const messages: Message[] = [
    { role: "assistant", content: "I am doing well!" },
  ];

  const items = messagesToInputItems(messages);

  // String assistant content is passed through as-is (the API accepts it).
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "message",
    role: "assistant",
    content: "I am doing well!",
  });
});

test("messagesToInputItems converts content blocks with text", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Read the file" }],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Read the file" }],
  });
});

test("messagesToInputItems emits output_text for assistant content blocks", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Here is the result." }],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Here is the result.", annotations: [] }],
  });
});

test("messagesToInputItems converts assistant tool_use blocks to function_call items", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_abc123",
          name: "read_file",
          input: { path: "/tmp/test.txt" },
        },
      ],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "function_call",
    call_id: "call_abc123",
    name: "read_file",
    arguments: JSON.stringify({ path: "/tmp/test.txt" }),
  });
});

test("messagesToInputItems converts user tool_result blocks to function_call_output items", () => {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_abc123",
          content: "file contents here",
          isError: false,
        },
      ],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    type: "function_call_output",
    call_id: "call_abc123",
    output: "file contents here",
  });
});

test("messagesToInputItems splits mixed content blocks into separate items", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me read that file." },
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        },
      ],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Let me read that file.", annotations: [] }],
  });
  assert.deepEqual(items[1], {
    type: "function_call",
    call_id: "call_1",
    name: "read_file",
    arguments: JSON.stringify({ path: "README.md" }),
  });
});

test("messagesToInputItems handles a full multi-turn conversation", () => {
  const messages: Message[] = [
    { role: "user", content: "Create a hello world script" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Sure, I'll create it." },
        {
          type: "tool_use",
          id: "call_1",
          name: "write_file",
          input: { path: "hello.js", content: 'console.log("hello");' },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call_1",
          content: "File written successfully.",
          isError: false,
        },
      ],
    },
  ];

  const items = messagesToInputItems(messages);

  assert.equal(items.length, 4);
  assert.deepEqual(items[0], {
    type: "message",
    role: "user",
    content: "Create a hello world script",
  });
  assert.deepEqual(items[1], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Sure, I'll create it.", annotations: [] }],
  });
  assert.deepEqual(items[2], {
    type: "function_call",
    call_id: "call_1",
    name: "write_file",
    arguments: JSON.stringify({ path: "hello.js", content: 'console.log("hello");' }),
  });
  assert.deepEqual(items[3], {
    type: "function_call_output",
    call_id: "call_1",
    output: "File written successfully.",
  });
});

test("messagesToInputItems skips assistant messages with only tool_use and no text", () => {
  const messages: Message[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "read_file",
          input: { path: "test.txt" },
        },
      ],
    },
  ];

  const items = messagesToInputItems(messages);

  // Only the function_call item, no message item (no text content).
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "function_call");
});

test("conversationItemsToInputItems preserves reasoning and function-call identities", () => {
  const items = conversationItemsToInputItems([
    {
      type: "reasoning",
      id: "rs_123",
      summary: "I should inspect the file.",
      encryptedContent: "encrypted",
    },
    {
      type: "function_call",
      id: "call_1",
      name: "read_file",
      input: { path: "README.md" },
    },
    {
      type: "function_output",
      callId: "call_1",
      content: "contents",
    },
  ]);

  assert.deepEqual(items, [
    {
      type: "reasoning",
      id: "rs_123",
      summary: [{ type: "summary_text", text: "I should inspect the file." }],
      encrypted_content: "encrypted",
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: JSON.stringify({ path: "README.md" }),
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: "contents",
    },
  ]);
});

test("conversationItemsToInputItems preserves empty reasoning items", () => {
  const items = conversationItemsToInputItems([
    {
      type: "reasoning",
      id: "rs_empty",
      summary: "",
    },
  ]);

  assert.deepEqual(items, [
    {
      type: "reasoning",
      id: "rs_empty",
      summary: [],
    },
  ]);
});

test("conversationItemsToInputItems emits file_url for URL-backed file attachments", () => {
  const items = conversationItemsToInputItems([
    {
      type: "attachment",
      role: "user",
      attachment: {
        type: "file",
        name: "brief.pdf",
        mediaType: "application/pdf",
        source: {
          type: "url",
          url: "https://example.com/brief.pdf",
        },
      },
    },
  ]);

  assert.deepEqual(items, [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_file",
          filename: "brief.pdf",
          file_url: "https://example.com/brief.pdf",
        },
      ],
    },
  ]);
});

test("conversationItemsToInputItems emits file_data for local file attachments", () => {
  const items = conversationItemsToInputItems([
    {
      type: "attachment",
      role: "user",
      attachment: {
        type: "file",
        name: "brief.pdf",
        mediaType: "application/pdf",
        source: {
          type: "data",
          mediaType: "application/pdf",
          data: "cGRm",
        },
      },
    },
  ]);

  assert.deepEqual(items, [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_file",
          filename: "brief.pdf",
          file_data: "data:application/pdf;base64,cGRm",
        },
      ],
    },
  ]);
});

// ─── toFunctionTool ──────────────────────────────────────────────────────

test("toFunctionTool converts a ToolSchema to a Responses API function tool", () => {
  const schema: ToolSchema = {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  };

  const tool = toFunctionTool(schema);

  assert.deepEqual(tool, {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    strict: false,
  });
});

test("toFunctionTool omits description when undefined", () => {
  const schema: ToolSchema = {
    name: "run_command",
    description: "",
    parameters: { type: "object", properties: {} },
  };

  const tool = toFunctionTool(schema);

  assert.equal(tool.description, undefined);
});

// ─── responseToModelResponse ─────────────────────────────────────────────

function makeResponse(overrides: Partial<OpenAI.Responses.Response> = {}): OpenAI.Responses.Response {
  return {
    id: "resp_test",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "gpt-4",
    output: [],
    status: "completed",
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...overrides,
  } as OpenAI.Responses.Response;
}

import type OpenAI from "openai";

test("responseToModelResponse extracts text from a completed message output", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Hello!", annotations: [] },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.content, [{ type: "text", text: "Hello!" }]);
  assert.equal(result.reasoning, undefined);
});

test("responseToModelResponse extracts function_call items as tool_use blocks", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_abc",
        name: "read_file",
        arguments: JSON.stringify({ path: "/tmp/test.txt" }),
      } as OpenAI.Responses.ResponseFunctionToolCall,
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.content, [
    {
      type: "tool_use",
      id: "call_abc",
      name: "read_file",
      input: { path: "/tmp/test.txt" },
    },
  ]);
});

test("responseToModelResponse extracts reasoning summaries", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [
          { type: "summary_text", text: "I should read the file first." },
        ],
      } as OpenAI.Responses.ResponseReasoningItem,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Let me check.", annotations: [] },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.reasoning, "I should read the file first.");
  assert.deepEqual(result.reasoningItems, [
    {
      type: "reasoning",
      id: "rs_1",
      summary: "I should read the file first.",
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "Let me check." }]);
});

test("responseToModelResponse concatenates multiple reasoning summaries", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [
          { type: "summary_text", text: "Step 1." },
          { type: "summary_text", text: "Step 2." },
        ],
      } as OpenAI.Responses.ResponseReasoningItem,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Done.", annotations: [] },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.reasoning, "Step 1.\nStep 2.");
});

test("responseToModelResponse preserves empty reasoning items", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
      } as OpenAI.Responses.ResponseReasoningItem,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Ok", annotations: [] },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.reasoning, undefined);
  assert.deepEqual(result.reasoningItems, [
    {
      type: "reasoning",
      id: "rs_1",
      summary: "",
    },
  ]);
});

test("responseToModelResponse extracts usage information", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Hi", annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 10 },
    },
  });

  const result = responseToModelResponse(response);

  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
});

test("responseToModelResponse returns undefined usage when not present", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Hi", annotations: [] },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.usage, undefined);
});

test("responseToModelResponse skips refusal content parts", () => {
  const response = makeResponse({
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "refusal", refusal: "I cannot do that." },
        ],
      },
    ],
  });

  const result = responseToModelResponse(response);

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(result.content, []);
});

// ─── mapStopReason ───────────────────────────────────────────────────────

test("mapStopReason returns tool_use when content has tool_use blocks", () => {
  const response = makeResponse({ status: "completed" });
  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "test.txt" },
    },
  ];

  assert.equal(mapStopReason(response, content), "tool_use");
});

test("mapStopReason returns end_turn for completed responses with no tool use", () => {
  const response = makeResponse({ status: "completed" });
  const content: ContentBlock[] = [{ type: "text", text: "Done!" }];

  assert.equal(mapStopReason(response, content), "end_turn");
});

test("mapStopReason returns max_tokens for incomplete responses with max_output_tokens reason", () => {
  const response = makeResponse({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  });

  assert.equal(mapStopReason(response, []), "max_tokens");
});

test("mapStopReason returns error for incomplete responses with other reasons", () => {
  const response = makeResponse({
    status: "incomplete",
    incomplete_details: { reason: "content_policy" },
  });

  assert.equal(mapStopReason(response, []), "error");
});

test("mapStopReason returns error for failed responses", () => {
  const response = makeResponse({ status: "failed" });

  assert.equal(mapStopReason(response, []), "error");
});

test("responseToModelResponse normalizes non-object function_call arguments to empty input", () => {
  const cases: Array<{ arguments: string; label: string }> = [
    { arguments: "null", label: "JSON null" },
    { arguments: "[]", label: "JSON array" },
    { arguments: "", label: "empty string" },
    { arguments: "{not valid json", label: "invalid JSON" },
  ];

  for (const { arguments: args, label } of cases) {
    const response = makeResponse({
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "run_command",
          arguments: args,
        } as OpenAI.Responses.ResponseFunctionToolCall,
      ],
    });

    const result = responseToModelResponse(response);

    assert.equal(result.stopReason, "tool_use", `stopReason for ${label}`);
    assert.deepEqual(
      result.content,
      [
        {
          type: "tool_use",
          id: "call_abc",
          name: "run_command",
          input: {},
        },
      ],
      `content for ${label}`
    );
  }
});
