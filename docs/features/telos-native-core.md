# Telos as a Mitzo core service

Source: Dimitri's direction in conversation `694de895-1f53-8812-bb1b-c0c7038d1b93`,
7 November 2026, to finish migration and trace the full flow without redundant
calls. This candidate reconciles the existing migration in draft Mitzo PR #1239
(`5b820b75d05a37bba59e2cb16033c6b281528a34`) with ordinary-chat fixes and accepted
main `44e872c8a615e30bd75ac9738101dfbfaa1d6aa7`. Companion source importer:
[MGMT PR #363](https://github.com/dimakis/mgmt/pull/363).
Local implementation, review and checks do not prove acceptance or activation.

## One private canonical store

One resolver supplies HTTP, ordinary execution, retained file owners and backup.
`TELOS_DB_PATH` is the explicit override; otherwise the database is
`<MITZO_TELOS_DATA_DIR>/telos.db`, defaulting to `~/.mitzo/private/telos/telos.db`.
There is no automatic fallback to an MGMT workspace database.

Bootstrap validates storage once before serving requests. It refuses an empty
replacement over legacy data, ownership records, sidecars or migration receipts.
Existing files must be owned regular single-link files with private permissions
and the original canonical item schema; supported older columns are upgraded
atomically. Existing and fresh storage require an owned, nonsymlink directory
with mode 0700. Fresh initialization exclusively creates a private file.
Ordinary opens require the database to exist.

`TelosRuntimeStore` is the native owner and reuses the item owner's canonical
connection. The compatibility export `MitzoTelosStore` names that same class;
it opens no additional owner. Runtime operations execute no MGMT Python or YAML
refresh. IDs, unknown columns/tables, history, artifacts and links are preserved.

## Complete request flow

| Entry                                                     | Admission                                                                      | Persistence and response                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Work collection                                           | Existing authenticated route                                                   | Existing canonical collection snapshot, batched evidence and memoized lifecycle ancestry.                                                                                                  |
| Existing client `/api/todos` list                         | API authentication; Archive/Trash additionally require an interactive operator | One read-only owner. Four data queries fetch items, selected evidence and lifecycle ancestry; one tree assembly and no per-item queries. Empty stores expose `manual` for first creation.  |
| Interactive create, priority, star, snooze and completion | Existing operator authentication and validated input                           | One owner. Lifecycle admission and progress/history commit on the original writer. Parents cannot complete with unfinished descendants. Priority and stars stay independent.               |
| Ordinary agent brief/progress/child mutation              | Original native/operator context, exact approval and fresh revision            | Item owner opens lazily. Current authority and lifecycle are checked at its writer boundary. No unrelated work-store initialization or post-commit authorization renewal.                  |
| Full agent inspection                                     | Original authenticated context                                                 | Item and work views remain distinct because inspection includes lifecycle/control metadata. Large reads retain the fragment protocol.                                                      |
| Reviewed original-source creation                         | Compiled source preview, explicit approval and current source authority        | One outcome transaction creates root, milestones, history, links and immutable receipt. The existing source-capture journal retains original messages and origin backlinks.                |
| Source import                                             | Dedicated controller-only import credential                                    | One canonical writer. Batches preserve authored fields and progress, updating only source evidence, urgency and last-seen on existing items. No source refresh can overwrite a brief edit. |

Source imports accept at most 500 items and reject duplicate identities, missing
parents and cycles atomically. Topological assembly is linear. Two batched reads
load existing identities and evidence; existing parents add one batched lifecycle
read. Statements are prepared once per batch. New children require active,
unfinished parents. Evidence keys hash an unambiguous tuple; existing legacy
evidence identities are retained when refreshed.

An expired snooze is the sole read escalation. A committed snapshot observes a
due transition, then a writer conditionally rechecks status/date under its lock.
Future and indefinite snoozes acquire no writer. Other errors and uncertain
effects are never automatically replayed. Calendar dates use the host day.

Outcome receipt hydration uses five reads regardless of milestone count. Exact
retries return the immutable original receipt after later edits. Changed input
conflicts; a deleted outcome cannot be recreated by replay. Older retained
`telos_runtime_creation_receipts` are upgraded without changing receipt bytes.
A historical item key without a verifiable receipt requires inspection rather
than guessing an original request from its current edited fields.

Large successful ordinary mutations return a bounded item/revision acknowledgement
with `detailOmitted`, retaining the full durable receipt. Approval failures are
reported distinctly from storage/context failures.

## Private boundaries

The process-lifetime private-path registry retains current and previous storage
roots and resolved selector aliases. Provider SDKs and controller hooks retain
their filesystem fences; import authority is removed from provider environments.
The narrow import endpoint accepts its own credential, never operator cookies or
agent tokens. Import responses are private and uncached. The platform qualification
limits from the migration runbook remain applicable; this change grants no new
production or model-testing authority.

## Controlled cutover and rollback

Follow [the storage cutover runbook](../operations/telos-storage-cutover.md) using
accepted sources after required review and CI. Stop Mitzo and all legacy writers,
including MGMT refresh jobs. The single offline transfer utility is:

```sh
python3 scripts/migrate-telos.py --source SOURCE --destination ABSOLUTE_DESTINATION --writers-stopped
```

It reserves the source writer, captures a WAL-aware read snapshot, checks schema,
typed rows/BLOBs, integrity and foreign keys, then publishes exclusively with a
durable migration receipt. Temporary files and receipts are private from creation.
Large BLOBs are hashed as bytes without expanding into JSON or hex arrays. Source
files remain intact; uncertain published destinations remain for inspection.

Retained `.telos-file-owners` entries, including broken symlinks, block standalone
relocation. Keep such a family's registered paths and explicitly select its
existing canonical database for native operation, or use a separately supported
coordinated ownership transition. Never regenerate birth metadata to authorize a
copy. Do not run two writable canonical copies.

Restart the accepted release with the selected private database, then verify IDs,
revisions, ordinary edits/progress, source-backed creation/import, descendants,
archive/restore, reconnect and backup. Configure the companion MGMT importer to
send source batches through the narrow API and retire its old canonical writer.

Before rollback, stop writers and preserve the current destination and receipt.
The original source is a pre-cutover recovery point: reverting to it after new
writes requires reconciliation to avoid losing post-cutover work.

## Verification boundaries

Focused regressions use disposable storage and synthetic native/provider effects.
They cover privacy, import authority and overwrite protection, query budgets,
committed reads beside writers, immutable replay, atomic rollback, guarded
completion, oversized acknowledgements and WAL/BLOB migration. No model calls or
production data mutations are part of these checks. No UI layout is changed.

The consolidated candidate passed 1,818 Telos tests in 184 files. Provider/SDK
regressions passed 103 tests with three existing skips; the failed legacy
environment-token regression and synthetic-path fixtures were fixed and their
three files rerun successfully. Full server type checking, server and frontend
builds, source fingerprints and staged lint/formatting passed. Exact-head CI and
Centaur approval are still required before merge. Four host-dependent
integration files were locally blocked by account/workspace setup or the fenced
private host path; CI must retain their applicable coverage. Full live acceptance
and the screenshot's original inner failure remain unproven.
