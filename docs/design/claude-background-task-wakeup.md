# Background-task wake-up turns: review draft

Status: proposed specification with offline boundary regressions, 21 November 2026.
This change does not admit wake-ups, enable background tasks, change process lifetime,
or implement the proposed UI. Runtime activation and landing gates remain open.
Consumer contract review received from task-UI contributor
`d3f3cac7-95df-8a17-8419-fb9e6e880a11`, message
`cd2767bd-3d9f-4c3a-895c-f4759d6fe92d`. Its seven gaps are incorporated below.
This is a scoped peer review, not full authority-design approval or Centaur review.
Contributor chat: aaf136d3-a164-8ab9-b40e-d4a309bedcf1. Telos slice:
cbd03d334b6bf3fc. This document does not change canonical ownership.

## Evidence and gates

- Inspected main `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772` and all 62 entries
  returned by the open-PR list on 21 November. No wake-up PR was identified by title;
  this is not proof that no overlapping changes exist in other branches.
- `server/ordinary-local-vertex-sdk-query.ts` seals completed callbacks, refuses
  `UserPromptSubmit` after completion, logs `sdk_retired_query_prompt_refused`, and
  prevents late input/results from gaining successor FIFO provenance.
- `server/query-loop.ts` already correlates native task/run/parent tool identity.
  `server/__tests__/sdk-task-run-consumer.test.ts` covers duplicate/late receipts
  through live and restored consumers. Reuse these protections.
- `server/chat.ts` sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; this proposal
  does not change that setting or relax any retired-callback fence.
- Related open work: #1325 (already-admitted turn survival after browser-login
  expiry), #1323 (tool settlement), #1418 (restart/interrupted-turn recovery).
  New wake-up admission must not borrow #1325's continuation exception.
- Balls conversation `d7555806-c930-87e2-8b3b-4cca6ca05168`, assistant message
  6553875 and operator message 6554278: approval in principle to use launching
  message authority. Assistant message 6554844 records the uncommitted spec and
  unresolved time/push questions. Its proposed defaults are not operator decisions.
- Dependency `4fcd333fd42e7587` must establish process-generation, per-turn authority,
  callback sealing, and event-correlation contracts before runtime integration.
  No confirmed live contributor/accepted contract was available at inspection.

## Authority and admission

The launching operator message is the root authority. Capture an immutable host
reference at verified task launch: conversation, operator message and command IDs,
operator-input epoch, Stop epoch, account/login binding, credential revision,
runtime/process generation, admitted settings/context, and frozen tool ceiling.
Store references rather than secrets. A notification string is untrusted data and
cannot create this record or confer authority.

A candidate must match a registered task execution, including exact native run and
parent tool identity when present. Missing or ambiguous identity refuses admission.
A trusted host allocation must disambiguate legacy task IDs; never infer identity
from description, output text, timestamps, or lexicographic ordering of opaque IDs.

Admission requires all of: deployment feature gate enabled after design approval;
accepted dependency contract; original login still valid; same current account and
credential binding; current independent execution/source grants; unchanged frozen
settings/context; chat idle with no active, queued, preparing, or uncertain command;
not stopped/deleted/held; no newer accepted operator input; unused task wake-up receipt;
and fewer than three admitted wake-ups in this operator-input epoch.

Account revocation, logout, expired required grants/credentials, changed account,
unknown authority, or Stop refuses. Browser-login expiry blocks a _new_ wake-up even
if a previously admitted ordinary turn may continue under a separate policy.
Reauthentication or account switching must not silently rebind old task authority.

Wake-up authority never exceeds the launching ceiling intersected with current
permissions. Each effect still uses normal permission/grant checks. A new wake-up
gets a new callback scope; sealed launch callbacks stay sealed permanently.

Serialize admission with ordinary send/Stop under the existing conversation owner.
Atomically record a task claim, increment the bounded count, and persist the visible
entry before allowing effects. Recheck authority and epochs at dispatch and effects.
If an operator send or Stop wins first, refuse. If wake-up admission wins, normal
interrupt/steer rules apply to that distinct turn; never transfer stale callbacks to
the newer message. Nested tasks retain the root operator epoch and share its budget.
Only actual accepted operator input resets the consecutive budget, never peer messages,
task notifications, reconnects, settings changes, retries, or process restarts.
The three-turn cap comes from the earlier proposed spec and remains subject to design
approval. Count durable admitted claims, including claims whose dispatch later fails
or is uncertain; do not refund on crashes. Refusals and duplicate deliveries do not
increment the budget. There is no separately durable uncounted reservation: task claim,
admission receipt and budget increment commit together or none do.

