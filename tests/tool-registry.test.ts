import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/types/tools.js";

function createTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    },
    async execute() {
      return { content: `${name} executed` };
    },
  };
}

test("ToolRegistry.toSchemas returns deterministic name-sorted schemas", () => {
  const alpha = createTool("alpha");
  const beta = createTool("beta");
  const gamma = createTool("gamma");

  const first = new ToolRegistry();
  first.register(gamma);
  first.register(alpha);
  first.register(beta);

  const second = new ToolRegistry();
  second.register(beta);
  second.register(gamma);
  second.register(alpha);

  assert.deepEqual(
    first.toSchemas().map((schema) => schema.name),
    ["alpha", "beta", "gamma"]
  );
  assert.deepEqual(first.toSchemas(), second.toSchemas());
  assert.deepEqual(first.toSchemas()[0], {
    name: "alpha",
    description: "alpha description",
    parameters: alpha.inputSchema,
  });
});

test("ToolRegistry.execute returns validation errors for malformed tool input", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool("alpha"));

  const result = await registry.execute("alpha", {});

  assert.deepEqual(result, {
    content: 'Invalid input for tool "alpha": missing required field "value".',
    isError: true,
    metadata: {
      validationErrors: ['missing required field "value".'],
    },
  });
});

test("ToolRegistry.execute validates primitive property types", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool("alpha"));

  const result = await registry.execute("alpha", { value: 42 });

  assert.deepEqual(result, {
    content: 'Invalid input for tool "alpha": field "value" must be a string.',
    isError: true,
    metadata: {
      validationErrors: ['field "value" must be a string.'],
    },
  });
});
