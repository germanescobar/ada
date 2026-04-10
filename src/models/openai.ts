import OpenAI from "openai";
import type { ChatParams, ModelProvider } from "./provider.js";
import type { ModelResponse } from "../types/agent.js";
import type { Message, ContentBlock } from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

export class OpenAIProvider implements ModelProvider {
  private client: OpenAI;
  private model: string;

  constructor(
    model: string,
    options?: { apiKey?: string; baseURL?: string }
  ) {
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed",
      baseURL: options?.baseURL,
    });
    this.model = model;
  }

  async chat(params: ChatParams): Promise<ModelResponse> {
    const messages = this.toOpenAIMessages(params.systemPrompt, params.messages);
    const tools = params.tools.map((t) => this.toOpenAITool(t));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
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
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
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
          input: JSON.parse(call.function.arguments) as Record<string, unknown>,
        });
      }
    }

    return blocks;
  }
}
