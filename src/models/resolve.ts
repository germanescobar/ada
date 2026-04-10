import type { ModelProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";

export interface ResolvedModel {
  provider: string;
  model: string;
}

export function parseModelString(modelString: string): ResolvedModel {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model format: "${modelString}". Expected "provider/model" (e.g., "anthropic/claude-sonnet-4-6")`
    );
  }
  return {
    provider: modelString.slice(0, slashIndex),
    model: modelString.slice(slashIndex + 1),
  };
}

export function createProvider(
  modelString: string,
  options?: { baseURL?: string; apiKey?: string }
): ModelProvider {
  const { provider, model } = parseModelString(modelString);

  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(model, { apiKey: options?.apiKey });

    case "openai":
      return new OpenAIProvider(model, {
        apiKey: options?.apiKey,
        baseURL: options?.baseURL,
      });

    case "ollama":
      return new OpenAIProvider(model, {
        baseURL: options?.baseURL ?? OLLAMA_BASE_URL,
      });

    default:
      throw new Error(
        `Unknown provider: "${provider}". Supported: anthropic, openai, ollama`
      );
  }
}
