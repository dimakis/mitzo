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
