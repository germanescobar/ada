import type { ToolResultMetadata } from "./tools.js";
import type {
  AttachmentContentBlock,
  ContentBlock,
  Message,
  MessageRole,
} from "./messages.js";

export type ConversationItem =
  | ConversationMessageItem
  | ConversationAttachmentItem
  | ConversationReasoningItem
  | ConversationFunctionCallItem
  | ConversationFunctionOutputItem
  | ConversationCompactionSummaryItem;

export interface ConversationMessageItem {
  type: "message";
  role: MessageRole;
  content: string;
  contentFormat?: "string" | "block";
}

export interface ConversationAttachmentItem {
  type: "attachment";
  role: "user";
  attachment: AttachmentContentBlock;
}

export interface ConversationReasoningItem {
  type: "reasoning";
  id?: string;
  summary: string;
  encryptedContent?: string;
}

export interface ConversationFunctionCallItem {
  type: "function_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ConversationFunctionOutputItem {
  type: "function_output";
  callId: string;
  name?: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, ToolResultMetadata>;
}

export interface ConversationCompactionSummaryItem {
  type: "compaction_summary";
  summary: string;
}

export function messagesToConversationItems(messages: Message[]): ConversationItem[] {
  const items: ConversationItem[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      items.push({
        type: "message",
        role: message.role,
        content: message.content,
        contentFormat: "string",
      });
      continue;
    }

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          items.push({
            type: "message",
            role: message.role,
            content: block.text,
            contentFormat: "block",
          });
          break;
        case "image":
        case "file":
          items.push({
            type: "attachment",
            role: "user",
            attachment: block,
          });
          break;
        case "tool_use":
          items.push({
            type: "function_call",
            id: block.id,
            name: block.name,
            input: block.input,
          });
          break;
        case "tool_result":
          items.push({
            type: "function_output",
            callId: block.toolUseId,
            content: block.content,
            ...(block.isError !== undefined ? { isError: block.isError } : {}),
            ...(block.metadata !== undefined ? { metadata: block.metadata } : {}),
          });
          break;
      }
    }
  }

  return items;
}

export function conversationItemsToMessages(items: ConversationItem[]): Message[] {
  const messages: Message[] = [];
  let pendingAssistantBlocks: ContentBlock[] = [];
  let pendingUserBlocks: ContentBlock[] = [];

  const flushAssistantBlocks = (): void => {
    if (pendingAssistantBlocks.length === 0) return;
    messages.push({ role: "assistant", content: pendingAssistantBlocks });
    pendingAssistantBlocks = [];
  };

  const flushUserBlocks = (): void => {
    if (pendingUserBlocks.length === 0) return;
    messages.push({ role: "user", content: pendingUserBlocks });
    pendingUserBlocks = [];
  };

  for (const item of items) {
    switch (item.type) {
      case "message":
        if (item.contentFormat === "block") {
          if (item.role === "assistant") {
            flushUserBlocks();
            pendingAssistantBlocks.push({ type: "text", text: item.content });
          } else {
            flushAssistantBlocks();
            pendingUserBlocks.push({ type: "text", text: item.content });
          }
          break;
        }

        flushAssistantBlocks();
        flushUserBlocks();
        messages.push({
          role: item.role,
          content: item.content,
        });
        break;
      case "attachment":
        flushAssistantBlocks();
        pendingUserBlocks.push(item.attachment);
        break;
      case "reasoning":
        break;
      case "function_call":
        flushUserBlocks();
        pendingAssistantBlocks.push({
          type: "tool_use",
          id: item.id,
          name: item.name,
          input: item.input,
        });
        break;
      case "function_output":
        flushAssistantBlocks();
        pendingUserBlocks.push({
          type: "tool_result",
          toolUseId: item.callId,
          content: item.content,
          ...(item.isError !== undefined ? { isError: item.isError } : {}),
          ...(item.metadata !== undefined ? { metadata: item.metadata } : {}),
        });
        break;
      case "compaction_summary":
        flushAssistantBlocks();
        flushUserBlocks();
        messages.push({
          role: "user",
          content: [{ type: "text", text: item.summary }],
        });
        break;
    }
  }

  flushAssistantBlocks();
  flushUserBlocks();
  return messages;
}

export function contentBlocksToConversationItems(
  content: ContentBlock[],
  reasoning?: string,
  reasoningItems?: ConversationReasoningItem[]
): ConversationItem[] {
  const items: ConversationItem[] = [];

  if (reasoningItems && reasoningItems.length > 0) {
    items.push(...reasoningItems);
  } else if (reasoning) {
    items.push({ type: "reasoning", summary: reasoning });
  }

  for (const block of content) {
    switch (block.type) {
      case "text":
        items.push({
          type: "message",
          role: "assistant",
          content: block.text,
          contentFormat: "block",
        });
        break;
      case "image":
      case "file":
        items.push({
          type: "attachment",
          role: "user",
          attachment: block,
        });
        break;
      case "tool_use":
        items.push({
          type: "function_call",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        break;
      case "tool_result":
        items.push({
          type: "function_output",
          callId: block.toolUseId,
          content: block.content,
          ...(block.isError !== undefined ? { isError: block.isError } : {}),
          ...(block.metadata !== undefined ? { metadata: block.metadata } : {}),
        });
        break;
    }
  }

  return items;
}

export function conversationItemsToText(items: ConversationItem[]): string {
  return items.map(conversationItemToText).join("\n");
}

export function conversationItemToText(item: ConversationItem): string {
  switch (item.type) {
    case "message":
      return item.content;
    case "attachment":
      return `${item.attachment.type} attachment ${formatAttachmentName(item.attachment)}`;
    case "reasoning":
      return `reasoning ${item.summary}`;
    case "function_call":
      return `function_call ${item.id} ${item.name} ${JSON.stringify(item.input)}`;
    case "function_output":
      return `function_output ${item.callId} ${item.isError ? "error" : "ok"} ${
        item.content
      } ${JSON.stringify(item.metadata ?? {})}`;
    case "compaction_summary":
      return item.summary;
  }
}

function formatAttachmentName(attachment: AttachmentContentBlock): string {
  const name = attachment.name ? `${attachment.name} ` : "";
  if (attachment.source.type === "url") {
    return `${name}${attachment.source.url}`;
  }
  return `${name}${attachment.source.mediaType}`;
}
