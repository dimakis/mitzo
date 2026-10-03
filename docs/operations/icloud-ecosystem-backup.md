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