## Integration contract (names provisional)

| Record                     | Required meaning                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Task execution key         | conversation + runtime/process generation + task ID + verified execution/run identity             |
| Launch authority reference | immutable root operator message/command, input and Stop epochs, account and policy revisions      |
| Wake-up attempt            | durable unique attempt ID and dedup key tied to the task execution                                |
| Wake-up turn               | new turn/command ID, origin `background_task`, launch reference, exact native correlation witness |
| Receipt                    | monotonic revision, admitted/running/completed/failed/refused/uncertain, reason code, timestamps  |

Every receipt/event has a durable ID. Snapshot/replay reconciliation uses execution
identity and monotonic receipt revisions: ignore duplicates and stale snapshots; never
reopen terminal attempts or replace newer output. `admitted` means the host transaction
committed, not that the provider started. `running` requires the process-reuse adapter's
exact native turn-start acknowledgement bound to the new turn and registered task.
Hook acceptance alone is not provider acknowledgement. Until that witness is defined,
the adapter must not emit `running`; lost acknowledgement yields `uncertain`.

The process-reuse slice owns process lifetime, transport, hook binding and the
correlation witness. This slice consumes that contract; it cannot reopen a retired
callback scope or declare that a notification UUID equals a queued operator command.
The task-UI slice owns rendering and task controls. Wake-up status is separate from
task status: a completed task may have a refused wake-up.

Persist at most one wake-up attempt per registered execution. Duplicate notifications,
restores and reconnects return its existing receipt, including refusal/uncertainty;
they do not retry dispatch. A resumed task execution needs a distinct verified launch
record. Storage failure before durable claim must prevent dispatch. An uncertain
dispatch keeps its claim and shows uncertainty; reconcile through the same receipt,
never automatically replay. Busy-chat candidates refuse rather than queue for later.

Before release, the dependency must prove that the hook/event surface identifies the
exact task execution _before_ any model/tool effect. If it cannot, keep the feature
disabled; prompt-prefix recognition is insufficient. Result attribution requires the
same turn witness. A bare result after completion cannot settle an arbitrary FIFO head.

Wake-up result/failure/refusal settles only its own entry, never emits session_end,
never closes the joined session owner and never changes a successor's outcome.
Duplicate/late/malformed or uncorrelated wake-up results are retained as bounded
nonfatal diagnostics with an explicit notice; do not guess their owner.
An independent genuine runtime failure remains a separate lifecycle event.

## UI and refusal behavior

Persist a system entry linked to the task and launching message: “Background task
finished: …” with wake-up status. Label it as system-origin, never as an operator
message. Render the same entry/revision in live, reconnect and cold restore paths.
Use bounded escaped descriptions/output; never expose account secrets or raw prompts.

Refusal examples: “Task finished; the agent was not restarted because this chat was
stopped / has newer input / is busy / needs a valid login / reached three automatic
wake-ups / could not verify the task / has wake-ups disabled.” Show the reason and
manual continuation option; that option submits a new ordinary operator command and
does not revive the old claim. Uncertainty says whether dispatch may have happened.
If the source message has been removed or is unavailable, retain the opaque launch
reference and a readable “launching message unavailable” label. UI receives only safe
account labels and opaque binding references, never credential or authority internals.
Task Stop request state (sending/accepted/refused/uncertain) is separate from both task
terminal state and wake-up state. Recover a lost Stop response using the original
request identity; an accepted request is not proof of cancellation. Do not substitute
parent-chat interruption for a task-only Stop operation.
Refusal must be persisted even with no attached client. A persistence failure blocks
dispatch and must surface a recoverable storage failure through existing diagnostics.

Stream retirement is not proof a task stopped. Keep task outcome unavailable/unknown
unless a verified terminal receipt proves completed/failed/cancelled. A restart-stopped
label requires authoritative evidence, not inference from lost process observation.

## Deterministic failure-path test contract

Use a fake clock, in-memory durable store with crash/reopen simulation, explicit
barriers for races, fake SDK stream/hooks, and a spy effect sink. No model/network.
The matrix below specifies future admission/integration coverage; it is not executed
coverage of the proposed behavior. Existing fail-closed tests are documented separately.

