export type PolicyDecision = "allow" | "deny" | "ask";

export type ApprovalMode = "prompt" | "auto";

export interface PolicyContextRule {
  toolName: string;
  decision: PolicyDecision;
  description: string;
}

export interface PolicyContext {
  defaultDecision: PolicyDecision;
  rules: PolicyContextRule[];
}

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

const DEFAULT_POLICY_CONTEXT: PolicyContext = {
  defaultDecision: "allow",
  rules: [
    {
      toolName: "read_file",
      decision: "allow",
      description: "File reads are allowed.",
    },
    {
      toolName: "write_file",
      decision: "allow",
      description: "File writes and overwrites are allowed.",
    },
    {
      toolName: "edit_file",
      decision: "allow",
      description: "Exact-match file edits are allowed.",
    },
    {
      toolName: "delete_file",
      decision: "allow",
      description: "File deletion is allowed.",
    },
    {
      toolName: "run_command",
      decision: "deny",
      description:
        "Commands matching dangerous patterns such as sudo, disk formatting, raw device writes, or rm -rf / are denied.",
    },
    {
      toolName: "run_command",
      decision: "allow",
      description:
        "Common inspection commands are allowed, including ls, cat, head, tail, wc, find, grep, git status/diff/log/branch/show, pwd, echo, which, node --version, and npm list/ls/outdated/view.",
    },
    {
      toolName: "run_command",
      decision: "ask",
      description:
        "Other shell commands require approval unless auto-approval is enabled.",
    },
  ],
};

export class PolicyEngine {
  private rules: PolicyRule[] = [];

  constructor(private policyContext: PolicyContext = DEFAULT_POLICY_CONTEXT) {}

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

  describe(): PolicyContext {
    return this.policyContext;
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
