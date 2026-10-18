# S5a/S5b foundation contracts — preparation v1

Parent `85e8444019a4ae4a`; S5a `9dab491c72f0494e` (CT01–CT06), then S5b
`df0d5bb2ec46416b` (CT07–CT09). Foundation owner: external Codex thread
`01a14bd3-0257-7ab2-a373-a8ecc89ff99a`. S7 owns the outcomes workspace; S9 owns
combined acceptance. This document is a proposed implementation contract for those
lanes to inspect, not an accepted wire schema or a claim of working capabilities.

## Accepted source and dependency gate

Inspected Mitzo main: `189289da78d971497deaa9cc4ca29365ba9c6e56`.
Inspected MGMT main: `b4ad94541af3ed19e1a2c6fd1049fd98418016d0` (priority PR348
accepted; Mitzo priority consumers still need their own accepted integration).
S5 `cf8dc85a4b6afaad` remains owned by “Build S5 Exact Slice Delegation”, thread
`01a14b59-5cb3-7672-a590-e83dcaeb8527`; draft PR1013 was open at
`305a265ce106a45acdd75c3f4a11ec2afa4d1493` when checked. Its allocation/dispatch
branch and files are untouched. Reconcile this proposal with accepted S5 before
changing those owners. S5b implementation also depends on accepted S5a.

No current allocator, dispatcher, runtime, store or UI consumer is changed by
this preparation. Published reproduction tests deliberately remain red. Do not
use this document to mark either slice accepted or infer a new scheduler.

## CT01–CT02: canonical item writes

MGMT `command_center/lib/todo/store.py`, `models.py` and `todo_api.py` own canonical
items, migrations and hydration. Generate synthetic fixtures by running accepted
`TodoStore` on both an empty database and a database initialized with the actual
pre-change schema, then run current migrations. Retain owner commit and file
hashes. Never copy user rows or resolve a default/canonical database in tests.

The accepted MGMT schema has required `first_seen`, `last_seen`, `created_at` and
`updated_at`, creation history, and priority 1–10 with default 5. It has **no
categories column**. Mitzo's advisor save currently assumes one; its tests add one
manually and omit the required observation timestamps. Historical review tests
are retained separately; adding categories there only isolates the second bug
and is not a migration or acceptance fixture.

Implementation must establish one canonical category representation with the
MGMT owner and tests. The proposed representation is a canonical JSON string-list
column `categories`, default `[]`, with migration and TodoItem/API hydration that
preserve unknown legacy fields. This requires a separate MGMT PR; until accepted,
consumers must not assume the column exists. Do not stash category in unrelated
keywords or overwrite context hints to bypass that requirement.

For new advisor children, write all four timestamps and exactly one
`history(old_status=NULL,new_status='active')` entry. Preserve the canonical
profile, explicit parent, context hints, sources and type; priority follows the
canonical default unless explicitly selected under its accepted API. Refinement
preserves creation/first-seen timestamps, history, priority, provenance, unrelated
hints and category entries beyond the edited first entry. Define last-seen update
semantics consistently with the canonical owner; do not invent an observation
date for a historical source. All original fields must hydrate through Python and
round-trip through the real Mitzo routes/client projection.

Item changes, classification, selected source/material capture and final receipt
share the existing `TelosWorkStore` transaction and borrowed artifact connection.
Inject failures after item mutation, retained source writes and receipt insertion
to prove rollback. Same actor/request/input replays original identities after
reopen; same request with changed input conflicts without mutation. No receipt
may describe rolled-back data; no orphan source/material may survive. These are
required tests, not proven by the preparation fixture.

## CT03–CT04: definite rejection and uncertain recovery

Current `TelosWorkApiError(status,code,message)` and HTTP `{code,error}` do not
prove allocation phase. A 409 alone, error-message matching, or an expired login
must **never** authorize clearing an existing submission.

Proposed role-setup error extension (names to reconcile with accepted S5):

