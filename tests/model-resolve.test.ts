import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUDFLARE_AI_GATEWAY_MODELS,
  discoverLocalOllamaModelOptions,
  getModelOptions,
  MODEL_OPTIONS,
  OLLAMA_CLOUD_MODELS,
  getModelCapabilities,
  getModelContextWindowTokens,
  parseModelString,
  resolveProviderConfig,
} from "../src/models/resolve.js";

type MockFetch = typeof fetch;

function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T
): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("parseModelString splits provider and model", () => {
  assert.deepEqual(parseModelString("ollama-cloud/glm-5.2"), {
    provider: "ollama-cloud",
    model: "glm-5.2",
  });
});

test("parseModelString rejects missing provider", () => {
  assert.throws(
    () => parseModelString("glm-5.2"),
    /Expected "provider\/model"/
  );
});

test("ollama-cloud resolves to the OpenAI-compatible cloud endpoint", () => {
  withEnv(
    {
      OLLAMA_API_KEY: "test-ollama-key",
    },
    () => {
      assert.deepEqual(resolveProviderConfig("ollama-cloud/glm-5.2"), {
        type: "openai-compatible",
        provider: "ollama-cloud",
        model: "glm-5.2",
        contextWindowTokens: 976_000,
        apiKey: "test-ollama-key",
        baseURL: "https://ollama.com/v1",
        maxTokens: 8192,
      });
    }
  );
});

test("ollama-cloud rejects unsupported models", () => {
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/llama3.2"),
    /Unsupported Ollama Cloud model: "llama3\.2"/
  );
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/deepseek-v3.2"),
    /Unsupported Ollama Cloud model: "deepseek-v3\.2"/
  );
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/kimi-k2-thinking"),
    /Unsupported Ollama Cloud model: "kimi-k2-thinking"/
  );
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/glm-5.1"),
    /Unsupported Ollama Cloud model: "glm-5\.1"/
  );
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/kimi-k2.6"),
    /Unsupported Ollama Cloud model: "kimi-k2\.6"/
  );
});

test("ollama-cloud requires its own API key", () => {
  withEnv(
    { OLLAMA_API_KEY: undefined },
    () => {
      assert.throws(
        () => resolveProviderConfig("ollama-cloud/deepseek-v4-pro"),
        /OLLAMA_API_KEY is required/
      );
    }
  );
});

test("cloudflare-ai-gateway resolves to the OpenAI-compatible REST endpoint", () => {
  withEnv(
    {
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
      CLOUDFLARE_AI_GATEWAY_ID: "test-gateway",
    },
    () => {
      assert.deepEqual(
        resolveProviderConfig(
          "cloudflare-ai-gateway/@cf/zai-org/glm-4.7-flash"
        ),
        {
          type: "openai-compatible",
          provider: "cloudflare-ai-gateway",
          model: "@cf/zai-org/glm-4.7-flash",
          contextWindowTokens: 131_072,
          apiKey: "test-cloudflare-token",
          baseURL:
            "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1",
          defaultHeaders: {
            "cf-aig-gateway-id": "test-gateway",
          },
        }
      );
    }
  );
});

test("cloudflare-ai-gateway defaults to the default gateway id", () => {
  withEnv(
    {
      CLOUDFLARE_ACCOUNT_ID: "test-account",
      CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
      CLOUDFLARE_AI_GATEWAY_ID: undefined,
    },
    () => {
      assert.equal(
        resolveProviderConfig(
          "cloudflare-ai-gateway/@cf/zai-org/glm-4.7-flash"
        ).defaultHeaders?.["cf-aig-gateway-id"],
        "default"
      );
    }
  );
});

test("cloudflare-ai-gateway rejects unsupported models", () => {
  assert.throws(
    () => resolveProviderConfig("cloudflare-ai-gateway/@cf/qwen/qwen3.5-35b-a3b"),
    /Unsupported Cloudflare AI Gateway model: "@cf\/qwen\/qwen3\.5-35b-a3b"/
  );
});

