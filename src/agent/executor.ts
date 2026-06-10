import type { ToolCall, ToolExecuteOptions, ToolResult } from "../types/tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { PolicyDecision, PolicyEngine } from "./policies.js";

export type ApprovalCallback = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<boolean>;

export class Executor {
  constructor(
    private registry: ToolRegistry,
    private policyEngine: PolicyEngine,
    private eventStore: EventStore,
    private approvalCallback: ApprovalCallback
  ) {}

  async executeTool(
    sessionId: string,
    toolCall: ToolCall,
    options?: ToolExecuteOptions
  ): Promise<ToolResult> {
    const validationError = this.registry.validateInput(
      toolCall.name,
      toolCall.input
    );
    if (validationError) {
      await this.eventStore.append(sessionId, "tool_call", {
        id: toolCall.id,
        tool: toolCall.name,
        input: toolCall.input,
      });

      await this.eventStore.append(sessionId, "tool_result", {
        toolCallId: toolCall.id,
        tool: toolCall.name,
        content: validationError.content.slice(0, 2000),
        isError: true,
        metadata: validationError.metadata,
      });

      return validationError;
    }

    const decision = this.policyEngine.evaluate(toolCall.name, toolCall.input);

    await this.eventStore.append(sessionId, "policy_decision", {
      tool: toolCall.name,
      input: toolCall.input,
      decision,
    });

    if (decision === "deny") {
      return {
        content: `Tool "${toolCall.name}" was denied by policy.`,
        isError: true,
      };
    }

    if (decision === "ask") {
      const approved = await this.approvalCallback(
        toolCall.name,
        toolCall.input
      );
      if (!approved) {
        return {
          content: `Tool "${toolCall.name}" was denied by user.`,
          isError: true,
        };
      }
    }

    await this.eventStore.append(sessionId, "tool_call", {
      id: toolCall.id,
      tool: toolCall.name,
      input: toolCall.input,
    });

    const result = await this.registry.execute(
      toolCall.name,
      toolCall.input,
      options
    );

    await this.eventStore.append(sessionId, "tool_result", {
      toolCallId: toolCall.id,
      tool: toolCall.name,
      content: result.content.slice(0, 2000), // truncate for event log
      isError: result.isError,
      metadata: result.metadata,
    });

    return result;
  }
}
