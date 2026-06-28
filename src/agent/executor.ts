import type { ToolCall, ToolExecuteOptions, ToolResult } from "../types/tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventStore } from "../storage/event-store.js";
import type { PolicyEngine } from "./policies.js";
import type {
  ApprovalAnswer,
  ApprovalCallback,
  ApprovalNotifier,
  ApprovalRequest,
} from "../types/approval.js";

export type {
  ApprovalAnswer,
  ApprovalCallback,
  ApprovalNotifier,
  ApprovalRequest,
};

export class Executor {
  constructor(
    private registry: ToolRegistry,
    private policyEngine: PolicyEngine,
    private eventStore: EventStore,
    private approvalCallback: ApprovalCallback,
    /**
     * Optional notifier used to emit structured `approval.request` /
     * `approval.resolved` stream events. Kept as an injected seam so the
     * Executor does not depend on AgentLoop or stream-json mode.
     */
    private approvalNotifier?: ApprovalNotifier
  ) {}

  /**
   * Install (or replace) the approval notifier after construction. Used by
   * `AgentLoop` to wire the executor into its own stream-json emitter without
   * changing the public constructor order.
   */
  setApprovalNotifier(notifier: ApprovalNotifier | undefined): void {
    this.approvalNotifier = notifier;
  }

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
      const request: ApprovalRequest = {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        input: toolCall.input,
      };

      // Emit the request before awaiting the responder so consumers see
      // approval.request ahead of any tool.call/tool.result events for the
      // same toolCallId.
      this.approvalNotifier?.notifyApprovalRequest(request);

      let answer: ApprovalAnswer;
      try {
        answer = await this.approvalCallback(request, options?.signal);
      } catch (err) {
        this.approvalNotifier?.notifyApprovalResolved({
          ...request,
          approved: false,
          reason: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const approved = typeof answer === "boolean" ? answer : answer.approved;
      // Resolver may supply a reason (e.g. stdin EOF). Otherwise fall back
      // to "aborted" when the surrounding signal is already aborted, else
      // "user".
      const responderReason =
        typeof answer === "boolean" ? undefined : answer.reason;
      const reason: "user" | "aborted" | "eof" = options?.signal?.aborted
        ? "aborted"
        : (responderReason ?? "user");

      this.approvalNotifier?.notifyApprovalResolved({
        ...request,
        approved,
        reason,
      });

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