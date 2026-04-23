# Session Isolation Counter Proposal

**Status:** Proposed
**Date:** 2026-04-22
**Author:** GPT-5.4 + Dimitri
**Counter to:** `docs/design/session-isolation-overhaul.md`

## Goal

Build a session system that can sustain 5+ parallel Mitzo sessions across 11 configured repos with:

- Zero session bleed
- Deterministic session ownership across phone, laptop, and browser tabs
- Real workspace isolation for both tracked files and runtime state
- Reliable resume after disconnect, iOS background, or server restart
- Predictable cleanup and recovery semantics
- Full observability of the session control plane and workspace lifecycle

This proposal assumes correctness, determinism, and debuggability matter more than startup time, disk usage, implementation effort, or operational cost.

## Thesis

The current overhaul proposal improves several real bugs, but it still optimizes around the existing shape of the system:

- session identity is still entangled with connection identity
- git worktrees remain the primary isolation primitive
- secondary repo provisioning becomes lazy and policy-driven
- reconnect is allowed to become a takeover path
- missing runtime state is patched with symlinks

That keeps a lot of hidden coupling in place.

My counter-proposal is to optimize for the simplest system to reason about, not the cheapest system to run:

1. Make session identity durable and independent from WebSocket connections.
2. Make connection attachment explicit instead of inferred from reconnect behavior.
3. Give every session a fully provisioned workspace bundle up front.
4. Stop relying on git worktree tricks for runtime availability.
5. Make resume depend on a durable session record plus a durable workspace manifest.

The core idea is:

> A Mitzo session should be a durable object with a stable ID, a stable workspace bundle, and explicit attachment semantics. Connections come and go. Workspaces do not.

## Why This Is A Counter Proposal

The existing design doc treats the main job as "fix the current worktree-based system so it behaves." This proposal treats the main job as "pick the most deterministic architecture for the goal, even if it is heavier."

That leads to two major changes:

1. **Do the deferred identity work now.**
   The current doc defers decoupling session identity from connection identity. I think that is foundational, not optional.

2. **Replace worktree-centric isolation with session sandboxes.**
   If cost and effort are not constraints, a fully provisioned per-session workspace is easier to reason about than a dynamic mesh of worktrees, lazy creation, redirects, and symlinked runtime state.

## Design Principles

### 1. Session identity is durable

A session is not a WebSocket, not a transport, and not a composite `connectionId:sessionId` key.

It is a durable record with:

- a stable `session_id`
- a durable `sdk_session_id` when the SDK assigns one
- a durable lifecycle state
- a durable workspace bundle manifest
- a current driver attachment, if any

### 2. Connections are ephemeral

Connections may disconnect, reconnect, or multiply. That should not rewrite ownership semantics by accident.

### 3. Ownership changes are explicit

Reconnect should reattach a connection that already owns the session. It should not silently steal the session from another active device. Takeover should be a deliberate state transition.

### 4. Provisioning should be deterministic

If the system knows a session may work across 11 repos, provision the full session workspace once and keep it stable for the life of the session. Do not hide repo creation behind a write denial path.

### 5. Runtime state must be isolated too

If `.venv` or `node_modules` are needed, each session gets its own copy or clone of them. Do not reintroduce shared mutable state through symlinks just to make executables visible.

### 6. Resume should be honest

If the session can be resumed, resume it against the real workspace. If it cannot, say so clearly and preserve the transcript. Never fake resume by pointing the SDK at a different CWD.

### 7. Observability should trace state transitions, not just request entry points

The important events are session attach, detach, takeover, provision, recovery, permission routing, cleanup, and query-loop transitions.

## Proposed System

## 1. Stable Session Control Plane

Introduce a durable `SessionRecord` that is the canonical session object.

Suggested fields:

- `session_id`
- `sdk_session_id`
- `state`
- `mode`
- `summary`
- `workspace_bundle_id`
- `driver_attachment_id`
- `current_snapshot`
- `tokens`
- `cost_usd`
- `created_at`
- `updated_at`

Session states should be explicit. A simple model is enough:

- `provisioning`
- `active`
- `detached`
- `recovering`
- `closing`
- `closed`
- `recovery_failed`

The in-memory registry becomes a cache of live session handles, not the source of truth.

### Why this matters

Today the system still uses composite client IDs and transport-driven ownership rules. That is why reconnect, detach, and send paths keep needing special-case logic. If `session_id` is the stable key, those branches get much simpler.

## 2. Explicit Attachment Model

Introduce a separate `AttachmentRecord` for each browser tab or device attachment.

Suggested fields:

- `attachment_id`
- `session_id`
- `connection_id`
- `role` (`driver` or `observer`)
- `client_instance_id`
- `last_seq`
- `attached_at`
- `detached_at`

Rules:

