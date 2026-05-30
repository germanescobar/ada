import assert from "node:assert/strict";
import test from "node:test";

import { formatModelOptions } from "../src/cli/index.js";

test("formatModelOptions lists models grouped by provider", () => {
  const output = formatModelOptions();

  assert.match(output, /^Anthropic\n/m);
  assert.match(output, /^OpenAI\n/m);
  assert.match(output, /^Ollama Local\n/m);
  assert.match(output, /^Ollama Cloud\n/m);
  assert.match(output, /anthropic\/claude-sonnet-4-6\s+Claude Sonnet 4\.6/);
  assert.match(output, /ollama\/glm-4\.7-flash:latest\s+GLM 4\.7 Flash \(local\)/);
  assert.match(output, /ollama-cloud\/glm-5\.1\s+glm-5\.1 \(cloud\)/);
});