test("cloudflare-ai-gateway requires Cloudflare credentials", () => {
  withEnv(
    { CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: "token" },
    () => {
      assert.throws(
        () =>
          resolveProviderConfig(
            "cloudflare-ai-gateway/@cf/google/gemma-4-26b-a4b-it"
          ),
        /CLOUDFLARE_ACCOUNT_ID is required/
      );
    }
  );

  withEnv(
    { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: undefined },
    () => {
      assert.throws(
        () =>
          resolveProviderConfig(
            "cloudflare-ai-gateway/@cf/google/gemma-4-26b-a4b-it"
          ),
        /CLOUDFLARE_API_TOKEN is required/
      );
    }
  );
});

test("supported OpenAI-compatible providers keep their defaults", () => {
  assert.deepEqual(resolveProviderConfig("ollama/glm-4.7-flash:latest"), {
    type: "openai-compatible",
    provider: "ollama",
    model: "glm-4.7-flash:latest",
    contextWindowTokens: 198_000,
    baseURL: "http://localhost:11434/v1",
  });
});

test("model context windows are available for compaction budgeting", () => {
  assert.equal(getModelContextWindowTokens("openrouter/z-ai/glm-5.1"), 198_000);
  assert.equal(
    getModelContextWindowTokens("openrouter/minimax/minimax-m3"),
    1_000_000
  );
  assert.equal(
    getModelContextWindowTokens("openrouter/deepseek/deepseek-v4-pro"),
    1_000_000
  );
  assert.equal(
    getModelContextWindowTokens("openrouter/moonshotai/kimi-k2.6"),
    256_000
  );
  assert.equal(getModelContextWindowTokens("ollama-cloud/minimax-m3"), 512_000);
  assert.equal(
    getModelContextWindowTokens("ollama-cloud/deepseek-v4-pro"),
    1_000_000
  );
  assert.equal(getModelContextWindowTokens("ollama-cloud/glm-5.2"), 976_000);
  assert.equal(
    getModelContextWindowTokens("ollama-cloud/kimi-k2.7-code"),
    256_000
  );
  assert.equal(
    getModelContextWindowTokens(
      "cloudflare-ai-gateway/@cf/zai-org/glm-4.7-flash"
    ),
    131_072
  );
  assert.equal(
    getModelContextWindowTokens("cloudflare-ai-gateway/@cf/zai-org/glm-5.2"),
    262_144
  );
  assert.equal(
    getModelContextWindowTokens("cloudflare-ai-gateway/minimax/m3"),
    1_000_000
  );
  assert.equal(
    getModelContextWindowTokens(
      "cloudflare-ai-gateway/deepseek/deepseek-v4-pro"
    ),
    131_072
  );
  assert.equal(
    getModelContextWindowTokens(
      "cloudflare-ai-gateway/@cf/moonshotai/kimi-k2.7-code"
    ),
    256_000
  );
  assert.equal(
    getModelContextWindowTokens(
      "cloudflare-ai-gateway/@cf/google/gemma-4-26b-a4b-it"
    ),
    256_000
  );
  assert.equal(getModelContextWindowTokens("ollama/custom-model"), 128_000);
});

test("model capabilities expose supported attachment types", () => {
  assert.deepEqual(
    getModelCapabilities("openrouter/moonshotai/kimi-k2.6"),
    {
      attachments: {
        images: true,
        files: true,
      },
    }
  );
  assert.deepEqual(getModelCapabilities("openrouter/z-ai/glm-5.1"), {
    attachments: {
      images: false,
      files: true,
    },
  });
  assert.deepEqual(
    getModelCapabilities("openrouter/minimax/minimax-m3"),
    {
      attachments: {
        images: true,
        files: true,
      },
    }
  );
  assert.deepEqual(getModelCapabilities("ollama-cloud/minimax-m3"), {
    attachments: {
      images: true,
      files: true,
    },
  });
  assert.deepEqual(getModelCapabilities("ollama-cloud/kimi-k2.7-code"), {
    attachments: {
      images: true,
      files: false,
    },
  });
  assert.deepEqual(
    getModelCapabilities(
      "cloudflare-ai-gateway/@cf/moonshotai/kimi-k2.7-code"
    ),
    {
      attachments: {
        images: true,
        files: false,
      },
    }
  );
  assert.deepEqual(
    getModelCapabilities(
      "cloudflare-ai-gateway/@cf/google/gemma-4-26b-a4b-it"
    ),
    {
      attachments: {
        images: true,
        files: false,
      },
    }
  );
  assert.deepEqual(getModelCapabilities("ollama/custom-model"), {});
});

