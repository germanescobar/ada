import assert from "node:assert/strict";
import test from "node:test";

import {
  createCLI,
  formatModelOptions,
  formatModelOptionsJson,
} from "../src/cli/index.js";
import type { ModelOptionsResult } from "../src/models/resolve.js";

test("formatModelOptions lists models grouped by provider", () => {
  const output = formatModelOptions();

  assert.match(output, /^Ollama Local\n/m);
  assert.match(output, /^Ollama Cloud\n/m);
  assert.match(output, /^Cloudflare AI Gateway\n/m);
  assert.match(output, /^OpenRouter\n/m);
  assert.doesNotMatch(output, /^Anthropic\n/m);
  assert.doesNotMatch(output, /^OpenAI\n/m);
  assert.match(output, /ollama\/glm-4\.7-flash:latest\s+GLM 4\.7 Flash/);
  assert.match(output, /ollama-cloud\/glm-5\.2\s+GLM 5\.2/);
  assert.match(output, /ollama-cloud\/minimax-m3\s+MiniMax M3 \[images, files\]/);
  assert.match(
    output,
    /cloudflare-ai-gateway\/@cf\/zai-org\/glm-4\.7-flash\s+GLM 4\.7 Flash/
  );
  assert.match(output, /cloudflare-ai-gateway\/@cf\/zai-org\/glm-5\.2\s+GLM 5\.2/);
  assert.match(output, /cloudflare-ai-gateway\/minimax\/m3\s+MiniMax M3/);
  assert.match(
    output,
    /cloudflare-ai-gateway\/deepseek\/deepseek-v4-pro\s+DeepSeek V4 Pro/
  );
  assert.match(
    output,
    /cloudflare-ai-gateway\/@cf\/moonshotai\/kimi-k2\.7-code\s+Kimi K2\.7 Code \[images\]/
  );
  assert.match(
    output,
    /cloudflare-ai-gateway\/@cf\/google\/gemma-4-26b-a4b-it\s+Gemma 4 26B A4B IT \[images\]/
  );
  assert.match(output, /openrouter\/minimax\/minimax-m3\s+MiniMax M3 \[images, files\]/);
  assert.match(output, /ollama-cloud\/deepseek-v4-pro\s+DeepSeek V4 Pro/);
  assert.match(output, /ollama-cloud\/kimi-k2\.7-code\s+Kimi K2\.7 Code \[images\]/);
  assert.doesNotMatch(output, /ollama-cloud\/glm-5\.1/);
  assert.doesNotMatch(output, /ollama-cloud\/minimax-m2\.7/);
  assert.doesNotMatch(output, /ollama-cloud\/deepseek-v3\.2/);
  assert.doesNotMatch(output, /ollama-cloud\/kimi-k2\.6/);
  assert.doesNotMatch(output, /ollama-cloud\/kimi-k2-thinking/);
});

test("formatModelOptionsJson emits machine-readable model metadata", () => {
  const result: ModelOptionsResult = {
    options: [
      {
        label: "Kimi K2.6",
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
        label: "Kimi K2.6",
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

test("CLI help exposes system prompt options", () => {
  const program = createCLI();
  const chatCommand = program.commands.find((command) => command.name() === "chat");

  assert.ok(chatCommand);
  assert.match(program.helpInformation(), /--system-prompt <prompt>/);
  assert.match(chatCommand.helpInformation(), /--system-prompt <prompt>/);
});