```ts
type RoleSetupRecovery = {
  version: 1;
  requestId: string;
  outcome: 'rejected_before_allocation' | 'recover_original';
};
// HTTP failure: { code, error, recovery?: RoleSetupRecovery }
```

Only the ordinary setup/work owner may emit `rejected_before_allocation`, for the
same authorized request after checking durable intent/allocation state under its
transaction fence. The stale initial revision rejection before creating an intent
is the first supported case. Missing evidence, an existing allocation-capable
intent, crossed allocation boundary, late assignment conflict, response loss,
malformed response, cancellation or lost receipt all require `recover_original`.
The route/client must validate and carry this evidence; omission means uncertain.
Do not broaden the initial implementation to every error or every 409. Concurrent
duplicate setup must not allow a stale rejection to unlock a request another call
has already claimed. The exact admission fence must be verified after S5 lands.

The hook persists a terminal rejection state before releasing its old submission.
If that write fails, retain the locked request and report storage failure. On
explicit Retry/review after a definite rejection, refresh the same draft with
current item/assignment/context revisions and the user's retained settings, then
require confirmation with a new request UUID. Keep the rejected identity as
history. Never automatically allocate on refresh. Reload must preserve this safe
state. Current settings, composer text, material selections and history survive.

For uncertain outcomes, retain and replay exactly the original request UUID,
settings, context/source/material pins and assignment revision across remount,
restart and concurrent retry. Recover the original session/workspace/assignment;
never generate another request to escape a conflict. A receipt must prove the
requested role and exact conversation before navigation. A prepared chat means
ready for an explicit command, not that a command ran or work completed.

## CT05: readable linked context, owned by this lane

S5a owns `TelosLinkedContext`, `TelosRoleSetup` and `useTelosRoleSetup`; S7 consumes
them. Preserve the frozen mock and separately approved settings quick sheet.
Frozen mock `9d0559132154b92d0bbb427a982a0002@1`, SHA-256
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`
was verified against its retained bytes and local mirror.

Present the reviewed Overall goal, Parent outcome, This item, Done when and
readable source/material names and revision labels in the approved hierarchy.
Current context contains brief text, overall goal text, parent IDs/criteria and
immutable source/material pins, but lacks complete parent/material display names.
Resolve display metadata from authorized real projection owners, pinned to the
reviewed versions; never fetch current replacement content when opening the
disclosure or parse IDs into invented titles/dates/revision numbers. Unknown
labels remain truthful. S7 should not build a competing linked-context renderer.

Keep IDs and hashes in persisted DTO evidence, exact-revision navigation and
authorization. They are not the primary explanation. A new diagnostics panel is
not part of this proposal. Additive versioned presentation data must not silently
change strict immutable S4/S5 context fingerprints or historical receipt replay.
Finalize the DTO after reconciling accepted S5; required wire evolution tests
cover old retained context and new presentation metadata together.

## CT07–CT09: repository-free ordinary workspace contract

The current limitations are explicit: `CollaborationSettingsSchema` requires
`repositoryWorkspaceId`; `OrdinarySessionPreparationReceiptSchema` equates it to
`workspaceId`; `TelosRoleSetup` cannot review settings without one; ordinary silent
preparation and `RepositoryWorkspaces.prepareOrdinarySession` require a prepared
repository and account/runtime proof. `ordinary-session-runtime.ts` resolves
configuration compatibility only; it is not an allocator or readiness proof.

The new ordinary workspace selection is a discriminated capability of the same
ordinary runtime:

```ts
type OrdinaryWorkspaceSelection =
  | { kind: 'repository'; repositoryWorkspaceId: string }
  | { kind: 'ordinary'; preparationId: string };
