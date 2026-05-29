import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_OPTIONS,
  OLLAMA_CLOUD_MODELS,
  parseModelString,
  type ProviderConfig,
  resolveProviderConfig,
} from "../src/models/resolve.js";

function assertOpenAICompatible(
  config: ProviderConfig
): Extract<ProviderConfig, { type: "openai-compatible" }> {
  assert.equal(config.type, "openai-compatible");
  return config;
}

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
  assert.deepEqual(parseModelString("ollama-cloud/glm-5.1"), {
    provider: "ollama-cloud",
    model: "glm-5.1",
  });
});

test("parseModelString rejects missing provider", () => {
  assert.throws(
    () => parseModelString("glm-5.1"),
    /Expected "provider\/model"/
  );
});

test("ollama-cloud resolves to the OpenAI-compatible cloud endpoint", () => {
  withEnv(
    {
      OLLAMA_API_KEY: "test-ollama-key",
    },
    () => {
      assert.deepEqual(resolveProviderConfig("ollama-cloud/glm-5.1"), {
        type: "openai-compatible",
        provider: "ollama-cloud",
        model: "glm-5.1",
        apiKey: "test-ollama-key",
        baseURL: "https://ollama.com/v1",
      });
    }
  );
});

test("ollama-cloud rejects unsupported models", () => {
  assert.throws(
    () => resolveProviderConfig("ollama-cloud/llama3.2"),
    /Unsupported Ollama Cloud model: "llama3\.2"/
  );
});

test("ollama-cloud requires its own API key", () => {
  withEnv(
    { OLLAMA_API_KEY: undefined, OPENAI_API_KEY: "test-openai-key" },
    () => {
      assert.throws(
        () => resolveProviderConfig("ollama-cloud/deepseek-v3.2"),
        /OLLAMA_API_KEY is required/
      );
    }
  );
});

test("existing OpenAI-compatible providers keep their defaults", () => {
  assert.deepEqual(resolveProviderConfig("ollama/glm-4.7-flash:latest"), {
    type: "openai-compatible",
    provider: "ollama",
    model: "glm-4.7-flash:latest",
    baseURL: "http://localhost:11434/v1",
  });

  withEnv({ GROQ_API_KEY: "test-groq-key" }, () => {
    assert.deepEqual(resolveProviderConfig("groq/llama-3.3-70b-versatile"), {
      type: "openai-compatible",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      apiKey: "test-groq-key",
      baseURL: "https://api.groq.com/openai/v1",
    });
  });
});

test("model options separate Ollama local and Ollama Cloud choices", () => {
  const localOptions = MODEL_OPTIONS.filter(
    (option) => option.group === "Ollama Local"
  );
  const cloudOptions = MODEL_OPTIONS.filter(
    (option) => option.group === "Ollama Cloud"
  );

  assert.ok(localOptions.some((option) => option.value.startsWith("ollama/")));
  assert.deepEqual(
    cloudOptions.map((option) => option.value),
    OLLAMA_CLOUD_MODELS.map((model) => `ollama-cloud/${model}`)
  );
});
