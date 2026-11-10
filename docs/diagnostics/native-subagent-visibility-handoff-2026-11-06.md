# New-session prompt: diagnose and fix invisible native subagents

## Copy this prompt into the new session

Fix native Codex subagent visibility in Mitzo. Read the current repository's
`AGENTS.md`, `CLAUDE.md`, frontend instructions and approved-design ledger before
editing. Use a fresh isolated task branch from current accepted main; preserve
other sessions and their work. Find the exact native failure in the incident
below, rather than assuming an unverified cause or stopping at a generic UI fix.

### Required behavior

- Always show subagent activity once the owning runtime has established that a
  child belongs to this conversation. Show starting, working, completed, failed,
  unavailable or uncertain state honestly. Inspection, subscription, history or
  reconnect failure must not make the child silently disappear. Retain enough
  evidence of an observed spawn/admission failure to explain it without granting
  unverified children transcript access, host tools or control authority.
- Preserve the approved collapsed child count/status row beneath the spawning
  agent's activity, child list and inspection dialog with task, output, Message
  and Stop. The header Agents dropdown is Symposium, not this feature. The dark
  “You” cards in the screenshot are reply references, not duplicate sends.
- Preserve phone/desktop layouts, parent and sibling drafts, focus, Terminal,
  context wheel and Resources. Do not invent a replacement design or weaken
  approved checks. Keep saved output inspectable when authority expires; controls
  must still require the original current authority.
- Apply the Boy Scout rule to related touched paths. No swallowed unexpected
  errors: retain sanitized stage-specific diagnostics, identifiers and cause
  correlation, and deliver an actionable visible failure state. Preserve primary
  errors across cleanup. Expected cancellation/absence needs explicit handling;
  avoid secrets, private reasoning, duplicate logs and unbounded retries.

### Incident and evidence (6 November 2026)

In conversation `a0133956-2b04-8626-8dd5-31267b2aff66`, the user explicitly asked a
subagent to create a test Markdown file at approximately 11:51 UTC. The child
`/root/create_test_md` returned successfully; `test.md` contains its heading and
creation-test sentence. The screenshot shows only the parent's starting and
completion messages, with no subagent activity row. The runtime's agent listing
independently reported the child completed.

The inspected release was `3326bac25bfd`, at
`/Users/dsaridak/tools/mitzo-releases/main-3326bac25bfd`. Both its source and compiled
server contain the feature. Its structured server log
`logs/server.2026-11-06.93846.log`, filtered to this conversation during
11:50–11:52 UTC, contained two completed text blocks and one result, with no
rendered tool-call events. This supports a missing backend UI marker, not a
proven frontend rendering failure. Logs may have rotated; check retention.

Trace these paths in current source:

1. `server/codex-subagents.ts`: child notification recognition and `admit()`.
   At the inspected revision, `onChild` runs only after `thread/read`, identity
   checks, `thread/resume`, history hydration and buffered-event application.
   The trailing `.catch(() => ...)` discards the reason and invalidates a live
   child. It produces no visible admission-failure state or diagnostic.
2. `server/codex-conversation.ts`: `getSubagents()` and its `onChild` callback,
   which emits the `Agent` tool block with `nativeSubagentCommandId`.
3. `server/codex-session-events.ts`, `server/query-loop.ts` and protocol/client
   projection: delivery and durable replay of that block.
4. `frontend/src/components/ToolPill.tsx`: mounts `NativeSubagents` only when
   that marker exists; `useNativeSubagents.ts` starts the child event feed.
5. `server/codex-subagent-routes.ts`: original-operator authorization, snapshots,
   SSE availability and targeted controls.

**Still unknown:** whether native child notifications were recognized and which
admission/subscription/history step failed. Do not describe the discarded error
path as proof that a particular RPC failed. No saved native error was recovered
in the prior investigation. Missing or null child model metadata was only a
hypothesis. A separate PATH Codex was 0.162.1; this does not establish the running
session's selected executable or a version mismatch. The release contract pins
0.160.0. Identify the actual selected artifact before compatibility claims.

### Investigation, implementation and validation

Recover the exact incident's failure through an authorized diagnostic surface
if retained evidence permits it. Respect denied provider/credential paths; do
not copy tokens or bypass application authentication. Otherwise add narrowly
scoped, sanitized stage diagnostics and reproduce through the owning native
adapter on a separately authorized target. State any remaining evidence limit.
Do not start another live model test silently. Existing repository rules require
a supported Luna model, the exact model/account stated beforehand, and separate
authorization of the live target. Production is not an automatic test fallback.

The approved UI reference is the `codex-subagents` ledger entry and
`docs/design/approved/codex-subagents/nested.html`. See
`docs/features/codex-subagents.md` and its validation record: the prior browser
tests injected snapshots and did not qualify live upstream child behavior.

Add focused regressions proving failure reaches diagnostics and the actual
adapter-to-transcript-to-UI path. Cover failed admission/inspection, subscription
and hydration, fast child completion, parent completion, reload/reconnect,
authority loss, retained output and unavailable controls. Preserve existing
negative permission, cancellation and delivery-identity tests. Use one local
worker and a 1 GiB Node heap; use hosted browser evidence when the native sandbox
preflight prevents local browser execution. Keep source fingerprints current.

The originating session also prepared explicit Boy Scout/error-reporting edits
in MGMT and Mitzo `AGENTS.md`. Locate their current accepted or draft state and
carry forward the authorized text without treating a local commit as published
guidance. Do not duplicate or overwrite another owner's branch.

Deliver the verified root cause and stage, the visibility/error-reporting fix,
focused tests and approved phone/desktop visual evidence. Prepare a reviewable
PR under current repository gates. This prompt authorizes investigation, fixes,
tests and PR preparation; it does not authorize merge or deployment.

## Provenance and limits

Recorded 6 November 2026 from Dimitri's explicit request in the originating
conversation and read-only inspection of the identified release, public session
messages, scoped server logs and child completion status. These observations
describe that incident and revision, not current production state. The precise
native failure remains unverified. Recheck when the runtime, event contract or
approved subagent design changes.
