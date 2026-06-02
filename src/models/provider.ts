import type { ConversationItem } from "../types/conversation.js";
import type { Message } from "../types/messages.js";
import type { ToolSchema } from "../types/tools.js";
import type { ModelResponse } from "../types/agent.js";

export interface ChatParams {
  systemPrompt: string;
  conversationItems: ConversationItem[];
  messages?: Message[];
  tools: ToolSchema[];
}

export interface ModelProvider {
  chat(params: ChatParams): Promise<ModelResponse>;
}
