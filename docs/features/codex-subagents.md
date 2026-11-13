# Native Codex subagents

## Message delivery repair (13 November 2026, implementation draft)

Dimitri reported a rejected message to Peirce in conversation
`579125a3-8afc-807e-8369-2300f662515c`. The screenshot shows a retained draft and
unavailable messaging, but the original control path discarded its exception.
Retained public history and inspected logs do not establish that attempt's native
failure cause. Do not treat the regression below as a historical diagnosis.

An offline regression reproduces a separate control race: the child completes
while the original owner prepares a steer, before the exact dispatch fence.
The message now starts an idle-child turn under the same request after checking
authority again. Only this undelivered transition is retried, once; a dispatched
message or uncertain response is never sent again automatically. Parent Stop,
owner changes and policy revocation retain their existing fences.

Rejected and uncertain controls now retain a sanitized diagnostic with stage,
request identity and correlation reference in the existing child snapshot and
logger. The child dialog exposes details and Refresh activity while preserving
the draft. Logs retain the RPC category/code rather than provider payloads or
message text. The authenticated-route integration regression verifies delivery
of the actual adapter failure through the feed and user interface.

The focused control/store/route/feed/integration batch passed 91 tests; design
checks passed 109 with one skip. Verification is offline. Exact historical
reproduction, final hosted CI, source acceptance and production activation remain
separate and unverified at this draft milestone.

## Inspection repair (11 November 2026)

Owned admissions validate a model and thinking-level pair. Native subagents
remain enabled only for eligible owned Local Mac Codex sessions; OpenShell and
adviser sessions retain their disabled policy, and this repair does not change
Claude or Gemini execution. Inspection previously passed only the child's model to that validator,
so a valid inherited child could fail with `model_unavailable` when the parent
had a thinking level. Validation now resolves the child's original command and
passes its retained thinking selection. It never borrows a later queued command's
settings. Account, native session-tree, workspace, command-attempt, generation and
control fences remain in place; this does not expand model-selection authority.

The regressions reproduce the failure through CodexConversation, including the
actual owned Local Mac admission validator, and verify a child executor callback
while the parent stays running. A queued command with another thinking selection
cannot replace the child's original setting. Missing original commands and
rejected selections keep inspection unavailable before subscription or execution.
The phone inspection now respects safe areas, groups empty/error content with a
compact disabled composer and keeps retry failures visible within the modal.
Stage and correlation diagnostics remain available through Technical details.
All verification is offline; no provider turn or deployment is implied.

Implementation draft, 5 November 2026, based on Mitzo main
`79c334fa1e640372c1f5c54cf60b24bee50a1970`. Native Mac Codex sessions now opt in
to upstream multi-agent execution and expose nested child activity and controls.
OpenShell and adviser sessions retain their existing disabled policy. This is
source implementation evidence, not acceptance, deployment or live model qualification.

## Product scope

Retain the compact historical subagent rows and keep a floating agent control
above the composer, so earlier children remain reachable without scrolling.
Both entry points share one dialog and draft owner. Opening a child shows its
streamed output and tool activity, with **Message** and **Stop** targeting that
child's thread. The mobile view uses the shared SnapSheet for dragging between
half height, full screen and hidden; labelled buttons provide equivalent actions.
Main-composer messages retain the existing Symposium responder behavior.

A native child belongs to its spawning agent. Spawning does not add a Symposium
participant or include the child's private transcript in shared discussion. Results
return through the spawning agent. Preserve the approved chat, mobile composer,
context wheel and Resources surfaces; no new global agent-management screen is
required. The initial implementation does not add another scheduler or change
Symposium membership.

## First slice: reproducible protocol inventory

Run the probe with the explicitly selected executable and a new report path:

```sh
node scripts/qualify-codex-subagents.mjs /absolute/path/to/codex /tmp/subagent-contract.json
```

The probe compares `--version` with `runtime-codex-version` before generating
schemas. It invokes only version reporting and
`app-server generate-json-schema --experimental`, using empty temporary HOME and
CODEX_HOME directories and a minimal environment. It starts no provider thread,
submits no model turn, hashes the executable and generated inputs, and refuses
to overwrite earlier reports. It neither starts Mitzo nor changes its policy.

The retained [0.160.0 report](../../implementation-evidence/codex-upstream-subagent-contract-0.160.0.json)
was generated from the official upstream macOS ARM64 release on 4 November 2026.
Its executable SHA256 matches the existing
[Mac permission-kernel evidence](../../implementation-evidence/codex-native-macos-permission-kernel-0.160.0.json).
This identifies the tested bytes; it does not prove which binary a running chat
has selected. No credentials or production configuration were used.

The pinned protocol already exposes:

- Separate thread, parent-thread, session-tree and fork identities.
- Collaboration calls identifying sender and receivers, task input and known states.
- Thread read/resume, idle-turn start, active-turn steering with required
  `expectedTurnId`, and exact thread/turn interrupt.
- Dynamic host-tool calls carrying thread, turn and call identity.

