import assert from "node:assert/strict";
import test from "node:test";

import { formatModelOptions } from "../src/cli/index.js";

test("formatModelOptions lists models grouped by provider", () => {
  const output = formatModelOptions();

  assert.match(output, /^Ollama Local\n/m);
  assert.match(output, /^Ollama Cloud\n/m);
  assert.match(output, /^OpenRouter\n/m);
  assert.doesNotMatch(output, /^Anthropic\n/m);
  assert.doesNotMatch(output, /^OpenAI\n/m);
  assert.match(output, /ollama\/glm-4\.7-flash:latest\s+GLM 4\.7 Flash \(local\)/);
  assert.match(output, /ollama-cloud\/glm-5\.1\s+glm-5\.1 \(cloud\)/);
  assert.match(output, /ollama-cloud\/deepseek-v4-pro\s+deepseek-v4-pro \(cloud\)/);
  assert.doesNotMatch(output, /ollama-cloud\/deepseek-v3\.2/);
  assert.doesNotMatch(output, /ollama-cloud\/kimi-k2-thinking/);
});
