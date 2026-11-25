# Claude process reuse and command authority

Status: proposed design, 21 November 2026. No process-reuse activation or live
model qualification. Slice `4fcd333fd42e7587`; ordinary contributor recovery of
the unavailable original session, with canonical ownership unchanged.

## Baseline and retained work

Source baseline: `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`. The existing
`ordinary-local-vertex-sdk-query.ts` owns the joined query stream, closes the
native process for each successor command, and gives every query its own sealed
`SdkCallbackState`. The FIFO owner allocates an execution before input release,
binds the frozen tool ceiling after `apply`, and acknowledges the exact stdin
UUID. These fences must survive reuse.

PR #1417 adds uncertain-operation descriptors and query-loop diagnostics; #1418
settles restart-interrupted commands from durable delivery evidence. Both remain
unmerged at investigation. Do not duplicate their recovery or settlement paths.
Accepted trace attribution from #1425 is already on main and stays intact.

Reuse the wakeup specification in PR #1423 (head
`9571e05bf3801440d779a233e7db982e69cb27ca`) and the task-UI contributor's retained
`background-task-ui-contract.md` (slice `91669d3dc6549c74`). They do not authorize
autonomous wakeups or a task-only Stop endpoint. Background tasks remain disabled
in ordinary production chat until the producer contract is qualified.

## Required design

Separate process generation from command generation. A process owns its pipes,
native query, input queue and task identities. Each admitted command owns a fresh
immutable callback scope, trace context, execution token, input UUID and frozen
tool ceiling. Completing a command seals and settles its callbacks permanently;
starting another command never mutates or reopens that scope.

Before yielding stdin, retain the current deep authorization, account identity,
synchronous generation check and `beforeInput(commandId)` fence. Cancellation
before release consumes no native input. Each await is followed by the original
authority check. The next command cannot start while callback settlement or
uncertain dispatch remains unresolved.

Every hook, permission callback and managed MCP call must resolve the originating
command from a native witness, not from a mutable latest-command pointer. Capture
that scope before awaiting and recheck it before effects and response delivery.
Late callbacks keep the old scope and refuse; captured Stop targets include both
process and command generation so an old interrupt cannot stop a successor in
the same process. A bounded provenance registry fails closed on ambiguity or
capacity exhaustion and is cleared only at confirmed process retirement.

Terminal events require the same input identity. Duplicate, missing, foreign or
old UUIDs cannot settle a current FIFO entry. Preserve existing resume housekeeping,
peer late-steer handling, callback uncertainty and persistence-loss diagnostics.
Retirement remains a host-created event, never an unverified provider claim.

Unchanged effective settings can reuse a qualified idle process. Model/mode
changes may use documented controls only after acknowledgement and revalidation.
Thinking/effort changes without an equivalent live control, system/context refresh,
changed tools/MCP configuration, account/credential identity change, incompatible
runtime selection, failed control acknowledgement, transport failure and explicit
process retirement require a fenced restart. Never retry an uncertain input.
Account/credential changes first invalidate the existing owner; replacement must
come through normal runtime admission, not an in-place credential swap.

Context comparison must use the existing prepared context owner, without borrowing
credentials or updating another task checkout. A required refresh cannot be skipped
to keep tasks alive. Restart seals command scopes, stops accepting stdin, closes
the old process and waits for confirmed close before creating its replacement.
Closure timeout or error refuses replacement and records the failing stage.

## Current transport qualification gap

An offline probe of the pinned SDK `0.3.322` and its bundled Claude Code `2.1.322` used two
explicit UUID-stamped messages, an isolated temporary HOME/configuration and a
loopback Messages API returning fixed text. No model service was contacted.

Observed order for each message:

1. `UserPromptSubmit` with a new `prompt_id`, different from the submitted UUID.
2. Top-level `user` replay with the exact submitted UUID.
3. Assistant frame with `user_message_uuid` / `user_message_uuids`.
4. `Stop` hook with the same native `prompt_id` as step 1.
5. Result frame with the submitted message identity.

The hook includes session, transcript path, cwd, permission mode, prompt ID and
prompt text. It does **not** include the stdin UUID or `source`, although the
TypeScript SDK declares an optional source field. A declared field is not a
runtime capability. The SDK MCP transport dispatches by server name and MCP
request ID; those alone do not prove a command generation.

