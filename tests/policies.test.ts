import assert from "node:assert/strict";
import test from "node:test";

import { PolicyEngine } from "../src/agent/policies.js";

test("default policy allows rg for repository searches", () => {
  const policyEngine = PolicyEngine.withDefaults();

  assert.equal(
    policyEngine.evaluate("run_command", { command: "rg searchTerm src tests" }),
    "allow"
  );
});

test("default policy still allows grep as the search fallback", () => {
  const policyEngine = PolicyEngine.withDefaults();

  assert.equal(
    policyEngine.evaluate("run_command", {
      command: "grep -R searchTerm src tests",
    }),
    "allow"
  );
});
