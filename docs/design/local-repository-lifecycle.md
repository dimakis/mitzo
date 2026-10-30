# Local repository workflow and workspace lifecycle

Status: implementation authorized by the user, 2026-10-26. Reviewed against main
`022c71e12e080fb3dad5137f8ad447b55c25e350`. This document does not authorize
cleanup of existing host workspaces. Production activation remains a separate
user action.

## Outcome

An ordinary Local Mac conversation finds an existing repository, clones a selected
HTTPS/SSH remote, or initializes a new local repository, then creates one
isolated task checkout from freshly resolved default-branch content unless the
user selects another base, and continues working in the same conversation.
Follow-ups, phone detachment, restart and retry preserve the task, its edits and
message order. Finished and abandoned allocations have explicit preservation, retirement and
restoration operations. Existing accumulated workspaces remain protected pending
owner reconciliation.

Vertex is a comparison implementation, not the design authority. Native API,
native subscription and Vertex should share repository and lifecycle semantics;
their execution permissions and provider protocols remain separate adapters. This
change wires the generic source/base modes into native Local Mac preparation and
replaces unsafe cleanup shared with Vertex. Existing SDK/configured-source entry
points retain their current preparation adapters; this is not an all-provider
preparation rewrite.

## Incident evidence before this change

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
and pinned to an OID. Mitzo uses main. Explicit branches, OIDs and HEAD are
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

Use independent task-owned Git stores as the default for new native allocations,
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
together. Deliver one integrated draft PR, with local commits and batched CI.
The following are implementation slices, not separate PRs.

1. **Incident fixtures and diagnostics.** Reproduce actual native discovery wiring,
   feature-HEAD/default-main mismatch, queued follow-ups, and interrupted adoption
   continuation/cold resume. Record stage/reason/operation IDs without secrets.
   Add regression tests for destructive cleanup hazards before changing eligibility.
2. **Shared source/base policy and idempotent preparation.** Implement explicit
   base intent, safe fresh acquisition and task-scoped allocation identity. Wire
   native Local Mac adapters to the same semantics. Preserve existing provider
   adapters and explicit delegated base selections.
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

## Implemented contract and retained limits

- `PrepareLocalRepository` accepts the legacy `path` or `source` with kind
  `existing`, `clone`, or `new`. Existing and cloned repositories default to the
  freshly fetched remote default branch. Explicit local refs preserve unpublished
  commits. Lightweight local tags resolve; annotated local tags are currently
  unsupported and must be supplied as a commit OID. New repositories start from
  a deterministic empty commit; creating a
  hosted repository or publishing it is a separate user action.
- Name lookup checks the configured catalog and bounded configured host locations,
  under the original native filesystem read policy. No Mitzo/MGMT paths or names
  are embedded in selection policy.
- Remote reads use HTTPS/SSH through the authorized host adapter. Commands are
  restricted to the selected endpoint and acquisition directory. Source Git
  configuration is not executed. Fetches are shallow and limited to 128 MiB of
  acquisition Git data (128 MiB per canonical pack/index container; 16 MiB per
  tracked file or metadata leaf), 10,000 entries, a deadline, and
  available-disk admission.
  Cancellation joins the process group; uncertain shutdown preserves its records
  and scratch instead of deleting underneath a possible writer.
- Capacity bounds eight unfinished standalone preparations per account. A claimed,
  adopted task no longer consumes a preparation slot; claimed transitions without
  adoption still count. Existing tasks and their history remain intact. Slot
  reservation is atomic across workspace services, and local sources receive the
  same 2 GiB plus 256 MiB free-disk admission as remote acquisition. Capacity
  refusal is reported as `resource_exhausted` with a specific reason and no
  checkout effect, rather than an uncertain internal failure.
- Native allocations use independent Git administration, with no shared writable
  object store or alternates. The old linked-worktree reader remains for existing
  sessions. Retry identity is stable for a conversation/source/base; a deliberate
  `newCheckout` requests a new generation.
- Explicit messages retain their original receipts and FIFO ordering across
  workspace adoption. Execution admission is appended separately after current
  authorization. An interrupted automatic continuation does not make the workspace
  unresumable or replay completed external effects.
- Retirement/restoration routes require current account authorization and a
  stopped owner. Archives preserve Git history, edits, untracked and ignored files,
  and are verified before retiring an independent task checkout. The original
  inode tree is then renamed into the same-filesystem archive, preserving late
  external-editor writes instead of unlinking files. Restoration refuses a stale
  snapshot when that retained original has changed. Restoration keeps
  historical custody and appends a physical-identity revision.
- Legacy automatic rescue publication and force-removal fallbacks are removed.
  Startup performs bounded inventory, not age-based disposal. Legacy linked,
  unknown, external and uncertain workspaces remain protected. No existing host
  worktrees have been deleted by this task.
- Preservation limits are per operation (2 GiB/100,000 entries, 32 restoration
  revisions, and 100 retained copy attempts per retirement/restoration). Interrupted
  archive copies remain in receipt-bound private attempt directories. Restoration
  copies stay private until fully verified, then publish atomically without
  replacing an existing path; the publication inode is journalled before the move.
  Restart reconciliation requires that exact inode and archive contents. Unknown
  legacy partial live directories remain protected for explicit reconciliation.
  There is no aggregate archive garbage collector in this change;
  archives, retained original trees and diagnostic receipts are retained. This
  removes active workspace entries but does not claim disk reclamation. Cross-device
  retirement fails safely. Disk admission prevents treating
  storage pressure as permission to erase retained work.
- Validation uses offline Git repositories, fake provider transports, filesystem
  fault injection and durable ledger tests. No staging restart, production change,
  live credential probe or model-backed test is part of this work.

## Offline verification and review

Behavioral regressions were reproduced before their fixes. Focused verification
covers configured and uncatalogued discovery, remote command/account boundaries,
actual Git existing/clone/new materialization, local shallow history, native
command FIFO and cold recovery, preservation/restoration and startup inventory.
Public-entry tests verify actual next-turn dispatch on the retained native thread
for interrupted adoption, partial custody projection and an untransferred
reservation. Provider RPCs are fake; Git and durable ledgers are real fixtures.

Two fresh Sol 6.1 reviewers examined the full production change. Their findings
were addressed with regressions: an admission-tail deadlock, late external writes
being removed after archive proof, inventory executing Git clean filters, omitted
local shallow boundaries, and borrowed workspace references during retirement.
The final integration gate is CI; source review is not production activation.
