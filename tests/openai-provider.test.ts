import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";
import { OpenAIProvider } from "../src/models/openai.js";
import type { ChatParams } from "../src/models/provider.js";

type StreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type NonStreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type UsageWithCacheDetails = OpenAI.Completions.CompletionUsage & {
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

interface FakeOpenAIClient {
  chat: {
    completions: {
      create(params: StreamingParams): Promise<AsyncIterable<ChatCompletionChunk>>;
      create(params: NonStreamingParams): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

function createParams(): ChatParams {
  return {
    systemPrompt: "You are helpful.",
    conversationItems: [
      {
        type: "message",
        role: "user",
        content: "Hello",
      },
    ],
    tools: [],
  };
}

async function* streamChunks(
  chunks: ChatCompletionChunk[]
): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function createTextChunk(
  text: string,
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null
): ChatCompletionChunk {
  return {
    id: "chunk-1",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: finishReason,
      },
    ],
  };
}

function createUsageChunk(usage?: UsageWithCacheDetails): ChatCompletionChunk {
  return {
    id: "chunk-usage",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [],
    usage: usage ?? {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    },
  };
}

function createCompletion(
  usage?: UsageWithCacheDetails,
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] = "stop"
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "completion-1",
    created: 1,
    model: "test-model",
    object: "chat.completion",
    usage,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content: "Done",
          refusal: null,
        },
      },
    ],
  };
}

function setClient(provider: OpenAIProvider, client: FakeOpenAIClient): void {
  (
    provider as unknown as {
      client: FakeOpenAIClient;
    }
  ).client = client;
}

test("OpenAIProvider.chat sends configured max_tokens", async () => {
  const provider = new OpenAIProvider("test-model", { maxTokens: 8192 });
  const calls: NonStreamingParams[] = [];

  setClient(provider, {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as NonStreamingParams);
          return createCompletion();
        },
      },
    },
  });

  await provider.chat(createParams());

  assert.equal(calls[0]?.max_tokens, 8192);
});

test("OpenAIProvider.chat sends session_id only when configured for OpenRouter", async () => {
  const openRouterProvider = new OpenAIProvider("test-model", {
    openRouter: true,
  });
  const genericProvider = new OpenAIProvider("test-model");
  const calls: NonStreamingParams[] = [];
  const client: FakeOpenAIClient = {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as NonStreamingParams);
          return createCompletion();
        },
      },
    },
  };

  setClient(openRouterProvider, client);
  setClient(genericProvider, client);

  await openRouterProvider.chat({
    ...createParams(),
    sessionId: "session-123",
  });
  await genericProvider.chat({
    ...createParams(),
    sessionId: "session-123",
  });

  assert.equal(
    (calls[0] as NonStreamingParams & { session_id?: string }).session_id,
    "session-123"
  );
  assert.equal(
    (calls[1] as NonStreamingParams & { session_id?: string }).session_id,
    undefined
  );
});

test("OpenAIProvider.chat rejects OpenRouter session_id longer than 256 characters", async () => {
  const provider = new OpenAIProvider("test-model", { openRouter: true });

  await assert.rejects(
    () =>
      provider.chat({
        ...createParams(),
        sessionId: "a".repeat(257),
      }),
    /OpenRouter session_id must be at most 256 characters/
  );
});

test("OpenAIProvider.chat preserves cache usage details", async () => {
  const provider = new OpenAIProvider("test-model");

  setClient(provider, {
    chat: {
      completions: {
        async create() {
          return createCompletion({
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            prompt_tokens_details: {
              cached_tokens: 100,
              cache_write_tokens: 20,
            },
          });
        },
      },
    },
  });

  const response = await provider.chat(createParams());

  assert.deepEqual(response.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cachedTokens: 100,
    cacheWriteTokens: 20,
  });
});

test("OpenAIProvider.chat maps length finish_reason to max_tokens and preserves provider reason", async () => {
  const provider = new OpenAIProvider("test-model");

  setClient(provider, {
    chat: {
      completions: {
        async create() {
          return createCompletion(
            {
              prompt_tokens: 100,
              completion_tokens: 8192,
              total_tokens: 8292,
            },
            "length"
          );
        },
      },
    },
  });

  const response = await provider.chat(createParams());

  assert.equal(response.stopReason, "max_tokens");
  assert.equal(response.providerStopReason, "length");
  assert.deepEqual(response.usage, {
    inputTokens: 100,
    outputTokens: 8192,
  });
});

test("OpenAIProvider.chat sends image and PDF attachments as multimodal parts", async () => {
  const provider = new OpenAIProvider("test-model");
  const calls: NonStreamingParams[] = [];

  setClient(provider, {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as NonStreamingParams);
          return createCompletion();
        },
      },
    },
  });

  await provider.chat({
    systemPrompt: "You are helpful.",
    conversationItems: [
      {
        type: "message",
        role: "user",
        content: "Compare these.",
        contentFormat: "block",
      },
      {
        type: "attachment",
        role: "user",
        attachment: {
          type: "image",
          name: "screen.png",
          source: {
            type: "data",
            mediaType: "image/png",
            data: "aW1hZ2U=",
          },
        },
      },
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
    ],
    tools: [],
  });

  assert.deepEqual(calls[0]?.messages[1], {
    role: "user",
    content: [
      { type: "text", text: "Compare these." },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,aW1hZ2U=",
        },
      },
      {
        type: "file",
        file: {
          filename: "brief.pdf",
          file_data: "data:application/pdf;base64,cGRm",
        },
      },
    ],
  });
});