```

An ordinary preparation ID identifies a real durable account/runtime-bound
preparation, not a fake repository or a public filesystem path. The existing
ordinary allocation operation reserves an independent stable workspace ID and
session ID, persisted with its fingerprint and preparation receipt. Two role
conversations never share a writable directory or workspace ID accidentally.
IDs are opaque and server owned. Local workspace storage is a private non-Git
directory created by the ordinary workspace owner. OpenShell uses an explicitly
supported target-owned workdir/namespace; unsupported isolation is rejected
before allocating. No `.git`, origin, branch, SHA or GitHub authorization is
invented for non-code work. Do not default to REPO_PATH or a production workdir.

Repository selections keep their existing canonical source/revision/base-branch
proof and independent checked-out worktree. Existing retained repository settings
and preparation receipts remain parseable and replayable. Prefer extracting a
shared ordinary workspace selection and adapting the existing preparation owner;
do not unconditionally widen every `CollaborationSettingsSchema` consumer.
Symposium and existing repository admission continue rejecting unsupported
variants until their actual owners have explicit integration tests. This avoids
silently changing unrelated collaboration reservation/fingerprint semantics.

Capabilities are server-derived from the selected preparation and exact runtime
binding, not caller-asserted booleans. The planned minimum is ordinary conversation,
isolated writable workspace, retained artifacts/resources and exact task dispatch
where the existing route supports it. Repository checkout/revision operations are
unsupported on `kind:'ordinary'`. If a requested agent/operation needs Git or an
unavailable target capability, return an actionable reason and no allocation
intent, session, task or model call. A compatible configuration is still subject
to current account/profile/model/target/permission admission and revalidation.
Initial supported harness/location tuples must follow accepted ordinary owners;
this proposal does not enable a route merely because a wire schema can express it.

Role setup keeps existing lead/advisor/worker/reviewer eligibility and current
assignment rules. Non-code roles select ordinary settings and review exact
context without selecting a repository. Readiness is separate from command
admission. First send uses the existing queue/dispatcher/provider route, with no
implicit turn during preparation.

Exact child delegation reuses accepted S5's work intent, allocation operation,
task mapping and dispatcher authority. One requested child gets one independent
ordinary workspace/chat/task; the lead stays in its own conversation. Siblings
are neither dispatched nor exposed as worker authority. Concurrent same-request
replay and restart retain the original workspace/session/task/settings/context;
an explicitly new attempt keeps predecessor and artifact provenance. No second
scheduler, polling dispatcher, or repository-shaped placeholder is introduced.

Drafts remain keyed by existing ordinary draft/chat identity; resources/history
and settings survive navigation and reattach. Workspace lifecycle, reservation,
release and artifact ownership stay with ordinary owners. A duplicate or stale
cleanup cannot delete a claimed workspace or another chat's resources.

## Evidence and consumption gates

CT01/02 use actual fresh/upgraded MGMT persistence plus real Mitzo work/source/
artifact owners, routes, client and Python hydration. CT03/04 cover actual typed
HTTP errors, hook persistence failure, stale-before-allocation, late conflict,
lost allocation/commit response and reopen/retry with zero duplicate allocations.
CT05 requires desktop/mobile light/dark, narrow width, readable labels and exact
links against the frozen mock; preserve settings/resources/navigation.

CT06 waits for accepted S5, then exercises origin/material → advisor save → lead
setup → exact child worker/task → output → pending_review → explicit verified
completion with synthetic persistence and fake provider side effects. CT07/08
cover non-code capabilities/admission and concurrent retry/restart; CT09 repeats
the complete non-code journey without hidden repository fixture data. S9 reruns
both against final combined accepted source and records UX01–UX24 evidence.

Run focused offline tests with one worker and 1 GiB Node heap. Broad checks/builds
belong in CI; offline Playwright runs outside Seatbelt. No model call, live target,
staging revival, production fallback or deployment is authorized. Draft PRs are
preparation only; merge needs separate authority, green exact-source CI and the
exact-head Centaur final LGTM/merge recommendation with zero blockers.

Track code merged, offline integrated, UX accepted and live runtime qualified as
four separate facts. Every CT row remains open until its actual evidence exists;
S9's live qualification remains a separately selected and authorized gate.