1. A session has at most one `driver` attachment.
2. A reconnect from the same logical client instance may reattach as driver.
3. A different client instance may attach as observer by default.
4. A takeover is an explicit transition:
   - old driver downgraded to observer or detached
   - pending permissions for the old driver cancelled
   - new driver assigned
   - user-visible event emitted

### Consequence

`handleReconnect()` becomes passive. It restores the same attachment. It does not decide ownership policy for a different device.

That is a much safer model than "latest connection always wins," especially on mobile where reconnects are automatic and frequent.

## 3. Session Workspace Bundles, Not Git Worktrees

Every session gets a **workspace bundle** at creation time containing all configured repos.

Suggested layout:

```text
<state-root>/sessions/<session-id>/
  manifest.json
  repos/
    primary/
    repo-a/
    repo-b/
    ...
```

Each repo entry is a **standalone sandbox repo**, not a git worktree. The safest implementation is:

1. create a clean standalone local clone from the source repo
2. create or checkout branch `session/<session-id>`
3. copy or clone allowed runtime directories into that repo
4. record the resulting paths in the workspace manifest

On macOS, runtime directories can use APFS copy-on-write cloning for speed and space efficiency. On other systems, a real copy is acceptable because cost is not a constraint.

### Why not git worktrees?

Because the current problem set is not only about branch isolation. It is about the total session environment:

- tracked files
- ignored runtime directories
- repo-local executables
- predictable paths
- durable recovery
- no collisions

Standalone sandboxes give cleaner guarantees:

- no shared git index
- no shared working tree metadata
- no worktree path collisions
- no need for lazy secondary creation
- no need for symlinked `.venv` or `node_modules`

### Runtime policy

Runtime directories should be **copied**, not symlinked.

Examples:

- `.venv`
- `node_modules`
- `.tox`
- `.bundle`
- `vendor`

This is intentionally expensive. The benefit is that agents can mutate their environment without affecting other sessions.

### Source of truth

The bundle manifest should store, per repo:

- source repo path
- sandbox path
- branch
- runtime overlays copied
- creation time
- last validation time

## 4. Eager Provisioning Of All Configured Repos

Provision all configured repos at session start.

Do not make secondary repo creation lazy.

Do not trigger repo creation inside the worktree guard.

Do not depend on a deny-and-retry loop to materialize the session workspace.

### Why

Lazy provisioning is attractive when startup cost matters. In this proposal, startup cost does not matter. Determinism does.

Eager provisioning gives you:

- one stable path table for the whole session
- one stable system prompt for the whole session
- one stable set of env vars for the whole session
- no policy gap between "repo is configured" and "repo exists"
- no need to teach the guard to create infrastructure during tool evaluation

It also removes an entire class of bugs where the session's idea of its workspace changes halfway through a turn.

## 5. Guard Rails Become Simpler

With workspace bundles, mutating tool policy becomes much simpler:

- writes must target one of the sandbox repo roots
- shell commands must execute with `working_directory` inside a sandbox root
- absolute and relative paths are resolved against known sandbox roots

This is easier than trying to map "base repo path" to "worktree path that might not exist yet."

The system prompt can also be stricter:

- do your work inside the session bundle
- use the provided repo path table
- do not write to base repos

Read-only access to base repos can still be allowed if needed for reference, but it is no longer required for normal operation because every configured repo already exists in the bundle.

## 6. Resume And Recovery

Resume should be driven by the durable session record plus the workspace manifest.

Recovery flow:

1. Load `SessionRecord`
2. Load workspace manifest
3. Validate each sandbox path exists and is still a git repo
4. Validate the primary repo path still matches the session record
5. Rebuild the in-memory session handle
6. Reattach the correct driver attachment if the same client returns
7. Replay events and snapshot state from the event store

If validation fails:

- do **not** point the SDK at `BASE_REPO`
- do **not** pass `resume` with a fake CWD
- mark the session `recovery_failed`
- keep transcript and metadata intact
- surface a clear user-facing recovery message

If the workspace is missing but the system is allowed to rebuild it, it may rebuild the bundle from the manifest and then attempt resume. That rebuild must happen before calling the SDK.

## 7. Query Lifetime And Workspace Lifetime Are Separate

The query loop may end many times during the life of a session. The workspace bundle should not.

That means:

- no cleanup in the `startChat()` `finally` path
- no deleting secondary repos between turns
- detached sessions keep their workspace
- explicit close or GC owns cleanup

This is a major simplification compared to the current behavior where query-loop boundaries and workspace lifetime are still partially coupled.

## 8. Permission Routing

Permissions belong to the current driver attachment, not to whichever connection happens to be watching the session.

Rules:

1. Only the driver attachment receives live permission prompts.
2. On explicit takeover:
   - cancel outstanding permissions for the old driver
   - emit timeout/cancel events to that client
   - transfer future prompts to the new driver
3. Observers never become permission owners implicitly.

This avoids another hidden coupling in the current design, where watches, active session selection, and permission delivery still partially overlap.

