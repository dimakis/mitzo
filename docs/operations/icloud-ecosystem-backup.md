# Encrypted ecosystem backup to iCloud Drive

Telos: `29bbaa8463012f88`; consistency inventory: `6fa2cce4e2839194`;
replacement-machine rehearsal: `7218d9f609e25d2e`.

## Implemented foundation

`server/backup/capture.ts` requires an explicit list of required stores, unique
store-owner adapters, and an owner-supplied write barrier. SQLite snapshots use
`better-sqlite3`'s supported backup API on the owner's connection and validate
integrity and foreign keys. Store watermarks and the coverage receipt are included
inside the encrypted backup. This API does not itself fence application writers;
a caller must implement that contract before live use.

`server/backup/restic.ts` runs a configured absolute Restic executable, rejects
partial/nonzero results, and passes the password only in the trusted child environment, without writing
it to disk. No inherited provider credentials enter that environment. Restic
owns encryption, compression and content deduplication. Independent password
recovery must be explicitly confirmed before construction. This confirmation is
host configuration, not proof that recovery has been rehearsed.

`server/backup/icloud-transport.ts` publishes completed encrypted Restic
repository files as immutable SHA-256-addressed objects. A small generation
catalog maps repository-relative filenames to those objects. Unchanged encrypted
objects are shared between generations. The active Restic repository stays outside
iCloud, and the caller must hold its repository writer fence through export.
Restic lock files are not exported; a repository with active locks is rejected.

Catalogs disclose generation time, ciphertext sizes and opaque Restic filenames,
not source filenames, private paths, document contents or store watermarks. They
are not cryptographically authenticated by this transport. Hash checks detect
missing/altered objects; Restic's authenticated repository validation is required
before trusting recovered application bytes. Publish accepts a trusted completed
Restic repository, not arbitrary untrusted files renamed to look like one.

Upload status is an injected host capability. `icloud-upload-probe.ts` invokes a
configured native helper compiled from `scripts/backup/icloud-upload-status.swift`.
It checks Apple's ubiquitous-item upload/error metadata without reading contents
or printing paths. Non-iCloud files and unavailable metadata return unknown. Missing, unknown or failed probes
mean **pending**, never off-device success. A local read-back is not a remote
restore test. Reconstruction validates all objects and stages into a new empty
location; application restore additionally runs a full Restic check and verified
restore. Existing destinations are refused.

No HTTP route, background scheduler, production credential access, live upload,
retention deletion or service shutdown is enabled by this foundation.

## Mitzo/Telos core capture

`captureMitzoTelosCore` binds three required existing SQLite owners: EventStore,
TaskStore (including its shared workload/template tables), and TelosArtifactStore.
It includes all Telos database tables, DB-only relationships/session links, saved
artifact revisions and their bytes. It covers **only this core group**; account and
connection stores, provider continuation stores, notifications, profiles/reviews,
workspace files, external attachments, manual YAML and sandbox volumes are separate
required groups before ecosystem protection can be claimed.

`app.ts` exports a host-only `captureMitzoTelosCoreBackup(destination)` capability
bound to the existing running EventStore and TaskStore. It resolves the same
canonical Telos path as artifact operations when invoked, opens an existing Telos
owner, and closes that temporary owner after capture or failure. Binding itself
opens no Telos database and runs no capture. A missing canonical database fails;
it never substitutes an empty store. No HTTP route exposes this capability.

Each owner exposes supported SQLite backup and a change watermark. Before capture,
the coordinator records all source versions without yielding. It checks the same
owners again after snapshot validation and durable capture writes. Own DML uses
`total_changes()`, other connections use `data_version`, and schema/persistent header
versions are included. Open transactions or closed owners reject capture. A changed
source discards the entire candidate; live writes continue and durable retry policy
belongs to the scheduler. Sustained activity can prevent a candidate completing;
this does not promise bounded completion or substitute for a future cooperative
quiescence API. Source paths are never reopened or raw-copied by this coordinator.

Only one capture can use a given owner at a time in this process. Cross-process job
fencing remains a deployment requirement. Restore destinations must be new; the
synthetic test deletes all original source databases before opening restored owners.
No private-state capture or upload is enabled by adding these APIs.

## Current inventory and owner contracts

