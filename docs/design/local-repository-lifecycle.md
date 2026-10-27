# Local repository workflow and workspace lifecycle

Status: implementation authorized by the user, 2026-10-26. Reviewed against main
`022c71e12e080fb3dad5137f8ad447b55c25e350`. This document does not authorize
cleanup of existing host workspaces. Production activation remains a separate
user action.

## Outcome

An ordinary Local Mac conversation finds an existing repository, creates one
isolated task checkout from freshly resolved default-branch content unless the
user selects another base, and continues working in the same conversation.
Follow-ups, phone detachment, restart and retry preserve the task, its edits and
message order. Finished and abandoned allocations have a safe, bounded lifecycle.

Vertex is a comparison implementation, not the design authority. Native API,
native subscription and Vertex should share repository and lifecycle semantics;
their execution permissions and provider protocols remain separate adapters.

## Evidence and gaps

- Native discovery currently supplies only the current workspace as its search
  root and orientation hint (`codex-chat-session.ts`). Explicit source paths can
  work while discovery by name fails to find the same repository.
- Native `PrepareLocalRepository` accepts only a path. Its source/allocation
  records pin source HEAD. `selectExistingLocalRepository` also defaults omitted
  start points to HEAD. The configured worktree path instead fetches a default
  branch. These are different product contracts.
- In the first reported incident, preparation succeeded but a user message
  arrived during preparation. Adoption guards reject queued old-workspace
  commands. The conversation remained on its old workspace and entered recovery.
  An existing boundary test explicitly expects that refusal.
- In the second incident, no explicit follow-up was queued at adoption. The new
  workspace became active, the same native thread ran an automatic continuation,
  modified a frontend file and passed 38 focused tests. The transport subsequently
  closed during an active turn; the command is interrupted and recovery is set.
  The later user message has no retained server acceptance receipt. Cold ownership
  validation rejects both recovery state and an interrupted prepared primary
  (`ordinary-local-codex-owned-runtime.ts`, `assertColdEvidence`). Existing adopted
  cold-resume tests cover queued or completed primaries, not this interrupted
  state. This is a verified recovery contract hole. The precise cause of transport
  closure and whether the later send reached admission remain unproven.
- Current cleanup defaults to report-only, scans one legacy directory, exempts
  native repository task names, and omits newer task locations. Qualified native
  preparations cannot use generic discard/release paths.
- Existing destructive cleanup has separate hazards: dirty entries can fall
  through when no inbox is configured; removal falls back to recursive deletion;
  delayed rescue races reattachment; rescue commits, pushes and creates PRs.
- A clean Git status does not establish that unpublished commits or ignored
  artifacts are expendable. In-memory session membership does not establish
  durable ownership or lack of resume references.

The canonical source inspection failure from the earlier incident has not been
explained. Do not invent a metadata-size or permissions diagnosis. Capture bounded
stage/reason diagnostics and reproduce with representative synthetic repositories.

## Decisions

### 1. Resolve repository identity and base separately

Discovery uses configured repository locations and bounded, authorized search
roots. Current cwd is a hint. Release directories are not preferred development
sources merely because the canonical checkout has an old or different HEAD.
Explicit paths remain supported; genuinely ambiguous names require selection.
Configuration supplies hints, not additional filesystem authority.

Represent base intent explicitly:

```ts
type RepositoryBaseIntent = { kind: 'default' } | { kind: 'ref'; ref: string };

interface ResolvedRepositoryBase {
  repositoryId: string;
  oid: string;
  branch?: string;
  origin: 'remote' | 'local';
}
```

For a new task, default means the verified remote default branch, freshly fetched
and pinned to an OID. Mitzo uses main. Explicit branches, tags, OIDs and HEAD are
overrides; local unpublished commits remain selectable. Remote failure must not
silently select stale main or HEAD. A repository without a remote needs explicit
local-base semantics. Resume reuses its existing task without fetching into,
resetting or rebasing its branch.

Extract shared selection policy, not ambient Git execution. Arbitrary discovered
repositories must not execute configured remote helpers, includes, hooks, filters,
credential commands or URL rewrites. Acquisition uses a validated endpoint and
an existing authorized account/network mechanism with isolated Git configuration.
The approved plan binds the exact source, base and destination before effects.

### 2. One task workspace owner

