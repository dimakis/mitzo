# S2 durable work/session relationships

Parent `85e8444019a4ae4a`; slice `847cb038d1e46d16`. Built from accepted
Mitzo main `41c4b051f82347841f2cda51b1ef252e3895d413`, including S1 #973
and the accepted #962 reviewed source manifest. No product UI changes.

## Ownership and recovery

`TelosWorkStore` extends the existing canonical Telos SQLite database. The
existing `items.parent_id` remains the only composition tree; explicit kinds
live in an extension table. Unknown legacy kinds remain null. Canonical SQL
insert/update guards reject missing parents, cycles and invalid known kinds,
including writes by the Python Telos owner. No legacy item fields, dates,
profiles, single-session hints or accounting IDs are rewritten by enrollment.

Role links are many-to-many. Current lead/worker assignments and append-only
assignment history are separate. Origin links can name external Codex sources;
external origins never enroll a Mitzo session. Removed/unavailable conversations
retain their link and assignment attribution. A work command never writes normal
session settings, runtime bindings, drafts, history or the task execution tree.

Work command receipts are immutable and scoped to the host-authenticated actor
and request ID. Exact replay returns the original receipt even after later
changes; changed input under that identity fails. Whole-item revision checks and
per-assignment revision checks run under SQLite's immediate write transaction.
Adopted source snapshots pin exact selections, brief hashes and artifact
revisions; later edits cannot overwrite a snapshot. Source capture and legacy
transfer remain S3's responsibility; storing a reference is not source proof.

The work allocation outbox records an intent and stable allocation key before a
cross-store operation. It is not an allocator, runtime, scheduler or model queue.
`pendingAllocations` supplies the exact child, parent lead, pinned context and
requested settings to the existing allocator's future S5 consumer. The consumer
must revalidate current scoped authority and use that same allocation key on
recovery. `recordAllocation` accepts only a host-verified ordinary allocation
receipt, atomically links the worker and records chat readiness. It rejects the
lead itself and conflicting receipts. It neither assigns the current worker nor
starts a turn. Explicit retries retain their predecessor and use a new key.

`SessionService` remains the ordinary child allocator and start-outbox owner;
its grant/admission/start/reconcile behavior is unchanged. The integration test
uses its actual durable allocator, loses the response before Telos linking, then
recovers the same session without calling its fake runtime. S4/S5 will connect
this seam to ordinary chat setup and scoped lead tools. No consumer runs here.

The existing `captureMitzoTelosCore` backup already captures the entire canonical
Telos database and ordinary event store. The restoration test reopens these
actual restored stores and checks links, assignments/history, source snapshot,
artifact bytes/hash/revision, pending intent, immutable receipt replay and
ordinary account/model metadata. No second backup engine is introduced.

Existing MGMT item models/API and Mitzo session metadata/task/backup owners need
no schema change for this boundary: new records extend their existing SQLite
ownership, parent writes go to the existing column, and ordinary settings remain
owned by `SessionMetadataStore`. S3 handles lossless DTO transfer; S7 composes the
existing item DTO with this relationship projection. Session backlinks come from
the relation query, rather than replacing `telos_task_id` with another identity.

## Authorized API

Operator endpoints require the existing interactive operator middleware and a
host-supplied authenticated session identity. Caller-chosen actors are rejected;
internal tokens alone confer no operator access. Read/write responses are
private and uncached. Invalid commands roll back; private database paths are not
returned on owner failure.

- `GET /api/telos/work/items/:itemId` reads a relationship projection.
- `POST /api/telos/work/commands` applies a typed operator command.
- `POST /api/telos/work/links` queries retained backlinks for a typed conversation reference.
- `POST /api/internal/telos/work/read` requires both the existing host credential
  and an active ordinary conversation explicitly linked to that exact item.
  It grants no mutation or access to other conversations' transcripts.

The shared `TelosWorkApiClient` validates inputs/results, includes ordinary
credentials and returns conflicts. It never allocates a session, retries a
command implicitly, replaces request IDs, changes settings or starts a model.
There is no public endpoint for submitting allocation receipts.

## Test-first and conformance evidence

The first implementation artifact was
`server/__tests__/telos-work-store.test.ts`; its initial run failed on the absent
store module. API/client tests likewise failed on their absent modules before
implementation. Hardening tests separately reproduced an accepted lead-as-worker
receipt and an incomplete recovery projection, then passed with their fixes.
All red/green logs are retained with the slice report outside source control.

| UX row | S2 evidence                                                                                                                        | Remaining product qualification                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| UX02   | Explicit kinds, canonical parent, missing/cyclic/invalid parent refusal; whole-item and assignment conflicts                       | S7 tree and workspace rendering                         |
| UX07   | Immutable exact source selections, brief/artifact references; reverse conversation links                                           | S3 capture/authorization and S7/S8 navigation           |
| UX11   | Exact child/parent-lead/context allocation intent and retained worker/attempt links                                                | S4/S5 actual reviewed context and lead return path      |
| UX14   | Multiple links survive assignment replacement and historical reads                                                                 | S8 New chat / Change worker controls                    |
| UX15   | Existing ordinary session metadata remains byte-for-byte independent; unavailable history remains attributable                     | S8 drafts/settings/navigation and S9 reconnect          |
| UX20   | Null unknown provenance survives; existing backup restores actual relationship/source/artifact data                                | S3 full legacy transfer and S9 device/runtime cells     |
| UX21   | Actor/request replay, concurrent-owner conflicts, existing allocator crash recovery, explicit retry predecessor and no model start | S5 runtime admission/queue failure and end-to-end retry |

Baseline: approved mock `9d0559132154b92d0bbb427a982a0002@r1`, SHA-256
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
Desktop/Mobile mock inspection archive `151120e2761ce5d8b0a1196e2f21fd3b@r1`
is prototype reference evidence, not implemented product acceptance. Dimitri
accepted that preview before S2 began. The frozen files are unchanged; no UX
amendment is proposed. Live product, physical-device and runtime qualification
remain outstanding. No model calls, staging operations or deployment occurred.

## Review fixes

Centaur CEN-93D148A5595A and CEN-3DB3CAFDAFC9 are covered by failing-then-passing tests using the actual `EventStore.hideSession` deletion path and a later conversation-policy change. The shared production predicate excludes hidden chats from new work, assignment and lead eligibility while preserving their history. Item and backlink projections both compute current availability; no stored historical attribution is rewritten. Accepted main #967 is integrated, with its UI changes and manifest hashes preserved.

Accepted main integrations preserve #971 compact settings, #972 Agents design, #979 recoverable tool errors and #964 bounded context compiler. Their source bindings remain intact alongside the S2 bindings; this slice adds no rendered UI or execution enrollment. Final source is based on accepted compiler merge `9fc335d788a4517d17362531e17c17abc51e8987`.
