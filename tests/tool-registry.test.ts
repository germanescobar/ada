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