Runtime paths must be resolved from the active deployment, not copied from a
source checkout or inferred from this table. A group is incomplete until all of
its required adapters are bound and its cross-store fence is demonstrated.

| Consistency group | Required data                                                                                                                                                           | Snapshot owner / unresolved contract                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mitzo             | Event/task/workload stores, connections/capabilities, Codex and Responses continuation, Symposium profiles/artifacts and Telos artifact registrations, attachment bytes | Register the actual running owners and their connections. Coordinate conversation/task/attachment references and in-flight writes. Inspect new stores on accepted main, not only the older local checkout. |
| MGMT/Telos        | Source documents, manual YAML, Telos SQLite DB-only relationships/session links, dirty/untracked workspace files                                                        | Telos owner snapshot and YAML/writer barrier. Explicit file inclusion/capture policy; worktree cleanup must not remove uncaptured work.                                                                    |
| LifeOps           | Encrypted evidence/index, facts, source revisions, case identity and reviews                                                                                            | Vault lock-held snapshot API in LifeOps; independently recoverable **vault** key in addition to the backup password. No plaintext financial records or real keys in source control.                        |
| OpenShell         | Gateway DB/key/trust/config, retained sandboxes/VM disk, account profile, release and runtime locks                                                                     | Prescribed cold snapshot from `infra/openshell/README.md`: quiesce Mitzo, stop gateway and Podman, capture matched set, validate, restart. No live VM file copy.                                           |
| ContexGin         | Unique goals/registry/publication state and accepted revision/config                                                                                                    | Owner API; classify graph/embedding/cache projections separately and rebuild only the restored published revision.                                                                                         |
| Centaur           | Unique jobs/reviews/receipts/artifacts and configuration                                                                                                                | Resolve current release/state owners; preserve source/runtime identity and distinguish rebuildable dependencies.                                                                                           |
| Recovery          | Restic repository recovery password, LifeOps vault key, gateway credential key, Apple account recovery                                                                  | Separate independently accessible recovery method. Reauthenticate provider/device credentials where appropriate. Do not restore stale device tokens blindly.                                               |

Capacity planning must measure unique application state, retained workspace files,
VM disks, compression and daily changed data separately. Exclude rebuildable
dependencies and apply a bounded policy to operational logs. Initial capacity
estimates are budgets, not exhaustive coverage or compressed-size evidence.
Existing iCloud quota can be used once the operator confirms adequate free space.

## Next delivery gates

1. Bind and test owner snapshot APIs and actual runtime paths; fail closed on
   incomplete groups. Persist durable retries and truthful per-group freshness.
2. Install and bind the native macOS iCloud status helper; exercise quota/offline
   and unknown states on the actual destination. Uploaded catalogs require every referenced object uploaded.
3. Record independent key recovery and prove it with disposable keys. Do not
   infer that a Keychain item is recoverable on another Mac.
4. Add fenced single-writer orchestration and scheduling: frequent application
   snapshots, separately scheduled cold OpenShell snapshots with measured downtime.
5. Implement retention with reference reconciliation and remote deletion
   acknowledgement. No unreferenced-object cleanup in the initial transport;
   preserve objects referenced by every retained catalog. Monitor capacity.
6. Restore a cloud generation on a second/disposable environment without source
   paths or original Keychain, validate application relationships, then enable
   an opt-in production schedule from reviewed accepted sources.

## Native helper build

Compile the helper on macOS and configure its absolute executable path:

```sh
swiftc scripts/backup/icloud-upload-status.swift -o /absolute/path/to/icloud-upload-status
```

Compilation and a non-iCloud-file smoke check are local validation only. Apple's
upload metadata is evidence of upload, not a second-device restore rehearsal.

## Synthetic verification

Ordinary tests use temporary local directories and synthetic SQLite data. The
real encryption round trip is opt-in and uses an explicitly supplied Restic
binary, synthetic password and evidence, and a simulated local cloud folder:

```sh
MITZO_TEST_RESTIC_BINARY=/absolute/path/to/restic npm test -- server/__tests__/ecosystem-backup.test.ts server/__tests__/icloud-backup.test.ts
```

It deletes the original document and repository before reconstructing/decrypting
from transported ciphertext. No model, API account, native Keychain, financial
document or iCloud upload is exercised. It is not cloud acceptance.

