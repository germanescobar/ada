import Anthropic from "@anthropic-ai/sdk";
import type { ChatParams, ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelResponse, StopReason } from "../types/agent.js";
import { conversationItemsToMessages } from "../types/conversation.js";
import type { Message, ContentBlock } from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string) {
    this.client = new Anthropic();
    this.model = model;
  }

  async chat(params: ChatParams): Promise<ModelResponse> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16384,
        system: params.systemPrompt,
        messages: conversationItemsToMessages(params.conversationItems).map((m) =>
          this.toAnthropicMessage(m)
        ),
        tools: params.tools.map((t) => this.toAnthropicTool(t)),
      },
      { signal: params.signal }
    );

    return {
      stopReason: this.mapStopReason(response.stop_reason),
      content: response.content.map((block) => this.fromAnthropicBlock(block)),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async *streamChat(params: ChatParams): AsyncIterable<ModelStreamEvent> {
    const stream = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16384,
        system: params.systemPrompt,
        messages: conversationItemsToMessages(params.conversationItems).map((m) =>
          this.toAnthropicMessage(m)
        ),
        tools: params.tools.map((t) => this.toAnthropicTool(t)),
        stream: true,
      },
      { signal: params.signal }
    );

    const blocks = new Map<
      number,
      | { type: "text"; text: string }
      | {
          type: "tool_use";
          id: string;
          name: string;
          input: Record<string, unknown>;
          inputJson: string;
        }
    >();
    let stopReason: StopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      switch (event.type) {
        case "message_start":
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          break;
        case "message_delta":
          stopReason = this.mapStopReason(event.delta.stop_reason);
          outputTokens = event.usage.output_tokens;
          break;
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "text") {
            blocks.set(event.index, { type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            blocks.set(event.index, {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
              inputJson: "",
            });
            yield {
              type: "tool_call_delta",
              index: event.index,
              id: block.id,
              name: block.name,
            };
          }
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(event.index);
          if (event.delta.type === "text_delta" && block?.type === "text") {
            block.text += event.delta.text;
            yield { type: "assistant_text_delta", text: event.delta.text };
          } else if (
            event.delta.type === "input_json_delta" &&
            block?.type === "tool_use"
          ) {
            block.inputJson += event.delta.partial_json;
            yield {
              type: "tool_call_delta",
              index: event.index,
              id: block.id,
              name: block.name,
              inputDelta: event.delta.partial_json,
            };
          }
          break;
        }
      }
    }

    const content: ContentBlock[] = [];
    for (const [, block] of [...blocks].sort(([left], [right]) => left - right)) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
        continue;
      }

      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: this.parseToolInput(block.inputJson, block.input),
      });
    }

    yield {
      type: "response",
      response: {
        stopReason,
        content,
        usage: {
          inputTokens,
          outputTokens,
        },
      },
    };
  }

  private toAnthropicMessage(
    msg: Message
  ): Anthropic.Messages.MessageParam {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }

    return {
      role: msg.role,
      content: msg.content.map((block) => {
        switch (block.type) {
          case "text":
            return { type: "text" as const, text: block.text };
          case "image":
          case "file":
            throw new Error(
              "AnthropicProvider does not support Ada attachment blocks yet."
            );
          case "tool_use":
            return {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: block.input,
            };
          case "tool_result":
            return {
              type: "tool_result" as const,
              tool_use_id: block.toolUseId,
              content: block.content,
              is_error: block.isError,
            };
        }
      }),
    };
  }

  private toAnthropicTool(tool: ToolSchema): Anthropic.Messages.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Messages.Tool["input_schema"],
    };
  }

  private fromAnthropicBlock(
    block: Anthropic.Messages.ContentBlock
  ): ContentBlock {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
      default:
        return { type: "text", text: JSON.stringify(block) };
    }
  }

  private mapStopReason(
    stopReason: Anthropic.Messages.Message["stop_reason"]
  ): StopReason {
    switch (stopReason) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }

  private parseToolInput(
    inputJson: string,
    fallback: Record<string, unknown>
  ): Record<string, unknown> {
    if (!inputJson) return fallback;

    try {
      const parsed = JSON.parse(inputJson);
      return this.isRecord(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
