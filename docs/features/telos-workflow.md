# Telos work planning

Reach for Telos when the ask needs multiple independently deliverable slices or
handoffs between sessions. First propose the outcome, direct child slices and
session ownership. Several steps in a single implementation are not several slices.
Simple one-session work stays in chat unless the user requests Telos or an existing
item already governs it.

The workflow available in agent instructions is:

```text
Multi-slice ask
  -> propose Telos
  -> approved outcome + orchestrator chat
  -> direct child slices + one working session each
  -> execute the selected slice
  -> verify evidence and update progress
```

The outcome's orchestrator uses the existing lead role. Its direct children are
delivery slices; the `milestones` field in outcome proposals names those slices.
Do not add an intermediate catch-all milestone with another slice tree underneath.
Use reviewed Telos role setup and the assigned lead's `TelosStartSlice` to prepare
or recover a selected worker. Item creation and originating-chat provenance do not
establish a working session. A plain `StartSession` proposal also does not assign
a Telos role. Report missing setup honestly; chat readiness does not mean execution.

## Parallel-feature example

> Two features are being worked on in parallel; set up a merge-queue orchestrator
> session between the feature owners.

Propose a coordination outcome with its own orchestrator chat, using the existing
coordinator/lead setup and feature-owner chats. Each feature keeps its slice sessions.
Implementation, tests, review and PR preparation remain parallel; actual merges are
coordinated sequentially under the existing CI/review and merge-authorization gates.
This adds no scheduler, global pause or implicit merge/deployment permission.

## Delivery and boundaries

One shared source, `server/telos-workflow-instructions.ts`, supplies the workflow
to backlog-capable Codex chats, Telos role chats and the ordinary artifact guidance.
Tool descriptions repeat the relevant proposal/creation/setup step. Existing reviewed
role-context bytes, canonical schemas, allocators, permissions and receipts remain
unchanged. This is agent guidance, not another persisted workflow engine or automatic
migration of existing trees. Existing history is preserved when repairing legacy work.

Direction: Dimitri's 7 November 2026 clarification in the originating conversation.
Source changes, CI acceptance and delivery to running agents are separate evidence.