References: [Restic backup](https://restic.readthedocs.io/en/stable/040_backup.html),
[Apple upload resource key](https://developer.apple.com/documentation/foundation/urlresourcekey/ubiquitousitemisuploadedkey),
[Apple account recovery](https://support.apple.com/en-ie/108756).

## Manual service and dashboard

`/backups` is available from desktop navigation and mobile More. Its operator-only
API is `GET /api/backups`, `POST /api/backups/run` and `POST /api/backups/refresh`.
POST bodies must be empty JSON objects; paths, credentials, capture selection and
host configuration cannot be supplied by an agent or browser. Actions return 202
once admitted, then the dashboard polls durable status. No scheduler starts.

The host must configure all of these before manual actions are available:

- `MITZO_BACKUP_ROOT`: a dedicated absolute local directory, owned by the host
  operator with permissions 0700, outside iCloud and all source stores. The service
  owns its `repository`, `temporary`, `captures`, `runs.json` and `writer.lock` names.
- `MITZO_BACKUP_ICLOUD_DIRECTORY`: a dedicated absolute directory beneath the
  operator's iCloud Drive. It must be separate from the local backup root.
- `MITZO_BACKUP_RESTIC_BINARY`: the absolute trusted Restic executable, installed
  outside backup storage and iCloud.
- `MITZO_BACKUP_UPLOAD_PROBE`: the absolute compiled upload-status helper, installed
  outside backup storage and iCloud (see compilation instructions above).
- `MITZO_BACKUP_RECOVERY_CONFIRMED=true`: set only after the operator has stored an
  independent recovery copy of the Restic password and checked how to retrieve it
  after losing this Mac. This is an operator attestation, not proof of recovery.

Store the same Restic password in the macOS login Keychain as a generic password
with service `mitzo.backup` and account `repository`, using Keychain Access. No
password is accepted by or returned to the dashboard, written to a credential file
or journal, or included in command arguments. The service obtains it from the fixed
Keychain entry only when Restic runs. Keychain denial or a locked keychain fails the
run with a sanitized error. Existing repositories must use the same password.

Use a local root that does not overlap a captured source; this is trusted host
configuration. Only the backup service may mutate its Restic repository while it
is enabled. Do not run independent Restic writers, prune or cleanup tools against
it. All service writers, including upload verification, hold an atomic directory
fence at `writer.lock`. Captures use the running Mitzo owners and a canonical Telos
owner, preserving the optimistic multi-store consistency check from the core
capture integration. Concurrent ordinary saves continue; a changed capture fails
and can be retried manually. Restic checks all data before export. Plaintext capture
folders are removed before the run is recorded complete and the fence is released.

`pending` means the encrypted repository was exported locally, but every encrypted
object and catalogue has not yet been confirmed uploaded by macOS. `uploaded`
requires the existing transport's complete hash/size checks and upload evidence.
“Check iCloud upload” refreshes pending generations without taking another capture.
A later verification error preserves the pending receipt. The repository size is
that generation's logical encrypted export footprint, not an account quota reading
or the sum of retained generations. The last confirmed upload is historical evidence,
not a continuous guarantee that Apple still retains the remote copy.

The private journal retains the latest 50 receipts (metadata only). This limit is
not backup retention: Restic snapshots and encrypted cloud generations are not
pruned. Scheduling, retention configuration, automatic retries, restore controls
and non-core ecosystem capture are not part of this iteration. The dashboard states
those coverage and recovery limits explicitly. The root is host-owned; corrupt,
symlinked or oversized journals fail closed rather than being silently replaced.

After a crash, an unfinished receipt is shown as unresolved and an abandoned lock
blocks all further writes. Do not clear it just to make the UI green. The host operator
must establish that no service/Restic writer remains, inspect repository integrity,
remove any leftover plaintext under `captures`, and reconcile the receipt before
removing the fence. If another process owns the fence, leave it untouched. Receipt
or cleanup failures also retain the fence. This conservative recovery is intentional;
there is no browser unlock action or automatic replay of an uncertain run.

Validation uses synthetic stores/credentials only. The first production upload still
requires accepted deployment sources, explicit destination/recovery setup and an
independently downloaded iCloud restore rehearsal before ecosystem backup is complete.
