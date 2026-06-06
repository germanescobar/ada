import type { ModelProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OLLAMA_DISCOVERY_TIMEOUT_MS = 1_000;
const OLLAMA_CLOUD_MAX_TOKENS = 8_192;
const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 128_000;

export const OLLAMA_CLOUD_MODELS = [
  "glm-5.1",
  "minimax-m2.7",
  "deepseek-v3.2",
  "deepseek-v4-pro",
  "kimi-k2.6",
  "kimi-k2-thinking",
] as const;

export type ModelOptionGroupName =
  | "Anthropic"
  | "OpenAI"
  | "Ollama Local"
  | "Ollama Cloud"
  | "OpenRouter";

export interface ModelOption {
  label: string;
  value: string;
  group: ModelOptionGroupName;
  contextWindowTokens: number;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    label: "Claude Sonnet 4.6",
    value: "anthropic/claude-sonnet-4-6",
    group: "Anthropic",
    contextWindowTokens: 200_000,
  },
  {
    label: "GPT-4",
    value: "openai/gpt-4",
    group: "OpenAI",
    contextWindowTokens: 8_192,
  },
  {
    label: "GPT-3.5 Turbo",
    value: "openai/gpt-3.5-turbo",
    group: "OpenAI",
    contextWindowTokens: 16_385,
  },
  {
    label: "GLM 4.7 Flash (local)",
    value: "ollama/glm-4.7-flash:latest",
    group: "Ollama Local",
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  },
  {
    label: "GLM 5.1 (OpenRouter)",
    value: "openrouter/z-ai/glm-5.1",
    group: "OpenRouter",
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  },
  {
    label: "DeepSeek V4 Pro (OpenRouter)",
    value: "openrouter/deepseek/deepseek-v4-pro",
    group: "OpenRouter",
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  },
  {
    label: "Kimi K2.6 (OpenRouter)",
    value: "openrouter/moonshotai/kimi-k2.6",
    group: "OpenRouter",
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  },
  ...OLLAMA_CLOUD_MODELS.map((model): ModelOption => ({
    label: `${model} (cloud)`,
    value: `ollama-cloud/${model}`,
    group: "Ollama Cloud",
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  })),
];

export interface ModelOptionGroup {
  group: ModelOptionGroupName;
  options: ModelOption[];
}

export interface ModelOptionsResult {
  options: ModelOption[];
  ollamaDiscoveryFailed: boolean;
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
      contextWindowTokens: number;
    }
  | {
      type: "openai-responses";
      provider: string;
      model: string;
      contextWindowTokens: number;
    }
  | {
      type: "openai-compatible";
      provider: string;
      model: string;
      contextWindowTokens: number;
      apiKey?: string;
      baseURL?: string;
      maxTokens?: number;
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

export async function getModelOptions(
  fetchImpl: typeof fetch = fetch
): Promise<ModelOptionsResult> {
  const discoveredOllamaOptions =
    await discoverLocalOllamaModelOptions(fetchImpl);
  const staticValues = new Set(MODEL_OPTIONS.map((option) => option.value));
  const dynamicOptions = (discoveredOllamaOptions ?? []).filter(
    (option) => !staticValues.has(option.value)
  );

  return {
    options: [...MODEL_OPTIONS, ...dynamicOptions],
    ollamaDiscoveryFailed: discoveredOllamaOptions === undefined,
  };
}

export async function discoverLocalOllamaModelOptions(
  fetchImpl: typeof fetch = fetch
): Promise<ModelOption[] | undefined> {
  try {
    const response = await fetchImpl(OLLAMA_TAGS_URL, {
      signal: AbortSignal.timeout(OLLAMA_DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;

    const payload: unknown = await response.json();
    return parseOllamaModelNames(payload).map((name) => ({
      label: `${name} (local)`,
      value: `ollama/${name}`,
      group: "Ollama Local",
      contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
    }));
  } catch {
    return undefined;
  }
}

function parseOllamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];

  return payload.models
    .map((model) => {
      if (!isRecord(model)) return undefined;
      const name = model.name ?? model.model;
      return typeof name === "string" && name.length > 0 ? name : undefined;
    })
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertSupportedOllamaCloudModel(model: string): void {
  if ((OLLAMA_CLOUD_MODELS as readonly string[]).includes(model)) return;

  throw new Error(
    `Unsupported Ollama Cloud model: "${model}". Supported: ${OLLAMA_CLOUD_MODELS.join(", ")}`
  );
}

export function getModelContextWindowTokens(modelString: string): number {
  return (
    MODEL_OPTIONS.find((option) => option.value === modelString)
      ?.contextWindowTokens ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS
  );
}

export function resolveProviderConfig(modelString: string): ProviderConfig {
  const { provider, model } = parseModelString(modelString);
  const contextWindowTokens = getModelContextWindowTokens(modelString);

  switch (provider) {
    case "anthropic":
      return { type: "anthropic", provider, model, contextWindowTokens };

    case "openai":
      return {
        type: "openai-responses",
        provider,
        model,
        contextWindowTokens,
      };

    case "groq":
      return {
        type: "openai-compatible",
        provider,
        model,
        contextWindowTokens,
        apiKey: process.env.GROQ_API_KEY,
        baseURL: GROQ_BASE_URL,
      };

    case "ollama":
      return {
        type: "openai-compatible",
        provider,
        model,
        contextWindowTokens,
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
        contextWindowTokens,
        apiKey: process.env.OLLAMA_API_KEY,
        baseURL: OLLAMA_CLOUD_BASE_URL,
        maxTokens: OLLAMA_CLOUD_MAX_TOKENS,
      };

    case "openrouter":
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error(
          "OPENROUTER_API_KEY is required for openrouter models. Set OPENROUTER_API_KEY and try again."
        );
      }
      return {
        type: "openai-compatible",
        provider,
        model,
        contextWindowTokens,
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
      };

    default:
      throw new Error(
        `Unknown provider: "${provider}". Supported: anthropic, openai, groq, ollama, ollama-cloud, openrouter`
      );
  }
}

export function createProvider(modelString: string): ModelProvider {
  const config = resolveProviderConfig(modelString);

  if (config.type === "anthropic") {
    return new AnthropicProvider(config.model);
  }

  if (config.type === "openai-responses") {
    return new OpenAIResponsesProvider(config.model);
  }

  return new OpenAIProvider(config.model, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
  });
}