Extend existing repository workspace/custody records; do not create another
workspace registry or scheduler. Stable task identity, repository identity and
generation identify an allocation. Tool-call IDs identify authorization/results,
not a new task. Repeated or concurrent preparation observes or joins the same
operation. An explicit new task/checkout creates a new generation.

Separate finding a source, resolving a base, and ensuring the task allocation.
These are meaningful seams for provider adapters and offline testing. Avoid
generic workflow frameworks or interfaces with only one incidental use.

Use independent task-owned Git stores as the proposed default for new allocations,
reusing qualified materialization rather than introducing a shared bare store.
These provide the isolated task checkout users need without writable Git
administration shared across tasks. Existing linked worktrees remain valid and
retain their recorded owners; do not convert or recreate active tasks.
Shared writable Git administration can cross task/account boundaries and makes
pruning affect other tasks. An immutable cache or scoped Git broker is conditional
on proving those boundaries and measuring material storage benefit. Do not add
alternates, object hardlinks or shared writable administration as a fallback.
Migration to independent stores needs explicit disk-admission tests; cleanup and
reuse must bound duplication before broad rollout.

Ordinary scratch is not inherently an MGMT clone. Allocate a repository directly
when selected at admission; otherwise keep the lightweight scratch workspace
until repository intent exists. Release superseded scratch through the same owner.

### 3. Adopt the workspace independently of automatic continuation

Today adoption installs a synthetic command as a new primary owner. Replace that
coupling with a durable workspace revision and transition on the existing owner.
Keep completed-source/result proof, physical identity and current authorization.

1. Reserve the exact transition and close the command-claim gate before awaiting.
2. Accept explicit messages durably while execution waits. Preserve IDs, FIFO,
   attachments, settings and historical admission evidence.
3. Prove no command is running and all pending commands are held by this
   transition. A nonempty queue alone is not an error.
4. Transfer custody once; reconcile session metadata, native cwd and live policy
   to that exact transition before reopening claims.
5. Re-admit pending commands through the existing coordinator with current
   authorization and the new workspace revision. Append execution evidence;
   never rewrite original admission records or silently reuse old authority.
6. Explicit queued instructions take precedence over automatic task continuation.
   Deliver transition context and retained task intent alongside the next explicit
   instruction. Only continue automatically if no explicit instruction is waiting.

Keep original task lineage: a retry such as "Let's try again" is not the task
brief. Structured cancellation stops dispatch; newer textual steering reaches the
agent before automatic continuation. Account/runtime identity cannot change
silently; model and reasoning selections remain command-specific.

Across restart, reconcile the existing transition. Before transfer, renew current
authorization; after transfer, finish projections without replaying transfer or
allocation. Uncertain provider dispatch requires evidence reconciliation rather
than blindly retrying external effects. Cold resume of an adopted workspace must
work even when its automatic continuation was interrupted.

Workspace ownership verification must not depend on that primary command being
queued or completed. A recovery-specific operation verifies retained adopted
custody and current authorization, reconciles interrupted provider state, then
admits an explicit new message. Preserve completed tool effects and interrupted
command evidence. Do not simply remove the recovery/status guards or replay the
automatic continuation. Record the origin of native closure and exit/disposal
reason where available; viewer reconnect is not proof of native recovery.

### 4. Retirement is an owned operation

Use one lifecycle planner over authoritative records and bounded physical Git
inventory. Classify active, resumable, unused, failed, uncertain, externally owned,
archivable and removable allocations, with reasons and byte/count estimates.
Directory names, age and Git status provide evidence; none grants deletion rights.

- Resume/reattach reuses a workspace. Browser detach and turn completion do not
  release task ownership.
- Explicit task archive/discard and expired unused preparations initiate retirement
  under a configured policy. Retention and capacity limits are visible and enforced
  at allocation admission. Pressure does not justify deleting unknown work.
- Prove exact path, root and Git administration identity, current ownership,
  absence of active/queued work, and disposition of resume/history references.
  Recheck under the same exclusive owner immediately before mutation.
- Preserve unique commits, tracked edits, untracked and meaningful ignored files.
  Unknown files stay protected; only explicitly classified rebuildable caches may
  be discarded. Any local archive must be verified and restore-tested before the
  live checkout is removed. Keep private data private; GC never publishes it.
- Retain operation/custody/diagnostic records after physical retirement. A crash
  during archival or deletion leaves a recoverable operation, not guessed success.
