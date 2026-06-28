/**
 * Shared types for the approval seam between Executor and consumers.
 *
 * The `Executor` exposes a single approval callback. To make stream-json +
 * approvals work, the callback now receives a structured request (with the
 * model's tool call id) and a small notifier seam emits structured events
 * around every approval gate so consumers can audit decisions.
 */

export interface ApprovalRequest {
  /** The model's tool call id; matches `tool.call.id` / `tool.result.id`. */
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Reason a pending approval was settled. Echoed in `approval.resolved`.
 *
 * - `user`: the user/consumer answered the prompt.
 * - `aborted`: the run's AbortSignal fired while waiting for the answer.
 * - `eof`: the consumer closed stdin before responding (stdin line protocol).
 * - `error`: the approval callback itself threw.
 */
export type ApprovalResolvedReason = "user" | "aborted" | "eof" | "error";

/**
 * What a resolver hands back to the executor. A plain boolean still works
 * (treated as `{ approved: <value>, reason: "user" }`) for callers that
 * don't care about distinguishing EOF/aborted; responders that need to
 * signal "stdin closed mid-run" return `{ approved: false, reason: "eof" }`.
 */
export type ApprovalAnswer =
  | boolean
  | { approved: boolean; reason?: "user" | "eof" };

export interface ApprovalResolvedEvent {
  toolCallId: string;
  toolName: string;
  approved: boolean;
  reason: ApprovalResolvedReason;
  /** Optional human-readable detail for the `error` reason. */
  error?: string;
}

/**
 * Resolves the pending approval request. Implementations live in the CLI
 * (readline, stdin line protocol, or always-true under --auto-approve).
 */
export type ApprovalCallback = (
  request: ApprovalRequest,
  signal?: AbortSignal
) => Promise<ApprovalAnswer>;

/**
 * Small injected seam so `Executor` can emit stream-json approval events
 * without depending on `AgentLoop`. The CLI's `AgentLoop` implements this by
 * calling its own `emit(...)` with `approval.request` / `approval.resolved`.
 */
export interface ApprovalNotifier {
  notifyApprovalRequest(request: ApprovalRequest): void;
  notifyApprovalResolved(event: ApprovalResolvedEvent): void;
}