test("model options separate static provider choices", () => {
  const localOptions = MODEL_OPTIONS.filter(
    (option) => option.group === "Ollama Local"
  );
  const cloudOptions = MODEL_OPTIONS.filter(
    (option) => option.group === "Ollama Cloud"
  );
  const cloudflareOptions = MODEL_OPTIONS.filter(
    (option) => option.group === "Cloudflare AI Gateway"
  );

  assert.ok(localOptions.some((option) => option.value.startsWith("ollama/")));
  assert.deepEqual(
    cloudOptions.map((option) => option.value),
    OLLAMA_CLOUD_MODELS.map((model) => `ollama-cloud/${model}`)
  );
  assert.deepEqual(cloudOptions.map((option) => option.value), [
    "ollama-cloud/glm-5.2",
    "ollama-cloud/minimax-m3",
    "ollama-cloud/deepseek-v4-pro",
    "ollama-cloud/kimi-k2.7-code",
  ]);
  assert.deepEqual(
    cloudflareOptions.map((option) => option.value),
    CLOUDFLARE_AI_GATEWAY_MODELS.map(
      (model) => `cloudflare-ai-gateway/${model}`
    )
  );
  assert.deepEqual(cloudflareOptions.map((option) => option.value), [
    "cloudflare-ai-gateway/@cf/zai-org/glm-4.7-flash",
    "cloudflare-ai-gateway/@cf/zai-org/glm-5.2",
    "cloudflare-ai-gateway/minimax/m3",
    "cloudflare-ai-gateway/deepseek/deepseek-v4-pro",
    "cloudflare-ai-gateway/@cf/moonshotai/kimi-k2.7-code",
    "cloudflare-ai-gateway/@cf/google/gemma-4-26b-a4b-it",
  ]);
});

test("discovers installed local Ollama models from the tags API", async () => {
  const fetchImpl: MockFetch = async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: "gemma4:31b" },
          { model: "qwen3:latest" },
        ],
      })
    );

  const options = await discoverLocalOllamaModelOptions(fetchImpl);

  assert.deepEqual(options, [
    {
      label: "gemma4:31b",
      value: "ollama/gemma4:31b",
      group: "Ollama Local",
      contextWindowTokens: 128_000,
    },
    {
      label: "qwen3:latest",
      value: "ollama/qwen3:latest",
      group: "Ollama Local",
      contextWindowTokens: 128_000,
    },
  ]);
});

test("model options keep built-in local fallback when Ollama is unavailable", async () => {
  const fetchImpl: MockFetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  };

  const result = await getModelOptions(fetchImpl);

  assert.equal(result.ollamaDiscoveryFailed, true);
  assert.deepEqual(result.options, [...MODEL_OPTIONS]);
});

test("model options merge discovered Ollama models into the local group", async () => {
  const fetchImpl: MockFetch = async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: "gemma4:31b" },
          { name: "glm-4.7-flash:latest" },
        ],
      })
    );

  const result = await getModelOptions(fetchImpl);
  const localOptions = result.options.filter(
    (option) => option.group === "Ollama Local"
  );

  assert.equal(result.ollamaDiscoveryFailed, false);
  assert.ok(
    localOptions.some((option) => option.value === "ollama/gemma4:31b")
  );
  assert.equal(
    localOptions.filter(
      (option) => option.value === "ollama/glm-4.7-flash:latest"
    ).length,
    1
  );
});