## 9. Observability

Instrument the actual state transitions.

Recommended spans:

- `session.create`
- `session.attach`
- `session.detach`
- `session.takeover`
- `session.recover`
- `session.recover.validate`
- `workspace.bundle.create`
- `workspace.bundle.validate`
- `workspace.bundle.cleanup`
- `permission.request`
- `permission.cancel`
- `query.run`
- `query.resume`
- `query.finish`

Recommended log fields on every relevant event:

- `session_id`
- `sdk_session_id`
- `workspace_bundle_id`
- `attachment_id`
- `connection_id`
- `role`
- `repo_name`
- `sandbox_path`
- `state`

This makes Grafana and Jaeger useful for forensic debugging instead of just showing entry-point spans.

## 10. Cleanup And Retention

Cleanup should be state-driven.

Rules:

- `closed` sessions enter a retention window
- `detached` sessions do not lose their workspace until detach TTL expires
- dirty session bundles are never deleted silently
- dirty bundles are surfaced for rescue or explicit approval

Suggested separation:

- **detach TTL**: when to stop trying to preserve an idle live session
- **bundle retention TTL**: when to clean up a closed session's sandbox

Those are different concepts and should not share the same cleanup path.

## Pros

### 1. Stronger isolation

This model isolates:

- session identity
- transport ownership
- repo contents
- runtime state

That is much closer to the actual goal than branch-only isolation.

### 2. Simpler mental model

Each session has:

- one durable session record
- one durable workspace bundle
- one explicit driver
- zero or more observers

That is much easier to explain and debug than composite IDs plus watch sets plus lazy worktree creation plus runtime symlinks.

### 3. Executables work without cheating

You do not need to pretend isolation exists while all sessions share the same `.venv` or `node_modules`.

### 4. Resume is more honest and more reliable

Recovery either finds the real workspace bundle or it does not. There is no fake fallback CWD.

### 5. Guard logic is less heuristic

Because the full session workspace exists from the start, the guard no longer has to create infrastructure while deciding whether to allow a tool call.

### 6. Better observability

State transitions become first-class events instead of side effects buried in reconnect and send handlers.

## Cons

### 1. Much heavier provisioning

Creating full sandbox repos for all configured repos is far more expensive than worktrees.

### 2. Higher disk usage

If runtime directories are copied, the storage footprint can be substantial, especially with 11 repos and multiple concurrent sessions.

### 3. More up-front engineering

This is not a patch-on-top-of-current-state change. It is a control-plane redesign plus a workspace model change.

### 4. More lifecycle bookkeeping

Bundle manifests, attachment records, and explicit state transitions require new persistence and cleanup code.

### 5. Runtime overlay policy must be curated

If the system copies too much, it drags along junk. If it copies too little, tools still fail. The allowlist needs to be deliberate.

## Why I Prefer This System

Because it optimizes for the exact thing you said matters: accomplishing the goal, regardless of cost.

The current overhaul still carries too much of the old architecture forward:

- transport-shaped ownership
- worktree-centered isolation
- lazy materialization of secondary repos
- symlink-based runtime sharing
- reconnect as a policy decision point

Those choices are reasonable if the top priority is minimizing startup time, disk, and implementation delta.

They are not the choices I would make if the top priority is:

- zero bleed
- deterministic ownership
- honest resume
- clean debugging
- true isolation

This counter-proposal is heavier, but it is cleaner. It replaces multiple interacting heuristics with a more explicit model:

- stable session objects
- stable workspace bundles
- explicit attachments
- explicit takeovers
- explicit recovery states

That is why I would choose it.

## Direct Comparison With The Current Overhaul Proposal

### Current overhaul proposal

**Strengths**

- smaller delta from current code
- preserves git worktree UX
- cheaper startup and lower disk cost
- fixes several real bugs directly

**Weaknesses**

- still postpones the identity problem
- adds more behavior into the guard path
- reconnect policy remains overloaded
- runtime symlinks weaken isolation
- session workspace can still change shape mid-flight

### This counter-proposal

**Strengths**

- clearer control-plane model
- stronger workspace isolation
- no lazy repo materialization
- no worktree collisions
- better recovery semantics

**Weaknesses**

- much more expensive
- larger refactor
- requires new persistence structures

## Recommendation

If you want the most reliable architecture for the stated goal, I would do this instead of trying to perfect the current worktree-centered design.

If you want a lower-risk incremental path, then the best subset to steal from this proposal is:

1. decouple session identity from connection identity first
2. make reconnect passive
3. separate query lifetime from workspace lifetime
4. keep provisioning eager, not lazy
5. never share mutable runtime directories across sessions

But if the constraint is truly "whatever best accomplishes the goal is on the table," then my actual recommendation is:

**Build stable session records plus eager per-session sandbox bundles, and treat transport as an attachment layer on top.**
