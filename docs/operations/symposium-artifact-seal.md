# Pending artifact seal fence

The trusted-host internal `EventStore.beginSymposiumArtifactSeal` prerequisite records a
`pending_unsealed` intent in a FULL-synchronous SQLite IMMEDIATE transaction. It binds the
selected custody, artifact volume generation and lease identity to the exact active v2
configuration and current membership generations. An identical retry returns the original
intent; changed identity fails. No HTTP route or native review host installs this API.

The session fence denies configuration/primary transfer, new admission, membership
activation, sandbox reservation/create dispatch and recipient execution claims. Native
seat dispatch and runtime admission recheck it. New reader work is also denied until a
reviewed sealed-reader adapter exists. Existing work may still be running: this is a
request to begin draining, never evidence that writers stopped. A lifecycle operation
already holding its per-seat fence prevents intent creation. Cleanup can still take its
normal per-seat fence after the intent exists.

Restart retains the pending fence. There is no clear, complete, or automatic recovery
method. Empty inventories cannot authorize unfencing. This increment creates no immutable
Git snapshot, physical revocation receipt, WorkResult, ReviewReceipt, or publication
permission, and does not enable native review model calls.

Before any seal may become usable, a later reviewed host must drain existing attempts,
prove physical writer revocation under retained custody, reserve the artifact independently
of released writer leases, and inspect an immutable committed Git revision/tree. It must
bind that proof to this intent and membership/lease generations, handle restart uncertainty,
and provide a reviewed immutable reader lifecycle. The existing unfenced observation
scanner is insufficient. These physical and native hard-budget acceptance gaps remain open.

## Pending lease retention

`SqliteArtifactLeaseHost.beginPendingArtifactRetention` reads the already persisted session
intent before recording a pending retention reservation in the lease database. Its
FULL-synchronous IMMEDIATE transaction requires the exact still-bound writer lease,
including token hash, revision, workspace, volume generation and physical sandbox ID.
The stored intent also binds the original gateway custody digest and membership/configuration
snapshot. This is an identity binding; it does not perform a fresh gateway custody check.

The reservation blocks all new leases for that driver and volume name, including reader
leases, another session, or a changed volume generation. It survives normal writer lease
release and database reopen. An identical retry returns the pending record without
claiming renewed custody or revocation. Writer release winning before first reservation
fails closed; an old release receipt cannot substitute for the required live lease.

This internal API has no installed runtime caller. It cannot prevent out-of-band Podman
volume deletion, drain active processes, or create a sealed reader. There is no clear or
completion path. A crash between the session fence and retention leaves the session
pending; a crash after retention leaves both locks. Future physical orchestration must
use the retained gateway and Podman capabilities, refresh exact gateway/physical absence,
and bind immutable committed Git inspection before any successful seal can be claimed.

The owned host stores the lease ledger at `stateParent/artifact-leases.db`, outside
per-launch gateway directories, and opens it with private ownership and file checks.
Fresh gateway launches retain pending locks and uncertain leases. Before launch, any
legacy `gateway-*/artifact-leases.db` (including an orphan WAL/SHM) blocks startup for
explicit reconciliation, even when a stable ledger also exists. Prior per-launch fixtures
cannot be restarted by silently adopting or discarding their state; this increment does
not migrate or delete those ledgers. A new gateway cannot inherit old physical custody
merely because a database row survived.

## Host-only physical composition

The owned host exposes internal `sealSessionArtifacts` and `requireCompletedArtifactSeal`
methods. No HTTP route, review model dispatch, or publication permission is installed.
The caller supplies a session revision and repository-relative path; custody, volume and
writer lease selection come from the retained host. Only a privately registered runtime
from the actual runtime factory may perform the drain.

