# Native Codex subagents

Status verified 4 November 2026 against Mitzo main
`d6d53c50ec4d0c422e57e5c8bc244fc42ceba9cf`: implementation started with an
offline protocol probe. Native subagents remain disabled. This document records
the bounded delivery scope and current evidence; it does not claim acceptance,
deployment, live child execution or a completed UI.

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

## Remaining implementation

1. Test-first child admission and event routing: prove native parentage under
   the current account/transport owner; keep child turns separate from the
   parent's queue and completion. Subscribe to child output and restore the same
   identities after reconnect. Existing `CodexConversation` and
   `CodexSessionEvents` currently filter notifications to the parent thread.
2. Test-first child tools and controls: verify actual dynamic-tool inheritance,
   route approvals with visible child attribution, fence active steering to its
   exact turn and start an ordinary new turn for idle messaging. Record uncertain
   sends without replay. Target Stop to one child and verify parent-stop behavior
   across descendants. Preserve account/workspace/permission ceilings and existing
   recovery ownership; relaxing the parent-thread identity check alone is unsafe.
3. Test-first nested transcript UI using existing protocol/rendering components:
   compact row, public output/tool activity, explicit recipient, Message and Stop.
   Apply the UI design contract and approved-design ledger, including phone
   validation and preserved context controls.
4. Verify usage accounting and end-to-end recovery, then advertise support and
   enable only the qualified route. Keep unqualified routes unavailable. Any live
   model test needs the separately authorized target and exact supported Luna
   model/account; source review, merge and production deployment retain their
   own gates.

The current runtime policy sets `agents.enabled` and `features.multi_agent` false;
`stopTask` remains unavailable for Codex. The app-server client now allows
`turn/steer` for existing ordinary-chat steering, but it does not by itself admit
or authorize child threads. The next PR should implement the first routing slice,
using this probe as its protocol baseline, rather than adding another UX mock.
