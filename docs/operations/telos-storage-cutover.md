# Telos storage ownership and cutover

Source contract, updated 2026-11-07: `server/telos-runtime-storage.ts`,
`server/telos-runtime-store.ts`, `server/telos-runtime-routes.ts` and
`scripts/migrate-telos.py`. Verified with synthetic storage, migration and HTTP
tests. This documents the candidate implementation; it does not certify a live
installation. Recheck when storage ownership, import authentication or the
SQLite file-family contract changes.

Mitzo owns canonical Telos items, outcome creation, history, artifacts and
receipts. The default database is `~/.mitzo/private/telos/telos.db`, outside source
checkouts and release directories. `MITZO_TELOS_DATA_DIR` selects another private
directory; an explicit `TELOS_DB_PATH` overrides it. Keep the directory owned by
the service user with mode 0700 and its database with mode 0600. Agent filesystem
policy protects selected storage, including an earlier selection after a config
change. Codex and Claude share this retained storage registry. Claude's outer
filesystem boundary is required even without credential isolation or workspace
runtime enrollment; this boundary is currently qualified for macOS and refuses
unsupported platforms. Controller project hooks use the same filesystem fence.
Executable boot-context fallback also requires that fence; HTTP context retrieval
from ContexGin remains available without local command execution.
The source-import credential is never inherited by provider children. Providers
use host tools and HTTP APIs.

Startup validates both existing and fresh storage directories. A shared or
symlink directory is refused without changing its permissions or moving files.

Existing database files must already contain the canonical item schema. Startup
can upgrade supported older columns; it refuses empty or unrelated SQLite files
instead of initializing them over retained legacy work. Reads renew snoozes only
after a read-only check finds due items, then recheck eligibility under the
writer lock. Future and indefinite snoozes do not require a canonical writer.

MGMT is a source importer. It submits at most 500 records per request to
`POST /api/telos/import`. A dedicated `MITZO_TELOS_IMPORT_TOKEN` of at least 32
characters authenticates only that endpoint. A source record can initialize an
item's title, context, links, hierarchy, priority and categories. Later imports
update source evidence, urgency and last-seen time; they preserve authored fields,
progress, hierarchy and history. An invalid batch rolls back completely. Failed
delivery never falls back to local SQLite writes. Imports can be retried with the
same source identities.

## Prepare an authorized maintenance window

1. Land both the Mitzo storage change and the MGMT importer change through their
   normal CI and Centaur gates. Production activation is a separate operator
   action; ordinary development does not restart either service.
2. Identify the running service user, exact legacy database, current Mitzo release,
   refresh release and every direct SQLite writer. Check the configured paths
   rather than inferring them from a development checkout. Record rollback
   selections privately. Keep real database files and credentials out of Git.
3. Configure the same dedicated import token in the Mitzo and refresh-service
   environments through the host's secure configuration mechanism. Configure
   MGMT's `MITZO_TELOS_URL` as an HTTPS origin, or loopback HTTP. Do not put the
   token in a committed plist, a command argument, transcript or diagnostic log.
   The scheduler's environment must contain both variables; a successful
   `--profiles` release preflight checks code loading only.
4. Review retained source-creation receipts and interrupted tool operations before
   retrying a failed outcome. A dismissed review can still have a retained save.
   Moving the database does not reconcile that operation or authorize a new one.
   Native creation preserves stored legacy receipt bytes. A historical creation
   key without its original receipt requires inspection; current item contents
   cannot stand in for the original creation result.

## Stop writers and transfer

Stop Mitzo, the legacy MGMT refresh job and any other SQLite writers. Confirm
they have stopped and prevent automatic restarts for the maintenance window.
Retain the old database and its sidecars intact. Do not copy only the main file
while WAL writers are active.

From the accepted Mitzo release, with absolute paths set by the operator:

```sh
python3 scripts/migrate-telos.py \
  --source "$legacy_database" \
  --destination "$private_database" \
  --writers-stopped
```

The script takes a reserved writer lock, captures a complete SQLite backup and
verifies schema, every typed row (including BLOBs and unknown tables), integrity
and foreign keys. It creates an exclusive destination and a private
`<database>.migration.json` receipt. It never overwrites or removes the source.
The receipt contains table counts and a content fingerprint, not record bodies.

Existing destination files, sidecars or receipts block a retry. Inspect them and
the receipt first; do not delete uncertain results to make a rerun succeed. An
incomplete receipt means the transfer is unconfirmed even if a file exists.

The standalone transfer refuses a retained `.telos-file-owners` family at either
end. Such a family binds canonical, events and tasks file identities together;
moving only canonical SQLite cannot preserve its authority. Use that family's
reviewed coordinated restore procedure. This script does not supply one. Never
delete, regenerate or move its ownership records as a workaround.

## Select and verify

1. Select the verified private destination in the Mitzo service configuration and
   start the accepted Mitzo release. Startup refuses an empty replacement if it
   finds an unmigrated legacy store, SQLite sidecars, an ownership family or a
   migration receipt at either location. Unreadable storage is not treated as
   absent. Missing or invalid storage returns an error.
2. Verify representative existing item IDs, parents, completed-child counts,
   authored briefs, progress history and binary artifact downloads through the
   operator API. Verify creation and exact-request receipt recovery against a
   separately authorized live target. Record evidence privately.
3. Switch the refresh job to the accepted MGMT release. Its command must include
   `todo --all --refresh --quiet --import-to-mitzo`; it must have no direct
   `TELOS_DB_PATH` or legacy-local override. Verify one import receipt, then
   repeat the same source input and confirm user edits and completion survive.
4. Verify no legacy writer restarted, and include canonical SQLite and its
   receipts/artifacts in the service's private backup policy. Keep the original
   store until the operator accepts the cutover and rollback retention period.

Before any writes reach the new store, rollback may restore the recorded old
service selections while both services remain stopped. After new writes, the
source is stale: stop all writers and use a separately reviewed reconciliation
or restore. Restarting an old refresh writer against stale data would lose work.

Change note: replaces MGMT checkout storage and subprocess creation with private
Mitzo storage, native operations and authenticated source intake. Existing saved
data needs an explicit transfer; source acceptance alone proves no migration,
deployment or consumer adoption.