Consequently a naive current-state callback proxy would grant an unsolicited or
late turn the successor's authority before the exact input echo arrives. Prompt
text/prefix matching, queue order, an SDK source label alone, or assigning the
first native prompt ID to the pending command do not establish the required
identity. Waiting inside the hook for the later echo deadlocks the normal path.

Before enabling reuse, qualify a native pre-effect witness binding input UUID,
native prompt ID, process generation and tool/MCP invocation identity. It must
distinguish queued operator input, peer input and autonomous task notifications.
It must be delivered before hooks/model work and remain valid for delayed work.
Do not silently fall back to latest-command authority when the witness is absent.
An SDK/CLI capability addition or a separately verified existing native contract
is required; the offline probe is evidence of the current gap, not proof that no
possible transport can supply it.

## Producer contract for UI and wakeups

Keep the existing task/run/parent-tool receipts and durable event path. An execution
key must include conversation, process generation, task ID and verified run/launch
identity. Never key by task ID alone. Opaque IDs are identity, not ordering.

- Task lifecycle and observation availability remain separate. Lost observation
  or process replacement does not prove a task stopped. `restart_stopped` requires
  authoritative terminal evidence; otherwise preserve output and show unavailable.
- Stop requests name the exact execution and stable request identity. Revalidate
  authority/generation at dispatch, call only that owner's `stopTask`, and retain
  refused/uncertain receipts. Acceptance is not terminal cancellation evidence.
- Wakeup admission/attempt status is separate from task status. A task notification
  cannot revive a sealed callback scope or consume a queued operator command.
  The #1423 launch-authority, deduplication and policy gates remain in force.
- Until the native witness and durable producer are qualified, consumers may use
  retained verified receipts; they must not expose a fabricated Stop capability,
  running wakeup status or process-survival claim.

## Test-first implementation and acceptance

1. Retain a deterministic real-CLI offline probe as a regression: two inputs in
   one process, exact echo/result identity, hook ordering and missing binding.
   Stub provider responses, isolate all runtime directories and disable external
   telemetry. Exercise the supported wrapper with controlled native streams for
   stale callbacks, cancellation, restart and late-result isolation.
2. Obtain independent review of the witness and scope-binding design before
   replacing authority isolation. A reviewer must explicitly assess native MCP
   calls, ambiguous/missing identities, peer steering and background notifications.
3. Once qualified, add failing real-adapter tests for same-process consecutive
   commands, stale hook/permission/MCP callbacks, Stop races, account revocation,
   failed controls and required restart. Implement and commit tests with behavior.
4. Integrate the producer with existing task consumers, then prove task survival
   using an offline controllable Bash process across the next explicit message.
   Live Claude qualification still requires separately approved model/account.

CI and Centaur exact-head final LGTM/merge remain landing gates. Neither source
publication nor source merge activates the deployed runtime. Current recovery
work grants no merge, production activation or live model calls.

## Executed evidence and review status

`server/__tests__/claude-cli-process-reuse-offline.test.ts` passes three tests
against the actual bundled CLI, with a synthetic child environment and loopback
provider. Two inputs use one spawned process; the hook/echo ordering and missing
UUID binding above are asserted. Refusing the prompt hook produces zero provider
requests. A real background Bash task survives the second input, reports `stopped`
after exact `stopTask(taskId)`, and the same process answers a third explicit input.
This qualifies native mechanics, not Mitzo's command authority or deployed behavior.

The existing `ordinary-local-vertex-sdk-query.test.ts` (44 tests) and
`ordinary-local-vertex-sdk-process.test.ts` (2 tests) also pass. They retain the
current restart, stale-callback, authority, Stop and close-proof boundaries.
These are baseline regression checks, not new process-reuse implementation.

Run the three suites with one Vitest worker and `NODE_OPTIONS=--max-old-space-size=1024`.
The native tests skip when the optional platform CLI executable is absent; that
skip is not qualification. All three native cases executed successfully on macOS
arm64 with Node 24.22.3. No paid/live provider test ran.

Independent design review was requested through Symposium on the selected personal
Astra/high route, request `1e6bc61a-26af-4613-a550-e308b1a3aa8c`. Authorization
returned `policy_not_approved`; nothing was authorized and no reviewer contribution
was produced. The request was not retried. Design review remains a gate before
authority implementation. This draft preserves the investigation and executable
qualification while that gate and the native witness remain unresolved.
