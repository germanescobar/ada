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

function createTextChunk(text: string): ChatCompletionChunk {
  return {
    id: "chunk-1",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
}

function createUsageChunk(): ChatCompletionChunk {
  return {
    id: "chunk-usage",
    created: 1,
    model: "test-model",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    },
  };
}

function createCompletion(): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "completion-1",
    created: 1,
    model: "test-model",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
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

test("OpenAIProvider.streamChat requests and preserves stream usage", async () => {
  const provider = new OpenAIProvider("test-model", { maxTokens: 8192 });
  const calls: StreamingParams[] = [];

  setClient(provider, {
    chat: {
      completions: {
        async create(params: StreamingParams | NonStreamingParams) {
          calls.push(params as StreamingParams);
          return streamChunks([createTextChunk("Hello"), createUsageChunk()]);
        },
      },
    },
  });

  const events = [];
  for await (const event of provider.streamChat(createParams())) {
    events.push(event);
  }

  assert.deepEqual(calls.map((call) => call.stream_options), [
    { include_usage: true },
  ]);
  assert.deepEqual(calls.map((call) => call.max_tokens), [8192]);
  assert.deepEqual(events.at(-1), {
    type: "response",
    response: {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello" }],
      reasoning: undefined,
      usage: { inputTokens: 12, outputTokens: 4 },
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
