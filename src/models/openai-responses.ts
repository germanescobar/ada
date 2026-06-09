import OpenAI from "openai";
import type { ChatParams, ModelProvider, ModelStreamEvent } from "./provider.js";
import type { ModelResponse, StopReason } from "../types/agent.js";
import {
  type ConversationItem,
  type ConversationReasoningItem,
} from "../types/conversation.js";
import type {
  AttachmentContentBlock,
  ContentBlock,
  Message,
} from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";

/**
 * Provider that uses the OpenAI Responses API instead of Chat Completions.
 *
 * The Responses API uses a conversation-item model where inputs and outputs are
 * represented as typed items (messages, function calls, function call outputs,
 * reasoning items).  This provider converts our internal message format into
 * Responses API input items and converts the response output items back into
 * our internal ContentBlock format.
 *
 * Key differences from Chat Completions:
 * - The system prompt is passed as `instructions`, not a system message.
 * - Function calls use `call_id` / `type: "function_call"`.
 * - Function call outputs use `type: "function_call_output"`.
 * - Reasoning summaries are explicit output items.
 * - The overall response has a `status` field instead of `finish_reason`.
 */
export class OpenAIResponsesProvider implements ModelProvider {
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
    const inputItems = conversationItemsToInputItems(params.conversationItems);
    const tools = params.tools.map(toFunctionTool);

    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions: params.systemPrompt,
        input: inputItems,
        tools: tools.length > 0 ? tools : undefined,
      },
      { signal: params.signal }
    );

    return responseToModelResponse(response);
  }

  async *streamChat(params: ChatParams): AsyncIterable<ModelStreamEvent> {
    const inputItems = conversationItemsToInputItems(params.conversationItems);
    const tools = params.tools.map(toFunctionTool);

    const stream = await this.client.responses.create(
      {
        model: this.model,
        instructions: params.systemPrompt,
        input: inputItems,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      },
      { signal: params.signal }
    );

    let response: OpenAI.Responses.Response | undefined;
    const toolCalls = new Map<
      number,
      { id?: string; name?: string; itemId?: string }
    >();

    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "assistant_text_delta", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          yield { type: "assistant_reasoning_delta", text: event.delta };
          break;
        case "response.reasoning_summary.delta":
          if (typeof event.delta === "string") {
            yield { type: "assistant_reasoning_delta", text: event.delta };
          }
          break;
        case "response.output_item.added":
        case "response.output_item.done":
          if (event.item.type === "function_call") {
            const existing = toolCalls.get(event.output_index) ?? {};
            existing.id = event.item.call_id;
            existing.name = event.item.name;
            existing.itemId = event.item.id;
            toolCalls.set(event.output_index, existing);
            yield {
              type: "tool_call_delta",
              index: event.output_index,
              id: existing.id,
              name: existing.name,
            };
          }
          break;
        case "response.function_call_arguments.delta": {
          const existing = toolCalls.get(event.output_index);
          yield {
            type: "tool_call_delta",
            index: event.output_index,
            id: existing?.id,
            name: existing?.name,
            inputDelta: event.delta,
          };
          break;
        }
        case "response.completed":
        case "response.failed":
        case "response.incomplete":
          response = event.response;
          break;
        case "error":
          throw new Error(event.message);
      }
    }

    if (!response) {
      throw new Error("OpenAI Responses stream completed without a final response.");
    }

    yield {
      type: "response",
      response: responseToModelResponse(response),
    };
  }
}

// ─── Input conversion ────────────────────────────────────────────────

/**
 * Convert internal messages into Responses API input items.
 *
 * The Responses API accepts an array of input items.  Our internal
 * representation uses role-based messages with content blocks, so we map:
 *
 * - user text → { type: "message", role: "user", content: [...] }
 * - assistant text → { type: "message", role: "assistant", content: [...] }
 * - assistant tool_use → { type: "function_call", ... }
 * - user tool_result → { type: "function_call_output", ... }
 */
export function messagesToInputItems(
  messages: Message[]
): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      items.push({
        type: "message",
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
      continue;
    }

    const messageContentBlocks = msg.content.filter(
      (b) => b.type === "text" || b.type === "image" || b.type === "file"
    );
    const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
    const toolResultBlocks = msg.content.filter(
      (b) => b.type === "tool_result"
    );

    if (messageContentBlocks.length > 0) {
      if (msg.role === "assistant") {
        const textBlocks = messageContentBlocks.filter((b) => b.type === "text");
        items.push({
          type: "message",
          role: "assistant",
          content: textBlocks.map((b) => ({
            type: "output_text" as const,
            text: (b as { type: "text"; text: string }).text,
            annotations: [],
          })),
        } as unknown as OpenAI.Responses.ResponseInputItem);
      } else {
        items.push({
          type: "message",
          role: "user",
          content: messageContentBlocks.map(toResponseInputContent),
        });
      }
    }

    for (const block of toolUseBlocks) {
      const tu = block as {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
      items.push({
        type: "function_call",
        call_id: tu.id,
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      });
    }

    for (const block of toolResultBlocks) {
      const tr = block as {
        type: "tool_result";
        toolUseId: string;
        content: string;
      };
      items.push({
        type: "function_call_output",
        call_id: tr.toolUseId,
        output: tr.content,
      });
    }
  }

  return items;
}

