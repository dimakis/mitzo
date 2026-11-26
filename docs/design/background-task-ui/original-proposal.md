# Background task chat presentation — proposed consumer contract

Status: investigation and proposal only, 21 November 2026. No product code,
rendered test, device check, commit, or PR has been produced for this slice.

Work: Telos slice `91669d3dc6549c74`; ordinary contributor chat
`d3f3cac7-95df-8a17-8419-fb9e6e880a11`. Canonical ownership is unchanged.
Dependencies: process reuse `4fcd333fd42e7587`, wakeup `cbd03d334b6bf3fc`.

## Source baseline and existing work

GitHub main was `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772` at investigation.
The local source checkout is older; the observations below use `git show` and
`git grep` against that exact main commit, not its working tree.

- `server/query-loop.ts:1998`: SDK task starts already correlate `task_id`,
  `run_id`, and `tool_use_id` to verified parent tools. Duplicate and stale starts
  cannot reopen a completed tool. Notifications require matching observed runs.
  `stopped` currently becomes the subagent status `cancelled`.
- `server/query-loop.ts:2379`: query retirement publishes unavailable outcomes;
  it explicitly does not establish that background execution stopped.
- `server/__tests__/sdk-task-run-consumer.test.ts`: existing offline fixtures
  exercise duplicate, missing, conflicting, late and resumed run receipts through
  both protocol parsing/reduction and durable transcript reconstruction.
