import OpenAI from "openai";
import type { ChatParams, ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelResponse, StopReason } from "../types/agent.js";
import { conversationItemsToMessages } from "../types/conversation.js";
import type { Message, ContentBlock } from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  private model: string;
  private maxTokens?: number;

  constructor(
    model: string,
    options?: { apiKey?: string; baseURL?: string; maxTokens?: number }
  ) {
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed",
      baseURL: options?.baseURL,
    });
    this.model = model;
    this.maxTokens = options?.maxTokens;
  }

  async chat(params: ChatParams): Promise<ModelResponse> {
    const messages = this.toOpenAIMessages(
      params.systemPrompt,
      conversationItemsToMessages(params.conversationItems)
    );
    const tools = params.tools.map((t) => this.toOpenAITool(t));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: this.maxTokens,
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
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async *streamChat(params: ChatParams): AsyncIterable<ModelStreamEvent> {
    const messages = this.toOpenAIMessages(
      params.systemPrompt,
      conversationItemsToMessages(params.conversationItems)
    );
    const tools = params.tools.map((t) => this.toOpenAITool(t));

    const streamParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      max_tokens: this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    const stream = await this.createChatCompletionStream(streamParams);

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
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
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

  private async createChatCompletionStream(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
  ) {
    try {
      return await this.client.chat.completions.create(params);
    } catch (err) {
      if (!this.isUnsupportedStreamOptionsError(err)) {
        throw err;
      }

      const { stream_options: _streamOptions, ...fallbackParams } = params;
      return this.client.chat.completions.create(fallbackParams);
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
        // User messages may contain tool_result blocks
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        const textParts = msg.content.filter((b) => b.type === "text");

        for (const block of toolResults) {
          const tr = block as { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };
          result.push({
            role: "tool",
            tool_call_id: tr.toolUseId,
            content: tr.content,
          });
        }

        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts
              .map((b) => (b as { type: "text"; text: string }).text)
              .join("\n"),
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