The report checks method and field availability, including required control and
tool identity fields. It is not a complete type compatibility check. Its
`executionQualified` value is always false: schema generation cannot verify child
subscriptions, tool inheritance, authority, cancellation or recovery. A different
version is rejected before generation. The earlier 0.162.1 exploration is not
needed to establish these fields in 0.160.0, and this slice upgrades no runtime.

Sources: [upstream release](https://github.com/openai/codex/releases/tag/rust-v0.160.0),
[generated thread type](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts),
and [generated item type](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
These are protocol observations as of the verification date, not evidence of
deployed feature behavior.

## Runtime and delivery

### Observable inspection failures (7 November 2026)

The owning transport now records an observed child's identity and emits its
transcript activity marker before inspecting, subscribing to or hydrating the
child. Observation alone grants no native metadata, transcript, host-tool or
control authority. Native parentage/session/workspace/provider/model checks and
the original command-attempt/generation fences still precede executable admission.

Inspection failures retain the row, safe stage and correlation reference, with
controls disabled and execution status left uncertain. Diagnostics use the existing
structured logger; native error payloads and private reasoning are excluded. Later
native events cannot repeatedly retry a failed admission. An explicit **Retry
inspection** request rechecks the original operator and owner at every native
read/subscription boundary; it reloads activity without starting or steering a
model turn. Parent command-attempt and generation restrictions are retained before
the first native read, even while child admission remains unverified. A recreated
owner can also revalidate the saved observation. Verified
public output survives later failures. Saved activity receipts suppress repeat
transcript anchors on owner recreation, including new children under the same
retained command, and repair explicitly unanchored new
observations; legacy records without such receipts are not blindly replayed.
Emission and receipt persistence are not an atomic cross-store transaction.
Event-projection and diagnostic-retention failures use the same reporting boundary
and preserve the primary failure reference.

This corrects the silent-error mechanism identified in the
[6 November incident handoff](../diagnostics/native-subagent-visibility-handoff-2026-11-06.md).
The historical failing RPC remains unknown: its cause was discarded, and no
retained diagnostic establishes which step failed. Offline owner, conversation,
authenticated-feed/real-renderer and negative-permission regressions verify the
new failure delivery. They do not establish a live upstream reproduction. The new
offline browser fixture covers phone/desktop failure states alongside the original
protected design fixture; local browser execution is blocked by the Seatbelt guard,
so hosted CI supplies rendered screenshots and combined-source validation. Phone
and desktop failure/recovery screenshots were inspected in both themes; the PR
records their source revision and each candidate's validation.
No live model, production or staging runtime was invoked.

### Executable child admission

`CodexSubagents` admits children only after reading native parentage, session,
workspace, provider and model metadata through the original app-server owner.
Early child events are buffered during admission. Child turns have independent
state and cannot complete the parent's command queue. Retained identities and
bounded public output live in the existing private conversation database, scoped
to the account/profile binding. Private reasoning is excluded. Child token usage
is shown as observed counters; it is not added to the parent's billing total.

Dynamic host tools reuse the original executor and current policy checks, with
durable call identities preventing duplicate effects. Native command and file
approvals identify the child and retain the existing approval path. Conversation
checkout preparation and publication remain parent actions. Restored snapshots
cannot authorize tools until the live child turn has been observed again.

Message steers an active child using its exact turn identity, or starts a new turn
for an idle child. Stop interrupts only the selected child and waits for the
terminal event. Parent Stop interrupts its admitted descendants too. Controls use
stable request IDs; uncertain delivery is checked with the same identity rather
than resent as a new action. Lost transport, account or policy authority disables
controls and leaves saved output inspectable.

Authenticated snapshot, event-stream and control routes enforce the conversation's
original operator boundary. Streaming sends bounded per-child snapshots and closes
slow or revoked connections. The frontend shares one stream per conversation.

## Approved interface and validation

The original approval and 13 November explicit layout direction are retained in the
[design ledger](../design/approved/ledger.json), with the verbatim final mock.
The implementation retains the row beneath the spawning agent's activity and
adds persistent session access with a shared snap sheet for output, activity,
Message and Stop. Parent
composer and per-child drafts survive inspection and sibling navigation. The
existing toolbar, Terminal, context wheel and Resources remain in their owners.

Focused store, owner, policy, route, stream and UI tests cover identity rejection,
effect deduplication, stale authority, recovery and targeted controls. The existing
conversation suite passed 452 tests locally after correcting test setup and a
runtime-policy argument regression. The latest combined source and phone/desktop
browser fixture are delegated to CI at the user's direction; the local browser
invocation was interrupted and produced no completed result. See
[validation evidence](../design/approved/codex-subagents/VALIDATION.md).

No live model turn, restart, production configuration change or deployment was
performed. Actual upstream child tool inheritance, reconnect and approval behavior
still need live qualification on the selected supported Luna model and account
before claiming operational acceptance. Source review, merge and production
activation retain their separate gates.
