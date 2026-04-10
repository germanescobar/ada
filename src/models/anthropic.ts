import Anthropic from "@anthropic-ai/sdk";
import type { ChatParams, ModelProvider } from "./provider.js";
import type { ModelResponse } from "../types/agent.js";
import type { Message, ContentBlock } from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  private model: string;

  constructor(model: string, options?: { apiKey?: string }) {
    this.client = new Anthropic({ apiKey: options?.apiKey });
    this.model = model;
  }

  async chat(params: ChatParams): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16384,
      system: params.systemPrompt,
      messages: params.messages.map((m) => this.toAnthropicMessage(m)),
      tools: params.tools.map((t) => this.toAnthropicTool(t)),
    });

    return {
      stopReason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      content: response.content.map((block) => this.fromAnthropicBlock(block)),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
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
}
