import assert from "node:assert/strict";
import test from "node:test";

import { createCLI, formatModelOptions } from "../src/cli/index.js";

test("formatModelOptions lists models grouped by provider", () => {
  const output = formatModelOptions();

  assert.match(output, /^Anthropic\n/m);
  assert.match(output, /^OpenAI\n/m);
  assert.match(output, /^Ollama Local\n/m);
  assert.match(output, /^Ollama Cloud\n/m);
  assert.match(output, /anthropic\/claude-sonnet-4-6\s+Claude Sonnet 4\.6/);
  assert.match(output, /ollama\/glm-4\.7-flash:latest\s+GLM 4\.7 Flash \(local\)/);
  assert.match(output, /ollama-cloud\/glm-5\.1\s+glm-5\.1 \(cloud\)/);
  assert.match(output, /ollama-cloud\/deepseek-v4-pro\s+deepseek-v4-pro \(cloud\)/);
  assert.match(output, /ollama-cloud\/kimi-k2-thinking\s+kimi-k2-thinking \(cloud\)/);
});

test("chat help does not expose internal context compaction options", () => {
  const program = createCLI();
  const chatCommand = program.commands.find((command) => command.name() === "chat");

  assert.ok(chatCommand);
  const help = chatCommand.helpInformation();

  assert.doesNotMatch(help, /context-compact-at-ratio/);
  assert.doesNotMatch(help, /context-keep-recent-tokens/);
  assert.doesNotMatch(help, /context-reserved-response-tokens/);
  assert.doesNotMatch(help, /context-min-summarizable-tokens/);
  assert.doesNotMatch(help, /context-target-summary-tokens/);
});
