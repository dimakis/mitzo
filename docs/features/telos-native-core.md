# Telos as a Mitzo core service

Source: Dimitri's implementation direction in conversation
`694de895-1f53-8812-bb1b-c0c7038d1b93`, 7 November 2026, including the explicit
request to trace the complete flow and remove redundant calls and checks.
Baseline: accepted Mitzo `3079701d8f714945f8478508382e17ff20c61299`.
This document describes the implementation candidate. A passing local check is
not publication, production cutover, or live acceptance.

## Ownership and selection

Mitzo initializes and operates the original canonical SQLite schema directly.
Lists, creation, actions and reviewed source-backed creation no longer execute
MGMT Python or seed mutable workspace YAML. Saved IDs are never reconstructed
from titles. Existing columns, source links, history, relationships, artifacts,
unknown extension tables and bytes remain in the same database.

One resolver supplies the API, ordinary execution and retained file-owner
selection. `TELOS_DB_PATH` remains the explicit override. New installations use
`<workspace>/.mitzo/telos.db`. Existing legacy files remain selected until an
explicit cutover; the server never silently opens an empty second backlog.
Backup continues to use that same selected canonical database.

An empty collection supplies the native `manual` profile so the existing UI can
create its first item without a workspace profile file.

## Complete request paths

| Entry                                              | Admission                                                                        | Persistence and response                                                                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work collection                                    | Existing authenticated collection route                                          | Existing canonical owner, committed snapshot and batched projection; no Python.                                                                                                                                                                            |
| Legacy `/api/todos` list used by existing clients  | Existing API authentication; Archive/Trash also require an interactive operator  | One read-only owner and transaction. Four queries read items, selected sources, selected links and lifecycle ancestry. One memoized ancestry pass and one tree assembly; no per-item DB calls or second work store.                                        |
| Interactive create/priority/star/snooze/completion | Existing operator authentication and validated request                           | One item owner. Lifecycle admission runs inside its writer transaction. Progress, canonical history and retry receipt share the same commit. Parents cannot complete with unfinished descendants.                                                          |
| Ordinary agent brief/progress/child change         | Original native/operator context, exact approval, fresh item revision            | Item owner opens on demand. Fresh context and lifecycle are checked at the actual writer boundary. No work-store initialization, role assignment, subprocess, worker allocation or post-commit authorization renewal.                                      |
| Full agent item inspection                         | Original authenticated context                                                   | Item and work views remain distinct owners because inspection includes progress plus lifecycle/control metadata. Large reads retain the existing fragment protocol.                                                                                        |
| Reviewed original-source outcome creation          | Existing compiled source preview, explicit approval and current source authority | One native outcome transaction creates root, milestones, history, links and creation receipt. Existing source capture then retains its immutable original exchange, origin backlink and recovery journal. That approved cross-owner protocol is preserved. |

An expired snooze is the sole list escalation: a read-only snapshot identifies a
due transition, then one writer retry rechecks it under the lock and commits
status plus history together. Ordinary reads acquire no writer. Other errors and
uncertain effects are never retried automatically.

Outcome receipt hydration uses five reads regardless of milestone count. Item
and evidence reads are batched. Exact creation retries recover the original
receipt, even after later edits, without rewriting the current item. Changed
input under the same key conflicts. Historical keys with no compatible retained
receipt require inspection rather than guessing an original request. Deleted
outcomes cannot be recreated by replaying their old creation key.

Large legacy brief edits keep the full durable receipt but return a bounded
acknowledgement with item ID/revision and `detailOmitted`; callers can inspect the
item using paged reads. A denied or modified approval is reported as approval
failure, rather than a generic storage outage.

## Controlled data cutover

Use the accepted build only after the normal exact-head review/CI gate. For an
existing retained file family (a `.telos-file-owners` directory beside the
canonical database), keep `TELOS_DB_PATH` and all three family files at their
current paths. Native persistence works in place; no file relocation is needed.
Birth metadata pins paths and file identities and cannot be copied or regenerated
to authorize a move. The copy utility refuses retained source/destination
directories. A future relocation needs a separate supported ownership transition.

For an unenrolled legacy database that needs a new destination, stop Mitzo and
**all legacy Telos writers** before the final copy. This includes any MGMT
refresh/import jobs; they must not continue writing a retired source.

```sh
node --import tsx scripts/migrate-telos.ts --offline SOURCE DESTINATION
```

The utility uses SQLite backup, including WAL content, rather than copying the
main file alone. It verifies integrity and a complete schema/table/BLOB inventory
under one source snapshot, publishes the destination without overwrite and
preserves the source. Unknown tables and immutable artifacts are included.
The temporary backup is created exclusively with private permissions before any
database bytes are written.
It neither changes runtime configuration nor restarts a service.

Set `TELOS_DB_PATH` to the verified destination for the accepted Mitzo release and
any intentionally retained canonical readers/importers. Restart once, then
verify list, existing IDs/material revisions, ordinary brief/progress edits,
source-backed creation, child completion, archive/restore, reconnect and backup.
Retire the old writer configuration. Do not run two writable canonical copies.

Before rollback, stop writers and preserve a backup of the current destination.
Never point at the old source after new writes without reconciling those writes;
that would lose post-cutover work. The unchanged source is a pre-cutover recovery
point, not an automatically current rollback database.

## Verification boundaries

Focused regressions use disposable databases and fake native/provider effects,
with no model calls, private production rows or production activation. They
cover constant query counts, committed reads under a concurrent writer, atomic
rollback, durable replay, oversized receipts, ordinary-chat approval/status
semantics, original source preservation and WAL/BLOB migration. Existing
lifecycle, permission, source and retained-owner regressions remain required.
No UI layout or approved mock is changed by this backend migration.

Local verification on 7 November 2026: the final Telos/native/Todo regression
selection passed 1,148 tests in 105 files with one worker and a 1 GiB Node heap.
Frontend and server builds passed, including the reviewed-handler fingerprint
and security-backport checks. Changed-source lint, formatting and diff checks
also passed.

Two independent local source reviews identified backup creation permissions,
retained-family relocation and empty-backlog profile selection. Those findings
were corrected and both reviewers verified their respective deltas. The final
focused HTTP/store/collection/migration selection passed 57 tests across five
files, including the new regressions. These local reviews do not supply Centaur's
required final approval.

Four integration files were excluded from that final selection. CT06
(`telos-canonical-journey`), CT09 (`telos-ordinary-canonical-journey`) and CT12
(`telos-coordinator-v2-native-journey`) fail before the relevant effects because
host account profiles or workspace selection are unavailable; the same failures
were reproduced on untouched accepted main. `telos-ordinary-artifact-platform`
requires the explicitly fenced private host directory. Their original failures
and baseline evidence remain in the local test-results directory. These journeys
require a qualified environment before claiming complete live acceptance.
