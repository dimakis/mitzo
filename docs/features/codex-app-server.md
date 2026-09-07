# Codex app-server integration: preflight foundation

Status: internal foundation only. **Not connected to `chat.ts`, not in the account
catalog, and not available for mobile execution.** This route uses a managed
ChatGPT login; it is separate from the direct Responses API adapter and its API
billing. Neither route falls back to the other.

## Current implementation

`server/codex-app-server-client.ts` owns a private stdio JSON-RPC connection. It
initializes once, correlates responses, bounds incoming frames, rejects pending
requests on process exit or protocol failure, and closes on timeout without
retrying an uncertain request. Unhandled server requests receive an error;
notifications are discarded in this preflight implementation. This transport is
not an execution adapter. It has no event, approval, or tool dispatch callbacks.

Launch requires an explicit absolute Codex login directory. Only a small host
environment allowlist is passed to the child; inherited API keys and alternate
provider variables are excluded. CLI overrides request ChatGPT authentication and
the OpenAI provider. No login, logout, token copying, or model request happens
automatically. The selected Codex directory still supplies its own configuration;
the environment allowlist is not a claim that arbitrary user configuration is safe
for execution.

`server/codex-account.ts` reads account metadata and compares exact configured
email and plan values. It rejects absent, API-key, Bedrock, and mismatched accounts.
The returned application binding includes provider, account ID, model, and a hash
of the login reference/email/plan. It rejects a changed stored binding before
contacting the process. Callers must persist this binding privately, initialize
and close the connection, and recheck before each turn and after restart.

This is **not durable lifecycle wiring**. The installed CLI 0.153.4 account schema
exposes email and plan, not stable workspace identity. A shared login can also be
changed externally between preflight and execution. Execution must resolve those
identity/race questions rather than treat email matching as full account pinning.

## Required execution boundary

Mitzo's skill ceiling and worktree checks run before each supported native tool.
Codex approval callbacks alone do not supply the same contract. The current
[official hook documentation](https://learn.chatgpt.com/docs/hooks) covers most
local tools but explicitly notes specialized paths can opt out and `write_stdin`
does not run `PreToolUse` again. Hook error handling also requires care: unsupported
decision fields do not block a tool.

Before connecting dispatch, implement and test a complete supported-tool boundary:
either a constrained tool surface whose calls all reach Mitzo, or a verified hook
bridge plus disabling every bypass path. Unknown tools, background input,
subagents, and MCP calls need explicit handling. Prompt instructions alone do not
replace enforcement. Do not enable execution while this remains unverified.

## Remaining lifecycle and acceptance

- Canonical application IDs mapped privately to Codex thread IDs, separate from
  SDK IDs and Responses IDs; durable identity/model binding before side effects.
- `chat.ts` and `ws-handler-v2.ts` dispatch, persisted public events, durable
  follow-up queue and command deduplication, per-turn skill policy, permission
  routing, stop/interrupt/closeout, restart/resume, and reconnect snapshots.
- ContexGin boot/task context, configured MCP clients and cleanup, multi-repo
  worktrees and environment, project hook parity, preserved Vertex execution.
- Explicit account/provider/billing labels before launch and on bound tasks,
  unsupported capability gating, actionable retry, preserved drafts/task metadata,
  visible permission/cancellation/queue state, and explicit uncertain outcomes
  after restart without automatic side-effect replay.
- Isolated dev-server validation, live ChatGPT execution, mobile layout and
  physical-phone acceptance before activation. Sign-in inspection is not an
  execution or subscription-entitlement test.
- Direct Responses lifecycle wiring, richer tools/background processes,
  filesystem races, bounded long-history/differential persistence, images,
  compaction, and reasoning-summary UI remain separate incomplete work.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server).
The local CLI-generated schema should be rechecked on version changes.

Account email matching deliberately requires the exact provider-reported value. Configure that value verbatim; preflight does not assume that differently cased login identifiers are interchangeable. The profile revision also retains the exact configured identity.
