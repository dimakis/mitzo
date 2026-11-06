# Native Codex subagents

Implementation draft, 5 November 2026, based on Mitzo main
`79c334fa1e640372c1f5c54cf60b24bee50a1970`. Native Mac Codex sessions now opt in
to upstream multi-agent execution and expose nested child activity and controls.
OpenShell and adviser sessions retain their existing disabled policy. This is
source implementation evidence, not acceptance, deployment or live model qualification.

## Product scope

Show one compact subagent row beneath the spawning agent's activity. Expanding
it exposes each child's task and state. Opening a child shows its streamed output
and tool activity, with **Message** and **Stop** targeting that child's thread.
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

The original approval is retained in the
[design ledger](../design/approved/ledger.json), with the verbatim final mock.
The implementation uses a collapsed row beneath the spawning agent's activity,
then a shared dialog for child output, tool activity, Message and Stop. Parent
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
