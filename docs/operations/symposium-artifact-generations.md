# Artifact successor copy and generation ledger

The owned host composes `PhysicalArtifactSealer`, `PhysicalArtifactSuccessorCopier`
and `SymposiumArtifactGenerations` using its existing private custody database and
Podman command context. The explicit host methods export a successor bundle, copy
it to a fresh child and activate the independent generation pointer. They do not
admit a writer, change session artifact mapping, clear a seal fence, release parent
retention or dispatch a model.

`copySuccessorArtifact` and `activateSuccessorArtifact` require a trusted
`successorAuthority` supplied at host construction. No portable configuration or
request route supplies this object. It checks the existing review store's exact
owner/artifact/finding authorization and unsettled fix reservation, selected
implementer account/model/profile, plus a mandatory current authenticated grant,
membership and native enforcement check. Missing authority fails before physical
dispatch. The current application has no trusted native review host satisfying
this contract, so this capability remains unavailable there.

## Export and physical transition

The existing incremental publication bundle contract is unchanged. Successor
export is a separate mode of the same retained export job: a self-contained bundle
contains only the selected source and base refs, including their required history.
The selected base must be the origin default branch; unsupported dangling default
metadata and missing refs/prerequisite objects are rejected.
The completed receipt binds job and operation, exact parent seal and generation,
volume, selected refs/OIDs, bundle size/hash, pinned helper image/code, terminal
success and exact helper removal. The copier verifies this retained job, not a
caller hash or whichever export happened most recently.

The initial generation binds the actual retained Git initialization and helper
cleanup receipt. Routine preparation CAS revisions are excluded from this immutable
identity, so read/revalidation activity cannot invalidate it. A copy intent binds
parent seal/commit/tree/manifest, export,
explicit fix scope and the reviewed copier contract. The ledger generates fresh
child volume/generation/helper names. Parent rows and parent content never change.
The copier does not mount the parent and never copies `.git/config`, credentials,
hooks or checkout filters. A networkless pinned helper consumes at most 8 MiB of
stdin, verifies a self-contained bundle in the empty child, imports exactly the
selected refs, materializes regular committed blobs and compares the full Git
proof. It runs with a 45-second script alarm, 50-second container timeout,
60-second attached transport deadline, 256 MiB memory and 32-process limit.

A FULL-synchronous claim precedes dispatch. The same generation row appends volume
create intent/observation, helper create intent/immutable ID, terminal exit/proof
digest, exact removal and observed absence. Terminal observations are retained
before later custody or authority checks. Authority is checked again before each
new physical dispatch. Known helper inspection and evidence retention remain
possible after revocation. Unknown create/start/removal outcomes quarantine the
operation; there is no blind retry, name-based deletion, volume adoption or
quarantine promotion API. Failures retain exact names/IDs and any observed exit.

Semantic case creation reserves an exclusive private directory and an absent
`--cidfile` path before dispatch. The original create's trusted stdout CID must
match the native-created file before its inode, owner and content are captured,
permissions frozen to 0600, and the receipt durably recorded before start.
A file appearing after lost stdout grants no identity or cleanup authority.
Failed capture retains any trusted stdout CID and the original reservation in
quarantine; it does not start, adopt, drain, replace or automatically remove the
helper. Existing version 1 witnesses remain retained evidence, without automatic
migration or recovery of a missing CID. Unverifiable legacy owners stay alive
and retain their handles for explicit operator disposition. Read-only diagnostics
may describe this uncertainty but cannot promote it to successful evidence.

Successful copy reaches `verified` only after helper removal, child inspection,
no unaccounted child mount and fresh completed-parent validation. Activation
rechecks authority, retained lineage/copy evidence, physical absence and the parent,
then CAS-updates the ledger pointer. A losing child stays retained and inactive.

## Exact integration limit

**Activation is ledger-only.** `SymposiumSessionArtifacts.getReady`, owned-host
`artifactRequest` and ordinary seat admission still resolve the initial volume.
The session-wide seal fence remains closed, and the review workflow artifact is
not advanced. Generation-aware session mapping/admission, successor fence
capabilities, fresh per-generation sandboxes and historical cleanup remain future
work. Pointer movement must not be treated as writer ownership migration or a
complete accepted-fix lifecycle. This describes the original ledger-only slice;
current workflow prerequisites follow the
[integrated acceptance contract](../features/symposium-integrated-acceptance.md#application-policy-contract).
Persisted application limits remain required, while guaranteed native token/spend
caps and mandatory final usage totals are deferred.

Reopening in the same custody retains receipts and uncertainties. A new gateway
custody cannot adopt the old operation. Downgrading to code unaware of these new
receipt/observation fields is unsupported; no automatic rollback or resource
reconciliation is installed. Legacy initialization rows without exact helper
cleanup evidence cannot seed an initial generation.

## Verification

Deterministic tests cover real Git import/export, SQLite reopen/ordering, stale and
revoked authority, missing fix reservations, no redispatch after uncertain effects,
retained failed attach exits, exact cleanup and pointer activation. Tests make no
provider calls. The physical lane is opt-in and requires the reviewed image already
present in the chosen local Podman store:

```sh
MITZO_SUCCESSOR_PHYSICAL_CONTRACT=1 npx vitest run server/__tests__/symposium-successor-physical.contract.test.ts
```

`MITZO_CONTRACT_PODMAN` optionally selects the Podman executable; otherwise PATH is
used. The lane runs actual production export receipts, owned copy composition,
Git helper and SQLite transitions against uniquely named disposable parent/child
volumes. Prior seal/revocation and authenticated fix/native-budget authority are
explicit isolated fixtures; this is not full application/native-review evidence.
It checks exact parent content remains unchanged, independent child verification,
authority revocation before activation and exact cleanup. Evidence is written in
a portable temporary directory; failures retain exact task resources and the
ledger for inspection. No credentials, model calls or existing fixtures are used.