- `server/chat.ts:2473`: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` remains in place
  pending this feature. This presentation slice must not remove that protection.
- `server/chat.ts:6010`: parent interruption uses the captured runtime's
  `stopTask(taskId)` for its active children, with failure diagnostics and runtime
  ownership checks. This is not a verified task-only browser endpoint.
- `frontend/src/components/SubagentCard.tsx`: retained output and statuses exist,
  but no task-specific Stop action or restart-stopped reason is presented here.
- `frontend/src/hooks/useNativeSubagents.ts` and `NativeSubagents.tsx`: Codex native
  child inspection/control already use authenticated conversation-scoped routes,
  uncertain control receipts and retained output. They are not interchangeable
  with Claude SDK background tasks. Reuse their interaction principles without
  inventing a native-child identity for an SDK task.
- `packages/protocol/src/ws-schemas.ts`: existing generic `stop` is a parent-chat
  control. A task button must not silently stop the parent conversation.
- Open PR inventory returned 62 entries. #540 concerns broader Codex admission,
  reconnect and runtime work; its title alone does not establish implementation
  of this slice. #1338 concerns native subagent reachability. Inspect exact changed
  files for overlap before editing; no exhaustive duplicate-work clearance yet.

## UI behavior

Use lightweight transcript entries grouped with the launching command, plus a
compact discoverable list of running tasks in the existing chat status area.
Both views select the same task record; they must not duplicate event history.
Completed entries remain in the transcript after navigation and reconnect.

Each entry shows command or description, explicit state, and latest output when
present. Expand output in place with the existing disclosure/motion pattern.
Render output as inert text with bounded scroll/wrapping and an explicit
truncation notice. Preserve the last output on failures and stream loss.

| Evidence/state | Visible text | Task action |
| --- | --- | --- |
| Verified running task | Running | Stop, when current authority permits |
| Stop request in flight or accepted | Stop requested | No duplicate submission |
| Verified success | Completed | Retained output |
| Verified failure | Failed | Retained output and safe diagnostic |
| Verified operator cancellation | Cancelled | Retained output |
| Verified stop caused by process restart | Stopped after restart | Retained output and reason |
| Connection/ownership loss without terminal evidence | Status unavailable | Refresh status; no inferred completion or stop |
| Stop refused | Stop unavailable, with safe reason | Refresh current authority |
| Stop response lost | Stop outcome unconfirmed | Recover the original request |

Stop acceptance is not a terminal task state. A later terminal event settles the
entry. A newer operator message does not itself prove task death. A stream reset
does not erase known output or translate missing records into success.

Use existing shared typography, semantic tokens, UiIcon, MotionPresence and
controls. Preserve composer drafts and scroll position; do not auto-scroll users
away from older messages. Announce state changes politely, not every output byte.
Keep keyboard focus stable and Stop touch targets at least 44px on phones.

## Proposed normalized event contract — not a fixed producer API

Prefer an additive extension of the existing durable protocol and consumers over
an independent ephemeral task feed. Exact wire names and placement require the
process-reuse contributor's agreement before implementation.

The consumer needs these semantics:

- Identity: conversation/session ID, opaque runtime/process generation, task ID,
  native run ID when available, and verified parent tool/launch command reference.
  The producer must define a stable task-execution key. Never key by task ID alone
  or infer ordering from opaque identifiers.
- Ordering: durable event identity/sequence and monotonic revision within that
  exact execution. Replayed or older updates cannot reopen a terminal execution.
  Reused task IDs in another process/run are distinct executions.
- Presentation: safe description/command, running or terminal lifecycle state,
  bounded latest output, truncation indicator and observation timestamp.
- Terminal evidence: explicit reason distinguishing successful exit, failed exit,
  operator cancellation and confirmed process-restart stop. Unknown outcomes
  remain unknown; process replacement alone is not a child-exit receipt.
- Control capability: server-derived availability for this exact execution and
  an opaque ownership/revision binding. It is display data, not client authority.
- Recovery: a durable snapshot/replay path including terminal records and enough
  identity to reconcile events arriving during snapshot hydration.

Conceptual state is `running | completed | failed | cancelled | restart_stopped`.
Observation availability and Stop request delivery are separate fields, not
invented successful lifecycle transitions. The eventual wire schema can express
restart-stopped as a terminal state plus reason if that fits existing protocol.

Wakeup attempt identity/status remains separate from task state. The wakeup
contributor proposed launch authority references, independent attempt/turn IDs
and dedup receipts, with admitted/refused/completed/failed wakeup outcomes.
Neither a successful nor failed wakeup ends the parent session or changes the
task's terminal result. Stop/new operator-message authority invalidation belongs
to the owner-side process contract, not to a browser reducer.

## Stop integration boundary

Reuse existing authenticated conversation ownership and cancellation services.
The browser sends a stable request ID and exact execution identity; the server
revalidates owner, runtime generation and task at dispatch. An unavailable,
replaced or ambiguous owner must refuse instead of cancelling a replacement.
The SDK implementation should ultimately reach the verified runtime's existing
`stopTask(taskId)` primitive. No generic parent Stop fallback is acceptable.

The investigation has not established a supported task-only SDK browser route.
Its adapter/receipt contract is an integration dependency, not delivered UI
functionality. Do not invent a URL or claim an operational Stop button from a
fixture. On lost responses retain the exact request and inspect its receipt;
do not create another request automatically.

## Test-first implementation sequence

1. Add consumer tests first, demonstrate the expected failure, then implement
   the additive protocol/reducer support. Cover replay and live parity, duplicate
   and stale events, cross-session isolation, reused task IDs across generations,
   old-run late receipts, terminal-before-snapshot races, output retention and
   unknown outcomes. Extend existing SDK task-run tests where they already own
   the behavior. Commit passing test and implementation together.
2. Add rendered interaction tests first, then implement the shared transcript
   presentation. Exercise every row above, actual expand/collapse and Stop
   interaction, refused/lost responses, stable request recovery, double clicks,
   navigation during pending control, keyboard focus and long output.
3. Add a real backend-to-consumer offline integration test using a controllable
   process fixture and actual ownership/cancellation adapter. Assert task-specific
   Stop reaches only the exact runtime and leaves the parent/other task alive.
   Assert restart stops appear only from explicit authoritative evidence and
   survive cold replay. Merge the producer contract only after coordination.
4. Run relevant unit/integration checks plus required `npm run test:design` and
   `npm run test:ui`. Inspect phone/desktop widths, light/dark, alternate
   accent/font, scrolling and large text. Record screenshots and test commands.
   Check the iOS runtime/device separately; WebKit/mobile emulation is only
   browser evidence and must not be labelled a physical iOS check.

All tests above are planned, not executed. Fixture UI evidence, integrated
offline evidence, iOS evidence and optional paid live-model evidence must be
reported separately. No paid live model tests are authorized by this proposal.

## Current blocker and continuation

Managed preparation returned `resource_exhausted / preparation_capacity` with
`effectStatus: not_started`, diagnostic `d407da14-ae47-4a07-a220-83003d2dff71`.
The filesystem reported 117 GiB available. No task checkout was materialized.
TaskExecution status returned no grants. Existing work has been preserved.

The coordinator received the blocker and the request for the process-reuse
contributor's identity. The wakeup contributor independently reports the same
capacity failure. Resolve preparation capacity through supported recovery before
retrying; do not retire another contributor's checkout or allocate a replacement
to escape the failure. After materialization, honor the completed-turn adoption
boundary, inspect fresh instructions and main/open PR state, and obtain/reuse
TaskExecution authority for the admitted checkout.

Coordinator follow-up attributes this error to the per-account limit of eight
unfinished standalone preparations in release `805fbd9c9e4c`, rather than disk
capacity. The coordinator reports no exposed inventory/retirement tool and has
routed the recovery investigation to the Telos E2E contributor. This is peer
evidence, not a completed recovery. The process-reuse proposal has no confirmed
live contributor or agreed contract yet.

Consumer review sent to the wakeup contributor also requests explicit reservation
crash recovery and attempt-cap semantics (reserved/refused/admitted/completed),
safe display references instead of credentials/authority internals, monotonic
attempt receipts, and a distinction between admission and provider acknowledgement.
The suggested three-attempt cap and time/push policies remain proposals.

Delivery remains pending: working UI, real task Stop integration, browser/iOS
evidence, logical commits, draft PR, CI and Centaur exact-current-head final
LGTM/merge recommendation. This ordinary contributor has no merge/deploy grant.
