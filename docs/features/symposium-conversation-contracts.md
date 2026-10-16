# Symposium conversation contracts — slice 2

The fresh-agent flow approved on 16 October 2026 starts with ordinary chat.
Add agent prepares another ordinary session with its own account, provider history,
workspace and execution owner. Existing-chat import and cross-group enrollment are
deferred. Fork is a separate follow-on using the same pinned-source concepts.
Neither operation creates a Telos item or implicitly copies Work membership.

Source audit: PR943 was merged as `91b9defa`; this slice starts from accepted main
`e978f978`, reconciled with accepted tool-library sources at `95afd5fe` and current main `6f57b89a`. Its association journal and EventStore connection remain the owners.
The older open/conflicted PR checkpoint is historical. Existing output-contributor
coordinator/child allocation is not the allocator for this flow.

## Implemented boundary

`CollaborationConversationStore` belongs to EventStore. Its append-only records,
request receipts and projection journal live in the same database and participate
in the existing backup/watermark. No account store, runtime registry, coordinator
provider session, queue or scheduler is introduced.

Per-participant policy has an independent revision and expected membership revision.
Its journal event at sequence N takes effect at N+1. Both controls initially default
off; addressed agents necessarily read their own exchange. Re-addition persists a
new policy revision with both controls off and a new effective boundary. The
aggregate policy sequence advances for policy and membership changes. Existing membership edits
append projection events in their original transaction; exact retries append none.

Host-side message acceptance resolves stable session IDs from current membership,
never aliases or raw `@` text. Default, selected and all responders are explicit.
No responders, unknown IDs, removed members and unavailable recipients are refusals;
none falls back to a broadcast. Acceptance freezes membership/policy revisions,
responders, readers, selected snapshot and each recipient's ordinary admitted
account/target/workspace/model/thinking/agent/context/permission selection.
Legacy sessions without a guarded ordinary selection remain unavailable here.

Messages, projection entries, deliveries and ordinary commands have distinct IDs.
Readers get context intents; only responders get reply intents. Reading never
creates another turn. Attributed reply contracts retain original ordinary
conversation/command/message/block/event references and the originating delivery.
Capturing those replies from drivers remains slice 3 work; session activity alone
does not establish group provenance.

Each delivery has revisioned outcomes. Queued/uncertain work retains its command ID;
terminal results cannot be reset to pending. A failed recipient does not change a
successful recipient. Request IDs are scoped to the collaboration across mutation
kinds. A canonical fingerprint and original result commit atomically, so an exact
retry after later changes or restart returns its original result; conflicting reuse
is refused. These receipts do not claim exactly-once external tool execution.

## Reviewed context

The trusted source compiler supplies a bounded snapshot with source discussion ID,
explicit boundary, selected messages, authors, block IDs/content/hashes and exact
artifact IDs/revisions/hashes. Shared projections can also retain each message's
original ordinary source reference. Block hashes are recomputed; the whole review
object has an immutable digest verified on reads and confirmation. Subsequent source
edits cannot alter the accepted object. Empty selected content means brief only.
Standard boot, agent guidance and repository instructions have separate owners.

Snapshots permit at most 500 messages, 100 artifacts and 512 KiB of serialized
review content. An overflow refuses the operation; nothing is silently truncated.
Capacity can be unverified, refused, require a reviewed summary, or carry trusted
token estimates bound to every exact execution selection that will consume it.
An unverified or mismatched assessment cannot confirm a join or message.
A summary is a new review object with attribution and the exact original snapshot
digest and source pins. It never replaces the original evidence in place.
An artifact pin establishes a version reference, not retained bytes or read access.

The source compiler/access adapter and token estimator are deliberately not wired.
`saveSnapshot` is a host-only port; HTTP callers cannot supply source bytes,
capacity claims or receipt outcomes. Slice 3 must authorize visible source material,
prove complete Conversation so far selection at the boundary, check exact artifact
access and measure adapter overhead before enabling review or delivery.

## Fresh allocation and recovery

The first Add agent can begin from a single ordinary source through the host-only
`begin` port. It creates relationship metadata and a keyed receipt, with no second
session. It refuses an already-enrolled source; the older public association API
retains its two-session creation minimum and broader historical semantics.