export function conversationItemsToInputItems(
  conversationItems: ConversationItem[]
): OpenAI.Responses.ResponseInputItem[] {
  const items: OpenAI.Responses.ResponseInputItem[] = [];

  for (const item of conversationItems) {
    switch (item.type) {
      case "message":
      case "compaction_summary": {
        const role = item.type === "message" ? item.role : "user";
        const content = item.type === "message" ? item.content : item.summary;
        items.push({
          type: "message",
          role,
          content,
        });
        break;
      }
      case "attachment":
        items.push({
          type: "message",
          role: "user",
          content: [toResponseInputContent(item.attachment)],
        });
        break;
      case "reasoning":
        if (!item.id) break;
        items.push({
          type: "reasoning",
          id: item.id,
          summary: item.summary
            ? [{ type: "summary_text", text: item.summary }]
            : [],
          ...(item.encryptedContent
            ? { encrypted_content: item.encryptedContent }
            : {}),
        });
        break;
      case "function_call":
        items.push({
          type: "function_call",
          call_id: item.id,
          name: item.name,
          arguments: JSON.stringify(item.input),
        });
        break;
      case "function_output":
        items.push({
          type: "function_call_output",
          call_id: item.callId,
          output: item.content,
        });
        break;
    }
  }

  return items;
}

export function toFunctionTool(
  tool: ToolSchema
): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description || undefined,
    parameters: tool.parameters,
    strict: false,
  };
}

function toResponseInputContent(
  block: { type: "text"; text: string } | AttachmentContentBlock
) {
  switch (block.type) {
    case "text":
      return { type: "input_text" as const, text: block.text };
    case "image":
      return {
        type: "input_image" as const,
        image_url: attachmentUrl(block),
        detail: "auto" as const,
      };
    case "file":
      return {
        type: "input_file" as const,
        filename: block.name,
        ...responseFileSource(block),
      };
  }
}

function attachmentUrl(block: AttachmentContentBlock): string {
  if (block.source.type === "url") return block.source.url;
  return `data:${block.source.mediaType};base64,${block.source.data}`;
}

function responseFileSource(block: Extract<AttachmentContentBlock, { type: "file" }>) {
  if (block.source.type === "url") {
    return { file_url: block.source.url };
  }

  return {
    file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
  };
}

// ─── Output conversion ────────────────────────────────────────────────

/**
 * Convert a Responses API response into our internal ModelResponse.
 *
 * Output items we handle:
 * - message → text content blocks
 * - function_call → tool_use content blocks
 * - reasoning → reasoning string (summary text)
 *
 * We determine the stop reason from the response status:
 * - completed + has function_calls → tool_use
 * - completed → end_turn
 * - incomplete + reason max_tokens → max_tokens
 * - everything else → error
 */
export function responseToModelResponse(
  response: OpenAI.Responses.Response
): ModelResponse {
  const content: ContentBlock[] = [];
  let reasoning: string | undefined;
  const reasoningItems: ConversationReasoningItem[] = [];

  for (const item of response.output) {
    if (item.type === "message") {
      const message = item as OpenAI.Responses.ResponseOutputMessage;
      for (const part of message.content) {
        if (part.type === "output_text") {
          const textPart = part as OpenAI.Responses.ResponseOutputText;
          content.push({ type: "text", text: textPart.text });
        }
        // Skip refusals — we treat them as no content.
      }
    } else if (item.type === "function_call") {
      const fc = item as OpenAI.Responses.ResponseFunctionToolCall;
      content.push({
        type: "tool_use",
        id: fc.call_id,
        name: fc.name,
        input: parseFunctionCallArguments(fc.arguments),
      });
    } else if (item.type === "reasoning") {
      const ri = item as OpenAI.Responses.ResponseReasoningItem;
      const summaryText = ri.summary
        .map((s) => s.text)
        .join("\n")
        .trim();
      if (summaryText) {
        reasoning = summaryText;
      }
      reasoningItems.push({
        type: "reasoning",
        id: ri.id,
        summary: summaryText,
        ...(ri.encrypted_content ? { encryptedContent: ri.encrypted_content } : {}),
      });
    }
    // Skip other output item types (web_search_call, etc.)
  }

  const stopReason = mapStopReason(response, content);
  const usage = response.usage
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      }
    : undefined;

  return {
    stopReason,
    content,
    reasoning,
    reasoningItems: reasoningItems.length > 0 ? reasoningItems : undefined,
    usage,
  };
}

export function mapStopReason(
  response: OpenAI.Responses.Response,
  content: ContentBlock[]
): StopReason {
  // If we have tool_use blocks the model wants to call tools.
  if (content.some((b) => b.type === "tool_use")) {
    return "tool_use";
  }

  switch (response.status) {
    case "completed":
      return "end_turn";
    case "incomplete": {
      const reason = response.incomplete_details?.reason;
      if (reason === "max_output_tokens") {
        return "max_tokens";
      }
      return "error";
    }
    case "failed":
      return "error";
    default:
      return "error";
  }
}

function parseFunctionCallArguments(
  inputJson: string
): Record<string, unknown> {
  if (!inputJson) return {};
  try {
    const parsed = JSON.parse(inputJson);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}
