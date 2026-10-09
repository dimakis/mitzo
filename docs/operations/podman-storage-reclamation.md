# Podman image reclamation

This is the first storage-reclamation delivery. It provides an operator command
and reusable host modules. It does not schedule cleanup, change allocation
admission, enable conversation retention, deploy staging, or activate production.
No model calls are involved. The incident recovery owner retains live remediation.

Run the dependency-free command with Node 24 from the accepted source checkout:

```sh
node scripts/podman-storage.mjs status --selection /host/private/selection.json
node scripts/podman-storage.mjs plan --selection /host/private/selection.json --output /host/private/plan.json
node scripts/podman-storage.mjs apply --selection /host/private/selection.json --plan /host/private/plan.json
```

`plan` writes a new file exclusively. Applying requires the exact plan, a matching
store and unchanged inventory/enrollment. Plans expire after fifteen minutes.
Changes invalidate the remaining run; replan after reviewing the reported result.
Exit 2 means blocked or partial, and exit 1 means an operation failed. Status
reports blockers even when collection itself succeeds.

## Store selection and measurements

On macOS the selection file explicitly identifies a machine connection:

```json
{
  "connection": "SELECTED_CONNECTION",
  "machine": "SELECTED_MACHINE",
  "hostBackingPath": "/host/path/to/selected-vm-disk.raw"
}
```

The operator must verify that `hostBackingPath` is the selected VM's actual disk
file. It is an explicit host measurement target, not inferred from the Mac root.
Without it, host measurement is reported unavailable. The collector checks the
connection URI, machine creation identity, SSH identity path and Podman socket;
it does not read the SSH private key. It discovers the selected store's graph
root, then runs `df` for bytes and inodes **inside that machine** on that path.
Guest machine ID, filesystem ID/source, graph driver and rootless/rootful mode
form the store evidence. An unavailable guest blocks cleanup. Rootful stores
whose graph root cannot be inspected through machine SSH remain blocked.

On Linux use `{ "local": true }`. Commands explicitly use `--remote=false` and
measure the local graph-root filesystem. Remote Linux stores are not supported
by this delivery. There is no fallback to a default connection or host root.
After inspection, inventory and deletion bind the remote URL and SSH identity
directly, or the local graph root and storage driver, rather than resolving a
mutable connection alias/configuration again. External machine replacement or
store reconfiguration must also respect the maintenance window; this host lock
cannot fence unrelated native administration tools.

Every measurement has a timestamp. Inventory has a two-minute collection bound,
and individual subprocesses have a fifteen-second bound. All containers are
included, including stopped, created and external build containers. Image lists
and container references are checked again after inspection. Partial evidence
never becomes an empty successful inventory.

## Reviewed enrollment

First obtain status and copy its exact `collection.store` object into a private
reviewed enrollment file. Complete the protection inventory with the original
owners before enrollment:

```json
{
  "version": 1,
  "review": "operator review reference",
  "store": {},
  "policy": { "keepLatest": 2, "graceDays": 7 },
  "protections": {
    "production": { "complete": true, "review": "owner evidence", "images": [] },
    "staging": { "complete": true, "review": "owner evidence", "images": [] },
    "provider": { "complete": true, "review": "owner evidence", "images": [] },
    "supervisor": { "complete": true, "review": "owner evidence", "images": [] },
    "candidate": { "complete": true, "review": "owner evidence", "images": [] },
    "rollback": { "complete": true, "review": "owner evidence", "images": [] },
    "checkpoint": { "complete": true, "review": "owner evidence", "images": [] },
    "custodian": { "complete": true, "review": "owner evidence", "images": [] }
  },
  "producers": [
    {
      "owner": "host-build-owner",
      "family": "runtime",
      "coordinated": true,
      "review": "producer integration review"
    }
  ],
  "builds": []
}
```

`store: {}` and empty protection arrays above are placeholders, not operational
evidence. Empty arrays require the owner's explicit confirmation that the scope
has no retained images. Resolve every protection to its full `sha256:` image ID
on this store and include required bases. Supervisor and rollback pins apply
even with zero direct containers. Checkpoint and original-custodian owners supply
their own image retention references; inventory cannot recreate their custody.
Missing protected images, parent metadata, ownership or scope evidence block
the entire selected store in this first conservative implementation.

Install or update the reviewed evidence through the shared maintenance lock:

```sh
node scripts/podman-storage.mjs enroll --selection /host/private/selection.json --reviewed /host/private/enrollment.json
```

Enrollment authorizes subsequent **explicit operator apply**. It enables no
periodic policy. The command preserves existing build records; enrollment cannot
rewrite them or discard an uncertain operation. Pin changes must use this same
command. Do not edit installed state to bypass a blocker.