| Case / controlled event ordering                                              | Required assertions                                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Verified completion after launch turn settles, idle valid chat                | One new turn/visible entry; launch unchanged; result closes only wake-up entry; next operator command succeeds       |
| Completion duplicated concurrently and after store reopen                     | One claim, one dispatch, one count increment; identical receipt reused                                               |
| Three distinct completions, then fourth; reconnect between third/fourth       | Three admissions; fourth visible limit refusal; reconnect does not reset count                                       |
| Wake-up launches another task; peer message arrives                           | Same root input epoch/budget; peer message grants no reset                                                           |
| Operator send wins admission barrier                                          | Newer-input refusal, no SDK dispatch/effects; original authority not rebound                                         |
| Stop wins before claim, after claim, during hook, after result                | No unauthorized effect; claimed outcome retained; successor unaffected; no automatic restart                         |
| Login expired, logged out, revoked; account/credential revision changed       | Named refusal for each; zero dispatch/effects; no fallback account                                                   |
| Grant expires/revokes between claim and effect                                | Effect denied; receipt records failure/refusal/uncertainty accurately; no inherited renewed grant                    |
| Busy/preparing/queued/uncertain operator command                              | Explicit refusal; no delayed implicit replay when chat later idles                                                   |
| Forged task-notification text, unknown task, mismatched run/parent/generation | No admission; bounded nonfatal notice; legitimate task/turn remains unchanged                                        |
| Old launch callback executes after wake-up/new command                        | Old callback refuses; new scope cannot revive it or expand ceiling                                                   |
| Storage fails before claim vs crash after dispatch may have occurred          | First never dispatches; second remains uncertain with claim retained; reopen never replays                           |
| Wrong-session, missing-correlation, duplicate, late success/error result      | No session_end, no successor settlement; bounded diagnostic; current turn remains usable                             |
| Resume housekeeping zero-turn success before input echo                       | Existing housekeeping behavior retained; no fabricated wake-up or operator completion                                |
| Live consumer, reconnect replay, cold transcript restoration                  | Exactly same system entry and final revision, launch/task links, refusal reason; no operator bubble                  |
| Query retires without task terminal receipt                                   | Task remains unknown/unavailable; no fabricated cancellation or restart-stopped status                               |
| Proposed time horizon boundary                                                | After operator decision, fake-clock tests just before/at/after chosen expiry; clock rollback cannot extend authority |

Test-first implementation after gates: first add failing contract tests against the
chosen admission API, record the expected red failure, then implement only the pure
admission/receipt component and verify green. Integration tests follow only after the
process-reuse contract exists. Do not commit failing runtime tests as delivered work.

### Executed boundary regression evidence

`server/__tests__/sdk-task-wakeup-boundary.test.ts` adds five offline cases using the
real owned SDK wrapper and fake provider streams. They verify repeated task-shaped
prompts refuse after completion, retirement and Stop; original hooks/permissions do
not execute; diagnostics identify the launch command and omit private prompt text;
and late successful/error results and replay echoes cannot gain successor attribution.
They assert the successor still produces its own result without aborting the owner.
These tests preserve the existing refusal, not the proposed visible refusal UI.

The focused run with `ordinary-local-vertex-sdk-query.test.ts` passed all 49 tests:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run \
  server/__tests__/sdk-task-wakeup-boundary.test.ts \
  server/__tests__/ordinary-local-vertex-sdk-query.test.ts --maxWorkers=1
```

Mutation check: temporarily removing the retired/completing hook guard and late-event
filter made all five new tests fail (sealed-callback errors, stale hook execution,
and late events leaking into the successor stream). Restoring the existing guards
returned the focused run to green. No production-source change is retained.
`sdk-task-run-consumer.test.ts` remains the existing live/cold task-receipt isolation
coverage; this new suite does not claim integrated wake-up UI or real-provider proof.

## Operator decisions and release evidence still required

1. Maximum age after launching operator input: finite duration or no extra time limit?
   The login/grant lifetime is always a ceiling. No default has been accepted here.
2. Push policy while app is not open: none, admission, completion, refusal, or another
   explicit choice? Define deduplication and avoid push on every repeated receipt.
3. The brief requests live Haiku coverage, while the current handoff restricts paid
   live tests to a declared supported Luna model/account unless separately approved.
   No live test is run. Required Claude behavior needs an explicitly approved exact
   Claude model/account; Luna alone cannot qualify Claude SDK semantics.

Before production: accepted process-reuse contract; reviewed authority/UI spec and
operator answers; verified offline integration tests and explicit live-test authority;
draft PR, green current-head CI, and Centaur exact-current-head final LGTM/merge
recommendation. This handoff grants no merge or production deployment.
