import type { ModelProvider } from "./provider.js";
import { OpenAIProvider } from "./openai.js";

const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OLLAMA_DISCOVERY_TIMEOUT_MS = 1_000;
const OLLAMA_CLOUD_MAX_TOKENS = 8_192;
const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 128_000;
const GLM_CONTEXT_WINDOW_TOKENS = 198_000;
const GLM_5_2_CONTEXT_WINDOW_TOKENS = 976_000;
const DEEPSEEK_V4_PRO_CONTEXT_WINDOW_TOKENS = 1_000_000;
const KIMI_K2_CONTEXT_WINDOW_TOKENS = 256_000;
const MINIMAX_M3_OLLAMA_CONTEXT_WINDOW_TOKENS = 512_000;
const MINIMAX_M3_OPENROUTER_CONTEXT_WINDOW_TOKENS = 1_000_000;

interface OllamaCloudModelSpec {
  slug: string;
  label: string;
  contextWindowTokens: number;
  capabilities?: ModelCapabilities;
}

const OLLAMA_CLOUD_MODEL_SPECS: readonly OllamaCloudModelSpec[] = [
  {
    slug: "glm-5.2",
    label: "GLM 5.2",
    contextWindowTokens: GLM_5_2_CONTEXT_WINDOW_TOKENS,
  },
  {
    slug: "minimax-m3",
    label: "MiniMax M3",
    contextWindowTokens: MINIMAX_M3_OLLAMA_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: true, files: true } },
  },
  {
    slug: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    contextWindowTokens: DEEPSEEK_V4_PRO_CONTEXT_WINDOW_TOKENS,
  },
  {
    slug: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    contextWindowTokens: KIMI_K2_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: true, files: false } },
  },
];

export const OLLAMA_CLOUD_MODELS = OLLAMA_CLOUD_MODEL_SPECS.map(
  (spec) => spec.slug
);

export type ModelOptionGroupName =
  | "Ollama Local"
  | "Ollama Cloud"
  | "OpenRouter";

export interface ModelOption {
  label: string;
  value: string;
  group: ModelOptionGroupName;
  contextWindowTokens: number;
  capabilities?: ModelCapabilities;
}

export interface ModelCapabilities {
  attachments?: AttachmentCapabilities;
}

export interface AttachmentCapabilities {
  images: boolean;
  files: boolean;
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  {
    label: "GLM 4.7 Flash",
    value: "ollama/glm-4.7-flash:latest",
    group: "Ollama Local",
    contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS,
  },
  {
    label: "GLM 5.1",
    value: "openrouter/z-ai/glm-5.1",
    group: "OpenRouter",
    contextWindowTokens: GLM_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: false, files: true } },
  },
  {
    label: "MiniMax M3",
    value: "openrouter/minimax/minimax-m3",
    group: "OpenRouter",
    contextWindowTokens: MINIMAX_M3_OPENROUTER_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: true, files: true } },
  },
  {
    label: "DeepSeek V4 Pro",
    value: "openrouter/deepseek/deepseek-v4-pro",
    group: "OpenRouter",
    contextWindowTokens: DEEPSEEK_V4_PRO_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: false, files: true } },
  },
  {
    label: "Kimi K2.6",
    value: "openrouter/moonshotai/kimi-k2.6",
    group: "OpenRouter",
    contextWindowTokens: KIMI_K2_CONTEXT_WINDOW_TOKENS,
    capabilities: { attachments: { images: true, files: true } },
  },
  ...OLLAMA_CLOUD_MODEL_SPECS.map((spec): ModelOption => ({
    label: spec.label,
    value: `ollama-cloud/${spec.slug}`,
    group: "Ollama Cloud",
    contextWindowTokens: spec.contextWindowTokens,
    ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
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
  {
    type: "openai-compatible";
    provider: string;
    model: string;
    contextWindowTokens: number;
    apiKey?: string;
    baseURL?: string;
    maxTokens?: number;
    openRouter?: boolean;
  };

export function parseModelString(modelString: string): ResolvedModel {
  const slashIndex = modelString.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model format: "${modelString}". Expected "provider/model" (e.g., "ollama/glm-4.7-flash:latest")`
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
      label: name,
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

export function getModelCapabilities(modelString: string): ModelCapabilities {
  const option = MODEL_OPTIONS.find((item) => item.value === modelString);
  if (option?.capabilities) return option.capabilities;

  const { provider } = parseModelString(modelString);
  if (provider === "openrouter") {
    return { attachments: { images: false, files: true } };
  }
  return {};
}

export function resolveProviderConfig(modelString: string): ProviderConfig {
  const { provider, model } = parseModelString(modelString);
  const contextWindowTokens = getModelContextWindowTokens(modelString);

  switch (provider) {
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
        openRouter: true,
      };

    default:
      throw new Error(
        `Unknown provider: "${provider}". Supported: ollama, ollama-cloud, openrouter`
      );
  }
}

export function createProvider(modelString: string): ModelProvider {
  const config = resolveProviderConfig(modelString);

  return new OpenAIProvider(config.model, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    maxTokens: config.maxTokens,
    openRouter: config.openRouter,
  });
}
