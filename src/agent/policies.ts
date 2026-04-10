export type PolicyDecision = "allow" | "deny" | "ask";

interface PolicyRule {
  toolName: string;
  decide: (input: Record<string, unknown>) => PolicyDecision;
}

const SAFE_COMMAND_PATTERNS = [
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^find\b/,
  /^grep\b/,
  /^git\s+(status|diff|log|branch|show)\b/,
  /^pwd$/,
  /^echo\b/,
  /^which\b/,
  /^node\s+--version/,
  /^npm\s+(list|ls|outdated|view)\b/,
];

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /^sudo\b/,
  />\s*\/dev\/sd/,
  /mkfs\b/,
  /dd\s+if=/,
];

export class PolicyEngine {
  private rules: PolicyRule[] = [];

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  evaluate(toolName: string, input: Record<string, unknown>): PolicyDecision {
    for (const rule of this.rules) {
      if (rule.toolName === toolName) {
        return rule.decide(input);
      }
    }
    return "allow";
  }

  static withDefaults(): PolicyEngine {
    const engine = new PolicyEngine();

    engine.addRule({
      toolName: "read_file",
      decide: () => "allow",
    });

    engine.addRule({
      toolName: "write_file",
      decide: () => "allow",
    });

    engine.addRule({
      toolName: "edit_file",
      decide: () => "allow",
    });

    engine.addRule({
      toolName: "run_command",
      decide: (input) => {
        const cmd = (input.command as string).trim();

        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(cmd)) return "deny";
        }

        for (const pattern of SAFE_COMMAND_PATTERNS) {
          if (pattern.test(cmd)) return "allow";
        }

        return "ask";
      },
    });

    return engine;
  }
}