`prepareJoin` freezes name, ordinary configuration, reviewed snapshot digest and a
stable allocation operation ID. Its state is `pending_preparation`, with
`sessionId: null`. Setup and review do not call an allocator or model.

The guarded ordinary route in `server/ordinary-local-codex-entry.ts` derives the
real conversation ID with `nativeStartupSessionId(clientMsgId)` before repository
reservation. The existing drivers then use `EventStore.admitOrdinaryCommand`
through their Local/OpenShell adapters. The session/runtime binding and first
`send_commands` admission commit together, before provider dispatch. Provider thread
identity is a later, separate fact. Legacy WS sends have their own send-receipt
boundary and must not be substituted for a guarded runtime route.

This slice verifies allocation against that first ordinary ledger entry, using the
prepared operation ID as the ordinary command ID and comparing exact settings.
Caller-selected session IDs, continuation receipts and previously associated sessions
cannot serve as fresh-allocation proof. The real receipt commits as `allocated`
before membership linking. If linking conflicts or the process restarts, recovery
reuses that ID and requires the current membership revision; it never reallocates.
Linking rechecks recorded availability/settings and refuses cross-group enrollment.

Slice 3 must compose the ordinary preparation/admission boundary so linking and
reviewed context delivery precede provider dispatch. Calling today's first-command
HTTP route during setup would dispatch work and is not an implementation of joining.
An uncertain allocator outcome must be reconciled through the original ordinary
operation ID, never retried with a new ID. No allocator is invoked by this slice.

## Authenticated API and client

All routes below are under `/api/session-collaborations/:id`, behind interactive
operator authorization. Writes retain same-origin JSON protection; responses are
private/no-store. Internal agent tokens do not grant operator authority.

| Route                                    | Current behavior                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /conversation`                      | Bounded state, policies, latest 50 messages, pending joins, availability and explicit disabled execution reason. |
| `PUT /policy`                            | Revisioned policy edit with keyed exact retry receipt.                                                           |
| `GET /events?after=N`                    | At most 50 ordered events, applied cursor, high watermark and `hasMore`. A future cursor conflicts.              |
| `GET /snapshots/:snapshotId`             | Read an existing immutable host-compiled review object.                                                          |
| `GET /joins/:joinId`                     | Read existing pending/allocated/linked preparation evidence.                                                     |
| `POST /snapshots`, `/joins`, `/messages` | Explicit `503 execution_unavailable`; no mutation, allocation, source read or model call.                        |

`MitzoApiClient.collaborations` validates request/response schemas and preserves
typed conflicts/unavailability. Its separate projection handles exact duplicate
replay, membership changes, partial outcomes and join states. Gaps, conflicting
identities and unknown receipt references require a fresh view. Projection events
never enter ordinary send/queue actions. Transport subscription and rendered web/iOS
controls remain later work; the ordinary composer is unchanged.

## Acceptance still outstanding

Focused offline tests cover protocol/storage/backup, two-connection conflicts,
frozen snapshots, capacity refusal/summary review, first-chat preparation, actual
ordinary-ledger allocation proof, link recovery, authenticated Express/client
composition and replay. They make no real model calls and prove no live route.

Keep Symposium `c0851ba23fcc5d04`, Work/artifacts `4f55b423d0731750` and their existing
eight milestones. No tracker mutation or duplicate hierarchy accompanies this slice.
Application wiring, fresh preparation/delivery adapters, source/access compilation,
queue/lifecycle parity, fork delivery, retention and complete qualification remain
outstanding. Qualify every actual configured account on both Mac host and OpenShell,
including same-account independent agents. Unsupported and untested cells stay open.

Canonical staging and its pipeline were stood down on 15 October: no checks,
enqueue, recovery, restart, recreation or deployment. Preserve retained records.
Live work requires a separately authorized target. Real-model tests explicitly
select supported Luna and announce exact model and charged account; another model
requires approval. Production activation is separate. Eventual source merge still
requires current-head CI and exact-head Centaur final LGTM/merge recommendation.
