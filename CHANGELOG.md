# Changelog

All notable changes to Anita are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0]

### Added

- **`approval.request` / `approval.resolved` stream events.** Every approval
  gate now emits a structured event pair around the user/consumer decision,
  in every mode (including `--auto-approve` and human TTY mode). The `id`
  field matches the surrounding `tool.call` / `tool.result` lifecycle, and
  `input` is the structured object (not a pre-rendered string).
- **Stdin line protocol for `--stream-json` approvals.** When stdin is a pipe
  and `--stream-json` is active, the CLI no longer writes a prompt to
  stdout/stderr. Consumers answer by writing a single JSON line:
  `{"type":"approval.response","id":"<toolCallId>","approved":<bool>}`. The
  resolver discards mismatched/malformed/unknown lines (logged to stderr) and
  resolves `false` with `reason: "eof"` when stdin closes mid-run.
- **`--auto-approve --stream-json` audit trail.** The audit events still
  fire, so consumers see `approval.request` + `approval.resolved: { approved: true, reason: "user" }` even when the user never interacts.

### Changed

- **Approval callback shape is now `(request: ApprovalRequest, signal?) => Promise<ApprovalAnswer>`.**
  The positional `(toolName, input, signal)` shape is replaced by a single
  object with `toolCallId`, `toolName`, and `input`. The return type was
  widened from `boolean` to a discriminated `ApprovalAnswer` so a resolver
  can distinguish "user said no" from "stdin closed mid-run" (returns
  `{ approved: false, reason: "eof" }`). A plain `true` / `false` is still
  accepted and treated as `reason: "user"`. Callers that wired a custom
  `ApprovalCallback` (e.g. tests or third-party integrations) need to
  migrate. Public API in the CLI was updated in lockstep.

## [0.3.0]

- Rename project from Ada to Anita (#70).
- Refine static system prompt guidance (#71).
- Move runtime context into the system prompt and log assembled prompt (#72).
- Clean up model option labels (#73).
- Forward `AbortSignal` to approval prompt so Ctrl-C cancels it (#67 / #76).
- Add `--system-prompt` CLI option (#68).
- Update Ollama Cloud models (#69).