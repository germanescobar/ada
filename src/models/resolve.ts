import type { ModelProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

export const OLLAMA_CLOUD_MODELS = [
  "glm-5.1",
  "minimax-m2.7",
  "deepseek-v3.2",
  "kimi-k2.6",
] as const;

export const MODEL_OPTIONS = [
  {
    label: "Claude Sonnet 4.6",
    value: "anthropic/claude-sonnet-4-6",
    group: "Anthropic",
  },
  { label: "GPT-4", value: "openai/gpt-4", group: "OpenAI" },
  {
    label: "GPT-3.5 Turbo",
    value: "openai/gpt-3.5-turbo",
    group: "OpenAI",
  },
  {
    label: "GLM 4.7 Flash (local)",
    value: "ollama/glm-4.7-flash:latest",
    group: "Ollama Local",
  },
  ...OLLAMA_CLOUD_MODELS.map((model) => ({
    label: `${model} (cloud)`,
    value: `ollama-cloud/${model}`,
    group: "Ollama Cloud",
  })),
] as const;

export type ModelOption = (typeof MODEL_OPTIONS)[number];

export interface ModelOptionGroup {
  group: ModelOption["group"];
  options: ModelOption[];
}

export interface ResolvedModel {
  provider: string;
  model: string;
}

export type ProviderConfig =
  | {
      type: "anthropic";
      provider: string;
      model: string;
    }
  | {
      type: "openai-compatible";
      provider: string;
      model: string;
      apiKey?: string;
      baseURL?: string;
    };

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

export function groupModelOptions(
  options: readonly ModelOption[] = MODEL_OPTIONS
): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = [];

  for (const option of options) {
    let group = groups.find((item) => item.group === option.group);
    if (!group) {
      group = { group: option.group, options: [] };
      groups.push(group);
    }
    group.options.push(option);
  }

  return groups;
}

function assertSupportedOllamaCloudModel(model: string): void {
  if ((OLLAMA_CLOUD_MODELS as readonly string[]).includes(model)) return;

  throw new Error(
    `Unsupported Ollama Cloud model: "${model}". Supported: ${OLLAMA_CLOUD_MODELS.join(", ")}`
  );
}

export function resolveProviderConfig(modelString: string): ProviderConfig {
  const { provider, model } = parseModelString(modelString);

  switch (provider) {
    case "anthropic":
      return { type: "anthropic", provider, model };

    case "openai":
      return {
        type: "openai-compatible",
        provider,
        model,
      };

    case "groq":
      return {
        type: "openai-compatible",
        provider,
        model,
        apiKey: process.env.GROQ_API_KEY,
        baseURL: GROQ_BASE_URL,
      };

    case "ollama":
      return {
        type: "openai-compatible",
        provider,
        model,
        baseURL: OLLAMA_BASE_URL,
      };

    case "ollama-cloud":
      assertSupportedOllamaCloudModel(model);
      if (!process.env.OLLAMA_API_KEY) {
        throw new Error(
          "OLLAMA_API_KEY is required for ollama-cloud models. Set OLLAMA_API_KEY and try again."
        );
      }
      return {
        type: "openai-compatible",
        provider,
        model,
        apiKey: process.env.OLLAMA_API_KEY,
        baseURL: OLLAMA_CLOUD_BASE_URL,
      };

    default:
      throw new Error(
        `Unknown provider: "${provider}". Supported: anthropic, openai, groq, ollama, ollama-cloud`
      );
  }
}

export function createProvider(modelString: string): ModelProvider {
  const config = resolveProviderConfig(modelString);

  if (config.type === "anthropic") {
    return new AnthropicProvider(config.model);
  }

  return new OpenAIProvider(config.model, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}
