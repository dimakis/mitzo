# Repository materialization and bounded publication review

A prepared source, a Ready sandbox and a model response prove different things.
Repository commands now require target materialization evidence; publication
retains one reviewed artifact through approval and records its phase independently
of mutation/recovery state. Existing workspace and capability owners remain the
only lifecycle authorities.

## Repository transfer

`RepositoryWorkspaces.startupMaterialization` requalifies its original source and
account before and after exporting committed objects. The temporary upload
contains only a self-contained Git bundle. It contains no working tree, source
configuration, hooks or ignored files, and resides outside a Git checkout so
OpenShell's Git-aware upload filtering cannot remove task metadata.

Cold creation and warm binding upload this same opaque input. If a retry reuses
a Ready allocation before native admission, the importer requests a missing
current envelope and the manager uploads it under the same physical fence. Before any native
provider startup, `OpenShellRuntimeManager.materializeRepository` qualifies the
physical sandbox, invokes the fixed importer and requalifies the same target.
The importer creates a fresh standalone Git store with isolated configuration,
verifies the bundle digest, refs, base commit and tree, and reconstructs only the
admitted task branch. It does not merge a task into the image's checkout.

Initial replacement requires an original admission without native thread or
command history. The initial image directory is preserved under an owner-bound
sibling rather than deleted. An interrupted rename or existing partial staging
directory stops automatic import; it does not allocate or overwrite a replacement.
Target receipt persistence precedes native startup and controller-source release.

The existing workspace row retains repository, branch, base, bundle and target
identities. These are verified facts, not permission grants. Resume verifies
receipts against the same physical sandbox and exact Git root, branch and base
ancestry without resetting edits or legitimate new commits. Git storage must
remain standalone and free of symlinks/external object alternates. Existing legacy
sessions without the new receipt retain their historical path; this change does
not infer a receipt, re-upload a seed or repair a mismatched legacy task.
A committed migration journal can connect an original receipt to its exact target.
The target must independently pass Git verification before the workspace receipt
is rebound. This reconciliation also repairs an interruption between migration
commit and receipt persistence; a merely restored or unrelated target is refused.

The importer leaves its envelope and preserved initial directory under the
sandbox's existing lifecycle owner. No new deletion policy or mass cleanup of
retained resources is introduced. Source, bundle and expanded-checkout limits
remain bounded; bundles do not preserve uncommitted work and are never used to
replace resumed task state.

## Feature inference

Native feature inference selects the internal `mitzo-feature-text` builtin,
without tools or a context recipe, rather than the interactive Mitzo profile.
The existing `AdviserTaskScope`, command receipts, native account harness and
fresh operator/credential checks remain mandatory. The internal profile is not
added to the interactive catalog.

`TextAdviser` acquires capacity from a shared feature owner. Duplicate feature
requests cannot acquire a second live slot, and aggregate work is bounded to two
requests per account and twenty per controller. Slots cover setup, inference
and native cleanup and are released on terminal failure or cancellation. Retained
workspace/history records do not occupy these slots.

Native invocations remain isolated per inference: mutable provider sessions or
workspace custody are not pooled across review rounds. This deliberately retains
some setup cost to preserve exact transcripts and independent pass ownership.
Sharing a workspace across native conversations would require a different custody
contract and is not smuggled into this repair. Shared route predicates are reused
by local/OpenShell admission, preparation receipts and session metadata; parsing
still supplies no authentication or execution authority.

## Artifact ownership and publication

The capability operation continues to own idempotency, forced semantic approval,
external dispatch and read-after-write verification. Its additional `phase` is an
observation: it cannot authorize work or change uncertain-write recovery state.
Preflight, each review pass, context acquisition, approval, push, PR mutation and
verification are distinguishable without retaining raw provider/Git errors.

The production GitHub publisher retains one private reconstruction through its
bounded review/approval lifetime. At execution it refreshes the upstream base in
that same artifact, re-inspects the live source, re-exports its committed evidence
and revalidates the exact semantic receipt before push. Changed upstream evidence
still requires fresh review. Older adapters without a refresh capability retain
the original reconstruction behavior rather than skipping that fence.

The review receipt is consumed synchronously before execution awaits. Approval
denial, cancellation and service completion release preparation through the same
executor owner; a fifteen-minute timer bounds abandoned live preparations. Cleanup
failure cannot convert a verified external write to an apparent failure and is
recorded in the existing audit log. Private artifact cleanup does not remove task
checkouts or recreate review authority after restart.

Two independent scopes, five rounds per scope, existing deadlines and all
publication/revocation checks remain. Context I/O receives the pass deadline.
Response parsing reports bounded fixed schema fields/codes instead of discarding
the cause or returning model text in diagnostics. A last-round context request
returns an explicit incomplete outcome; no extra inference or context read is
performed. Evidence guidance calls for concrete consumers and proportional test
coverage, without recursive dependency heuristics or automatic model fallback.

## Validation and activation

Extend the existing adviser, metadata, operation, review and workspace fixtures.
A small real-Git fixture additionally exercises the actual importer because an
upload-argv assertion cannot prove Git identity survived transport. It covers
exact refs, ignored-file exclusion, replay preservation and corrupt transfer.
No browser, complete-app or live-model journey is added for these variants.

Existing host/OpenShell consumer jobs and required CI/Centaur gates remain.
Offline adapters may replace final provider responses or external GitHub I/O;
they must not replace a boundary claimed by the test. Keep setup, execution and
CI queue measurements separate. Record model calls, workspace slots and repeated
reconstruction work; fewer allocations or whole-CI speedups are not claimed.

Production activation and live target qualification remain separate explicit
operations. Any model-backed test must select a supported Luna model and state
its exact charged account before dispatch. Canonical staging remains stood down.
Knowledge export-policy enrollment and the pending publisher rollout are separate
from this PR; current accepted-content freshness and privacy rules are preserved.