- Failed normal Git removal stays failed. Remove recursive-force fallback and
  unrelated global pruning. Automatic commit/push/PR rescue is not cleanup.

Existing accumulated worktrees require a read-only reconciliation inventory first.
Known owned allocations may be enrolled with proven identity; external, production,
release, historical staging and uncertain allocations remain outside disposal.
This plan does not authorize mass deletion or enabling the old execute policy.

## Delivery sequence

Each slice starts with failing behavioral tests and lands tests plus implementation
together. Keep one integrated design and a bounded sequence of reviewable PRs.

1. **Incident fixtures and diagnostics.** Reproduce actual native discovery wiring,
   feature-HEAD/default-main mismatch, queued follow-ups, and interrupted adoption
   continuation/cold resume. Record stage/reason/operation IDs without secrets.
   Add regression tests for destructive cleanup hazards before changing eligibility.
2. **Shared source/base policy and idempotent preparation.** Implement explicit
   base intent, safe fresh acquisition and task-scoped allocation identity. Wire
   native API/subscription and Vertex adapters to the same semantics.
3. **Conversation transition and recovery.** Separate adoption from auto-command
   ownership, hold/re-admit FIFO messages, retain original intent, reconcile every
   cross-store crash point, and prove next-message sending after cold resume.
4. **Inventory and owner-controlled retirement.** Cover all owned layouts and
   partial preparations. Add verified archival/restoration, leases and capacity
   policy. Retire unsafe legacy removal/rescue callers only after replacement.
5. **Consolidation and migration.** Remove proven uncalled preparation chains,
   duplicate base and cleanup policy, recursive primary delegation, stale comments
   and tests that assert superseded user behavior. Preserve historical readers and
   security boundaries. Validate existing claimed chats without reallocating them.

Storage consolidation, if justified by qualification, belongs in slice 4/5 with a
migration and rollback strategy. Do not maintain three permanent allocation paths.

## Acceptance gates

| Scenario                                                  | Required result                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Name lookup from unrelated cwd                            | Canonical configured repo found; ambiguity and denials remain explicit    |
| Dirty feature checkout, remote main advanced              | New task uses fresh main; source/index/branch unchanged                   |
| Explicit ref or unpublished local commit                  | Exact requested base selected; no implicit remote override                |
| Hostile source config or unavailable remote               | No source-supplied code executes; no stale fallback                       |
| Repeated/concurrent Prepare and lost response             | One allocation and branch; recover same operation                         |
| Messages during every preparation/adoption await          | Durable input, FIFO once, correct workspace, no generic recovery pause    |
| Contradictory follow-up/cancel/settings change            | Steering wins; no premature automatic task execution                      |
| Restart around each durable effect                        | Reconcile existing identity; no duplicate allocation or provider dispatch |
| Successful adoption followed by transport closure         | Preserve edit/history; recover same task; next message accepted visibly   |
| Phone detach/reconnect and multiple selected chats        | Viewer changes do not revoke task ownership or cause replay loops         |
| Warm/cold resume on all local provider adapters           | Same workspace, task, edits and selected account                          |
| Cleanup inventory across legacy/custom/native layouts     | Exact owner and retention reason for every candidate                      |
| Clean unpublished commits or dirty/ignored/untracked data | Protected or verifiably archived and restorable                           |
| Reattach/path replacement/renewed lease during cleanup    | Disposal refused without affecting new owner                              |
| Interrupted archive/remove or Git failure                 | Idempotent recovery, visible cause, no force-delete fallback              |
| Repeated prepare/work/resume/archive cycles               | Bounded retained allocations under policy; evidence records preserved     |

Run focused offline suites with one worker and a 1 GiB Node heap. Use real
disposable Git repositories and provider fakes, including signed native adapter
journeys; pure mocked helpers alone are insufficient. Required full CI and review
run on the combined branch. Any real model test requires the exact supported Luna
model and charged account announced first. Staging remains stood down.

## Review ownership

The coordinating agent owns architecture and integration. GPT-6.1 Sol subagents
own repository/base preparation, transition/recovery, and lifecycle/retirement
work. Assign file boundaries before edits; shared stores and manifests have one
integration owner. Cross-review behavior and cleanup/security risks independently.
Centaur's exact-head approval and combined-result CI remain merge requirements.

Implementation is complete only when both reported journeys, cross-provider
contracts, recovery, and retirement pass together. Creating a checkout alone is
not the acceptance criterion.