The operation establishes both pending fences, journals every retained physical generation,
and drains the runtime including the anchor and sandbox rows outside current membership
history. An orphan lease, no-ID uncertain create, unconfirmed attempt, or incomplete
physical cleanup prevents completion. It refreshes exact gateway absence and performs a
bounded full Podman mount census; unexpected mounts are denied, never deleted.

A separate pinned-image verifier runs as `sandbox`, without credentials or network, with a
read-only root and artifact mount. Its create intent and exact physical ID are journaled
before execution. It accepts a regular Git repository, rejects symlinks/submodules/alternates
and untracked files, and compares committed blobs against both the index and working tree.
It uses fixed read-only Git commands; hooks, filters and fsmonitor are not executed.

Only terminal verifier success, exact verifier deletion, renewed volume/gateway/custody
checks and drained-attempt checks permit the immutable receipt CAS. The EventStore keeps
an IMMEDIATE lock over the final configuration/membership snapshot validation and receipt
write. The receipt binds commit, tree, manifest digest, pending intent/retention identities,
revocation records, verifier image/code and gateway lifetime. Lookup requires fresh scope,
retention, absence and custody checks. A new gateway lifetime cannot adopt the receipt.

Failure or cancellation preserves the pending journal and fences. There is no automatic
unfence, uncertain-create cleanup, or cross-custody recovery. Successful sealing also keeps
the session drained: accepted fixes will require a separately reviewed new-writer authority
and reseal lifecycle. Native hard budgets, trusted review receipts, and full application
live acceptance remain separate requirements. The earlier unfenced observation receipt
is never promoted into this completed-seal type.

## Remaining workflow joins

`git.commit` supplies the candidate artifact revision, and `git.committedTreeDigest` uses
the existing publication contract's versioned regular-file tree digest. The separate
`manifestDigest` includes verified working-file bytes and must not be substituted for the
review artifact hash.

The existing publication binding still requires a live admitted builder attachment,
writer lease and sandbox bundle export. A completed physical seal has deleted those
sandboxes and released their leases. It cannot satisfy that binding. A separate reviewed
sealed-artifact binding must use fresh operator-selected GitHub account/connection/grant
authority and a retained, credential-free read-only bundle exporter while preserving the
capability service's approval, input hash, policy and recovery checks.

Accepted fixes likewise require a new writable artifact generation derived from the
sealed parent, with explicit fresh writer authority and parent revision/hash binding.
The parent retention and receipt remain immutable. After actual fix completion, the new
generation must be drained and sealed before delta review. No automatic unseal, synthetic
live writer, or reopened parent volume is provided here.

## Local sealed export prerequisite

The internal owned host exposes `inspectCompletedArtifact({fenceId, operationId,
baseBranch}, signal)` and `exportCompletedArtifactBundle({fenceId, operationId,
sourceBranch, baseBranch, sourceOid, maxBytes}, signal)`. Both require a fresh
completed seal in the original session/custody epoch. They create a journaled,
pinned, credential-free Podman helper with no network and a read-only source
volume, recheck the complete Git proof, prove terminal exit and exact helper
cleanup, then revalidate custody and the durable session snapshot. Unknown create
outcomes and uncertain cleanup block subsequent export; no retry clears evidence.

Inspection requires existing local origin base/default refs and a credential-free
GitHub origin URL. It never fetches missing refs. Bundle output is bounded to at
most 8 MiB, hash checked before the journal completes, and returned only after
cleanup. The inspection's branch-protection placeholder is not policy authority;
the eventual publication host must independently resolve protected/default branch
policy and operator-selected GitHub authority. No live writer identity is invented.

This increment is local, not an enabled review/publication route. Offline real-Git
and mocked host-boundary tests cover inspection, bundle verification, size and
identity rejection, unknown create and failed cleanup. Exact combined-source
physical export remains pending. Existing earlier physical verifier evidence used
an explicitly reported canonical-target projection and does not prove this new
exporter. Child artifact generations will require a reviewed generation-scoped
parent lookup; current snapshot checks intentionally remain strict.
