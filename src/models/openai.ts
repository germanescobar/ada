import OpenAI from "openai";
import type { ChatParams, ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelResponse, StopReason } from "../types/agent.js";
import { conversationItemsToMessages } from "../types/conversation.js";
import type {
  AttachmentContentBlock,
  ContentBlock,
  Message,
} from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

type OpenAIUserContentPart =
  | OpenAI.Chat.Completions.ChatCompletionContentPart
  | {
      type: "file";
      file: {
        filename: string;
        file_data: string;
      };
    };

interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  openRouter?: boolean;
}

type ChatCompletionRequestWithOpenRouterFields =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    session_id?: string;
  };

type ChatCompletionStreamRequestWithOpenRouterFields =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    session_id?: string;
  };

type OpenAIUsageWithCacheDetails = OpenAI.Completions.CompletionUsage & {
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
};

export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  private model: string;
  private maxTokens?: number;
  private openRouter: boolean;

  constructor(model: string, options?: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed",
      baseURL: options?.baseURL,
    });
    this.model = model;
    this.maxTokens = options?.maxTokens;
    this.openRouter = options?.openRouter ?? false;
  }

  async chat(params: ChatParams): Promise<ModelResponse> {
    const messages = this.toOpenAIMessages(
      params.systemPrompt,
      conversationItemsToMessages(params.conversationItems)
    );
    const tools = params.tools.map((t) => this.toOpenAITool(t));

    const request = this.withOpenRouterSessionId(
      {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        max_tokens: this.maxTokens,
      },
      params
    );
    const response = await this.client.chat.completions.create(request, {
      signal: params.signal,
    });

    const choice = response.choices[0];
    if (!choice) {
      return { stopReason: "error", content: [{ type: "text", text: "No response from model" }] };
    }

    const content = this.fromOpenAIMessage(choice.message);
    const stopReason =
      choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

    return {
      stopReason,
      content,
      reasoning: this.extractReasoning(choice.message),
      usage: response.usage
        ? this.mapUsage(response.usage as OpenAIUsageWithCacheDetails)
        : undefined,
    };
  }

  async *streamChat(params: ChatParams): AsyncIterable<ModelStreamEvent> {
    const messages = this.toOpenAIMessages(
      params.systemPrompt,
      conversationItemsToMessages(params.conversationItems)
    );
    const tools = params.tools.map((t) => this.toOpenAITool(t));

    const streamParams = this.withOpenRouterSessionId(
      {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        max_tokens: this.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      params
    );
    const stream = await this.createChatCompletionStream(streamParams, params.signal);

    let text = "";
    let reasoning = "";
    let stopReason: StopReason = "end_turn";
    let usage: ModelResponse["usage"] | undefined;
    const toolCalls = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = this.mapUsage(chunk.usage as OpenAIUsageWithCacheDetails);
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta.content) {
        text += delta.content;
        yield { type: "assistant_text_delta", text: delta.content };
      }

      const reasoningDelta = this.extractReasoningDelta(delta);
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        yield { type: "assistant_reasoning_delta", text: reasoningDelta };
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const existing = toolCalls.get(toolCall.index) ?? { arguments: "" };
        if (toolCall.id) existing.id = toolCall.id;
        if (toolCall.function?.name) existing.name = toolCall.function.name;
        if (toolCall.function?.arguments) {
          existing.arguments += toolCall.function.arguments;
        }
        toolCalls.set(toolCall.index, existing);

        yield {
          type: "tool_call_delta",
          index: toolCall.index,
          id: existing.id,
          name: existing.name,
          inputDelta: toolCall.function?.arguments,
        };
      }

      if (choice.finish_reason) {
        stopReason = this.mapFinishReason(choice.finish_reason);
      }
    }

    const content: ContentBlock[] = [];
    if (text) {
      content.push({ type: "text", text });
    }

    for (const [, toolCall] of [...toolCalls].sort(([left], [right]) => left - right)) {
      if (!toolCall.id || !toolCall.name) continue;
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: this.parseToolArguments(toolCall.arguments),
      });
    }

    yield {
      type: "response",
      response: {
        stopReason,
        content,
        reasoning: reasoning || undefined,
        usage,
      },
    };
  }

  private withOpenRouterSessionId<
    T extends
      | ChatCompletionRequestWithOpenRouterFields
      | ChatCompletionStreamRequestWithOpenRouterFields,
  >(
    request: T,
    params: ChatParams
  ): T {
    if (!this.openRouter || !params.sessionId) return request;
    if (params.sessionId.length > 256) {
      throw new Error("OpenRouter session_id must be at most 256 characters.");
    }
    return { ...request, session_id: params.sessionId };
  }

  private mapUsage(usage: OpenAIUsageWithCacheDetails): ModelResponse["usage"] {
    const result: NonNullable<ModelResponse["usage"]> = {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    };
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
    const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens;

    if (typeof cachedTokens === "number") {
      result.cachedTokens = cachedTokens;
    }
    if (typeof cacheWriteTokens === "number") {
      result.cacheWriteTokens = cacheWriteTokens;
    }

    return result;
  }

  private async createChatCompletionStream(
    params: ChatCompletionStreamRequestWithOpenRouterFields,
    signal?: AbortSignal
  ) {
    try {
      return await this.client.chat.completions.create(params, { signal });
    } catch (err) {
      if (!this.isUnsupportedStreamOptionsError(err)) {
        throw err;
      }

      const { stream_options: _streamOptions, ...fallbackParams } = params;
      return this.client.chat.completions.create(fallbackParams, { signal });
    }
  }

  private toOpenAIMessages(
    systemPrompt: string,
    messages: Message[]
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (msg.role === "assistant") {
        const textParts = msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("");

        const toolCalls = msg.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const block = b as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
            return {
              id: block.id,
              type: "function" as const,
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            };
          });

        // Some providers (e.g. Ollama OpenAI-compatible endpoints) reject
        // assistant messages with null/empty content and no tool calls.
        if (!textParts && toolCalls.length === 0) {
          continue;
        }

        result.push({
          role: "assistant",
          content: textParts || "",
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      } else {
        // User messages may contain tool_result and attachment blocks.
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const contentParts = msg.content.filter(
          (b) => b.type === "text" || b.type === "image" || b.type === "file"
        );

        for (const block of toolResults) {
          const tr = block as { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
          result.push({
            role: "tool",
            tool_call_id: tr.toolUseId,
            content: tr.content,
          });
        }

        if (contentParts.length > 0) {
          result.push({
            role: "user",
            content: this.toOpenAIUserContent(contentParts),
          });
        }
      }
    }

    return result;
  }

  private toOpenAITool(
    tool: ToolSchema
  ): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  private toOpenAIUserContent(
    blocks: Array<
      { type: "text"; text: string } | AttachmentContentBlock
    >
  ): string | OpenAIUserContentPart[] {
    if (blocks.every((block) => block.type === "text")) {
      return blocks.map((block) => block.text).join("\n");
    }

    return blocks.map((block): OpenAIUserContentPart => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "image":
          return {
            type: "image_url",
            image_url: {
              url: this.attachmentUrl(block),
            },
          };
        case "file":
          return {
            type: "file",
            file: {
              filename: block.name,
              file_data: this.attachmentUrl(block),
            },
          };
      }
    });
  }

  private attachmentUrl(block: AttachmentContentBlock): string {
    if (block.source.type === "url") return block.source.url;
    return `data:${block.source.mediaType};base64,${block.source.data}`;
  }

  private fromOpenAIMessage(
    message: OpenAI.Chat.Completions.ChatCompletionMessage
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (message.content) {
      blocks.push({ type: "text", text: message.content });
    }

    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: this.parseToolArguments(call.function.arguments),
        });
      }
    }

    return blocks;
  }

  private extractReasoning(
    message: OpenAI.Chat.Completions.ChatCompletionMessage
  ): string | undefined {
    const reasoningMessage = message as OpenAI.Chat.Completions.ChatCompletionMessage & {
      reasoning_content?: unknown;
      reasoning?: unknown;
    };

    const candidate = reasoningMessage.reasoning_content ?? reasoningMessage.reasoning;
    if (candidate == null) return undefined;
    if (typeof candidate === "string") return candidate;

    try {
      return JSON.stringify(candidate);
    } catch {
      return String(candidate);
    }
  }

  private extractReasoningDelta(
    delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta
  ): string | undefined {
    const reasoningDelta = delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
      reasoning_content?: unknown;
      reasoning?: unknown;
    };

    const candidate = reasoningDelta.reasoning_content ?? reasoningDelta.reasoning;
    if (candidate == null) return undefined;
    return typeof candidate === "string" ? candidate : String(candidate);
  }

  private mapFinishReason(
    finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"]
  ): StopReason {
    switch (finishReason) {
      case "tool_calls":
      case "function_call":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "error";
      default:
        return "end_turn";
    }
  }

  private parseToolArguments(inputJson: string): Record<string, unknown> {
    if (!inputJson) return {};

    try {
      const parsed = JSON.parse(inputJson);
      return this.isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private isUnsupportedStreamOptionsError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
      message.includes("stream_options") ||
      message.includes("include_usage")
    );
  }
}