Legacy images require records with `classificationReview`, `operation`, `owner`,
`family`, `state: "succeeded"`, `completedAt` (Unix milliseconds),
`reproducible: true`, `recipeDigest`, and `images` containing exact immutable IDs.
The owner must prove reproducibility before classifying an artifact. Names,
labels, age and lack of references provide no authorization. Sandbox commits,
historical stages, unknown creations and task data remain with their owners.

## Managed producer integration

The reusable `managedBuild` API in `scripts/lib/podman-storage-maintainer.mjs`
holds the store lock for the **whole** host-owned build callback. The callback
must use the selected Podman connection and return its exact immutable output
image IDs, obtained from the producer's output receipt (for example Podman's
`--iidfile`). A reviewed recipe supplies `owner`, `family`, `review`,
`reproducible: true` and `inputsDigest`. Its review must prove that the actual
inputs and build process reproduce only disposable build data. The API records
the recipe digest, active operation, successful completion time and output IDs.
It does not infer outputs from inherited labels or an inventory difference.

Host-owned producer integrations use this shape:

```js
const receipt = await managedBuild(
  maintenanceHome(),
  verifiedStoreIdentity,
  reviewedRecipe,
  async (signal) => hostProducer.buildAndVerifyExactOutputIds(signal),
  signal,
);
```

Existing shell builds are **not enrolled automatically**. Their integration
must cover all subprocesses, validation and output capture under this API before
an operator declares them coordinated. `coordinated: true` is an operator
attestation of that reviewed integration. Failed, timed-out or cancelled builds
remain durably uncertain. Original-owner recovery must reconcile their physical
effects before a separately reviewed metadata repair; no empty list or timeout
clears them. This delivery intentionally has no automatic recovery command.

This delivery deletes completed output images only. Intermediate images and
build caches are unclassified unless their producer supplies reviewed exact
output records. Generic cache pruning is not available. The latest two successful
build records per owner/family and a seven-day grace period are protected; shared
output IDs retain the union of their protections. Pins override both. Container
images and their parent/layer ancestry are also protected. Eligible children are
ordered before eligible parents.

## Apply, audit and qualification

Host authority lives in the private `~/.local/state/mitzo-storage` directory. Its
store key includes guest machine ID, filesystem ID, graph root, graph driver and
rootless mode, so connection aliases share one lock. No backend startup installs
a cleaner. A leftover lock is an operator-recovery blocker, never automatically
stolen based on PID or age. Use the same host account and authority directory for
all coordinated producers and pin updates on the configured store. Sandboxes
receive neither this authority nor a Podman socket.

Apply re-collects evidence before **each** deletion, while holding the lock. The
only deletion command is `podman image rm --no-prune FULL_SHA256_ID`, with the
explicit selected connection. It never uses force, system prune, volume pruning,
container deletion or recursive parent removal. Podman refusals are skips or
failures. A successful command is recorded as removed only after complete
inventory verifies the exact image ID is absent. Unplanned concurrent references
stop the remaining run even when Podman itself would permit the next deletion.

The audit precedes each destructive operation and records per-ID outcomes and
before/after guest bytes and inodes. It resides outside the guest on macOS and
rotates at eight MiB, retaining two prior files. Last-run status is persisted
separately. Failure to write pre-operation audit prevents mutation. Final guest
measurement failure makes the result partial. Concurrent writes and shared
layers prevent attributing the observed delta exactly to this run. No image-size
sum or fixed recovery promise is reported. See [Podman removal semantics](https://docs.podman.io/en/latest/markdown/podman-rmi.1.html)
and [Podman disk usage caveat](https://docs.podman.io/en/latest/markdown/podman-system-df.1.html).

Unit acceptance uses simulated Podman commands and temporary host state:

```sh
npm test -- scripts/__tests__/podman-storage-policy.test.ts scripts/__tests__/podman-storage-host.test.ts scripts/__tests__/podman-storage-maintainer.test.ts scripts/__tests__/podman-storage-cli.test.ts
```

Before an authorized real plan/apply cycle, complete owner evidence, classify
eligible outputs and review the exact IDs. Record all container/volume identities
before and after, verify they remain present, verify only planned images are
absent, and retain measured guest/host headroom and per-ID outcomes. No real
deletion acceptance or policy activation is claimed by these unit tests.

Recurring maintenance and Mitzo visibility, shared allocation admission and
conversation retention qualification remain separate deliveries against current
main. Keep Telos `769f3f8d8e9be028` open until retention and automatic reclamation
are operational and verified. Conversation retention uses #503's consent,
checkpoint and preservation checks. Canonical staging and its exact-commit
acceptance/deployment procedure apply; provider enrollment is still pending and
retained October environments are excluded. Any real model acceptance must
announce the supported Luna model and charged account. Production activation is
a separate explicit action.
