import assert from "node:assert/strict";
import test from "node:test";

import {
  formatModelOptions,
  formatModelOptionsJson,
} from "../src/cli/index.js";
import type { ModelOptionsResult } from "../src/models/resolve.js";

test("formatModelOptions lists models grouped by provider", () => {
  const output = formatModelOptions();

  assert.match(output, /^Ollama Local\n/m);
  assert.match(output, /^Ollama Cloud\n/m);
  assert.match(output, /^OpenRouter\n/m);
  assert.doesNotMatch(output, /^Anthropic\n/m);
  assert.doesNotMatch(output, /^OpenAI\n/m);
  assert.match(output, /ollama\/glm-4\.7-flash:latest\s+GLM 4\.7 Flash \(local\)/);
  assert.match(output, /ollama-cloud\/glm-5\.1\s+glm-5\.1 \(cloud\)/);
  assert.match(output, /ollama-cloud\/minimax-m3\s+minimax-m3 \(cloud\) \[images, files\]/);
  assert.match(output, /openrouter\/minimax\/minimax-m3\s+MiniMax M3 \(OpenRouter\) \[images, files\]/);
  assert.match(output, /ollama-cloud\/deepseek-v4-pro\s+deepseek-v4-pro \(cloud\)/);
  assert.doesNotMatch(output, /ollama-cloud\/minimax-m2\.7/);
  assert.doesNotMatch(output, /ollama-cloud\/deepseek-v3\.2/);
  assert.doesNotMatch(output, /ollama-cloud\/kimi-k2-thinking/);
});

test("formatModelOptionsJson emits machine-readable model metadata", () => {
  const result: ModelOptionsResult = {
    options: [
      {
        label: "Kimi K2.6 (OpenRouter)",
        value: "openrouter/moonshotai/kimi-k2.6",
        group: "OpenRouter",
        contextWindowTokens: 256_000,
        capabilities: {
          attachments: {
            images: true,
            files: true,
          },
        },
      },
    ],
    ollamaDiscoveryFailed: false,
  };

  assert.deepEqual(JSON.parse(formatModelOptionsJson(result)), {
    models: [
      {
        label: "Kimi K2.6 (OpenRouter)",
        value: "openrouter/moonshotai/kimi-k2.6",
        group: "OpenRouter",
        contextWindowTokens: 256_000,
        capabilities: {
          attachments: {
            images: true,
            files: true,
          },
        },
      },
    ],
    ollamaDiscoveryFailed: false,
  });
});

test("formatModelOptionsJson includes the Ollama discovery failure flag", () => {
  const result: ModelOptionsResult = {
    options: [],
    ollamaDiscoveryFailed: true,
  };

  assert.deepEqual(JSON.parse(formatModelOptionsJson(result)), {
    models: [],
    ollamaDiscoveryFailed: true,
  });
});
