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
  streamChat?(params: ChatParams): AsyncIterable<ModelStreamEvent>;
}

export type ModelStreamEvent =
  | {
      type: "assistant_text_delta";
      text: string;
    }
  | {
      type: "assistant_reasoning_delta";
      text: string;
    }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      inputDelta?: string;
    }
  | {
      type: "response";
      response: ModelResponse;
    };