test("OpenAIProvider.streamChat requests and preserves stream usage", async () => {
  const provider = new OpenAIProvider("test-model", {
    maxTokens: 8192,
    openRouter: true,
  });
  const calls: StreamingParams[] = [];

  setClient(provider, {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as StreamingParams);
          return streamChunks([
            createTextChunk("Hello"),
            createUsageChunk({
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
              prompt_tokens_details: {
                cached_tokens: 8,
                cache_write_tokens: 2,
              },
            }),
          ]);
        },
      },
    },
  });

  const events = [];
  for await (const event of provider.streamChat({
    ...createParams(),
    sessionId: "stream-session",
  })) {
    events.push(event);
  }

  assert.deepEqual(calls.map((call) => call.stream_options), [
    { include_usage: true },
  ]);
  assert.deepEqual(calls.map((call) => call.max_tokens), [8192]);
  assert.equal(
    (calls[0] as StreamingParams & { session_id?: string }).session_id,
    "stream-session"
  );
  assert.deepEqual(events.at(-1), {
    type: "response",
    response: {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
      reasoning: undefined,
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cachedTokens: 8,
        cacheWriteTokens: 2,
      },
    },
  });
});

test("OpenAIProvider.streamChat preserves provider finish reason", async () => {
  const provider = new OpenAIProvider("test-model");

  setClient(provider, {
    chat: {
      completions: {
        async create() {
          return streamChunks([createTextChunk("Too long", "length")]);
        },
      },
    },
  });

  const events = [];
  for await (const event of provider.streamChat(createParams())) {
    events.push(event);
  }

  assert.deepEqual(events.at(-1), {
    type: "response",
    response: {
      stopReason: "max_tokens",
      providerStopReason: "length",
      content: [{ type: "text", text: "Too long" }],
      reasoning: undefined,
      usage: undefined,
    },
  });
});

test("OpenAIProvider.streamChat retries without stream_options when unsupported", async () => {
  const provider = new OpenAIProvider("test-model", { maxTokens: 8192 });
  const calls: StreamingParams[] = [];

  setClient(provider, {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as StreamingParams);
          if ((params as StreamingParams).stream_options) {
            throw new Error("Unsupported parameter: stream_options");
          }
          return streamChunks([createTextChunk("Hello")]);
        },
      },
    },
  });

  const events = [];
  for await (const event of provider.streamChat(createParams())) {
    events.push(event);
  }

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.stream_options, { include_usage: true });
  assert.equal(calls[1]?.stream_options, undefined);
  assert.deepEqual(calls.map((call) => call.max_tokens), [8192, 8192]);
  assert.deepEqual(events.at(-1), {
    type: "response",
    response: {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
      reasoning: undefined,
      usage: undefined,
    },
  });
});

test("OpenAIProvider.chat normalizes non-object tool_call arguments to empty input", async () => {
  const cases: Array<{ arguments: string; label: string }> = [
    { arguments: "null", label: "JSON null" },
    { arguments: "[]", label: "JSON array" },
    { arguments: "", label: "empty string" },
    { arguments: "{not valid json", label: "invalid JSON" },
  ];

  for (const { arguments: args, label } of cases) {
    const provider = new OpenAIProvider("test-model");
    const completion: OpenAI.Chat.Completions.ChatCompletion = {
      id: "completion-1",
      created: 1,
      model: "test-model",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          logprobs: null,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "run_command",
                  arguments: args,
                },
              },
            ],
          },
        },
      ],
    };

    setClient(provider, {
      chat: {
        completions: {
          async create() {
            return completion;
          },
        },
      },
    });

    const result = await provider.chat(createParams());

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

test("OpenAIProvider.chat converts deprecated function_call completions to tool use", async () => {
  const provider = new OpenAIProvider("test-model");
  const completion: OpenAI.Chat.Completions.ChatCompletion = {
    id: "completion-1",
    created: 1,
    model: "test-model",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "function_call",
        logprobs: null,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          function_call: {
            name: "run_command",
            arguments: '{"command":"git status"}',
          },
        } as OpenAI.Chat.Completions.ChatCompletionMessage,
      },
    ],
  };

  setClient(provider, {
    chat: {
      completions: {
        async create() {
          return completion;
        },
      },
    },
  });

  const result = await provider.chat(createParams());

  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.providerStopReason, "function_call");
  assert.deepEqual(result.content, [
    {
      type: "tool_use",
      id: "legacy_function_call",
      name: "run_command",
      input: { command: "git status" },
    },
  ]);
});
