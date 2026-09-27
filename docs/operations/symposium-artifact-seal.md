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
