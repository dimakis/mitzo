# Symposium ordinary contributor entry points

This map describes the bounded ordinary contributor service and the remaining
regular-account cutover. Start with [the source guide](symposium.md) and existing
Telos outcome `c0851ba23fcc5d04`. A source change or an offline fixture is not live
runtime acceptance. Do not restart the dedicated native setup programme to fill
ordinary adapter gaps.

## Existing-session association owner

`server/session-collaboration-router.ts` is mounted at `/api/session-collaborations`
behind the existing interactive operator authentication. Internal agent tokens do
not authorize membership edits. JSON writes retain the shared same-origin check.

| Operation                       | Contract                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /:id`                      | A caller-generated UUID identifies the association. Supply `expectedRevision: 0` and at least two distinct existing ordinary session IDs to create it; later edits supply the current revision. Maximum 16 participants. Exact last retries return the same revision, concurrent changes return 409. |
| `GET /:id`                      | Returns the current membership plus `unavailableParticipantSessionIds`. This is metadata availability, not account readiness, context sharing or permission to execute.                                                                                                                              |
| `GET /?sessionId=...&after=...` | Rediscovers current groups for a visible ordinary participant, ordered by collaboration ID, with pages of 50 and an optional `nextCursor`. Removed membership is absent. Each selected group can then be read for current availability.                                                              |

`SessionCollaborationStore` owns an append-only revision journal on the EventStore's
existing SQLite connection. Membership validates inside the same immediate
transaction as its revision check. There is no coordinator conversation, parent
chat foreign key or new runtime/account registry. The relationship survives
participant unavailability; explicit removal changes only association metadata.
Exact last retries remain readable after a participant becomes unavailable.
Edits can retain unavailable references while changing other members; availability
is checked only for newly added participants, including re-adding a removed one.
Reads do not allocate anything, and stored corruption fails closed.

This slice supports the shared boundary between Telos `c0851ba23fcc5d04` and
`4f55b423d0731750`: collaboration identity groups sessions; durable work identity and
session-to-work associations remain independently owned. It adds no implicit work
association, dispatch authority or legacy migration. The ordinary execution and
unified chat UI cutover below remain required.

## Accepted owners reused by the bounded service

The approved fresh-agent successor uses the [slice 2 conversation contracts](symposium-conversation-contracts.md).
Its host-only first-chat preparation records one ordinary source, pending joins and
the exact allocation operation; it does not use the older coordinator/child allocator
below. Policies and projection reads are wired under the association resource.
Public source review, Add agent and send remain explicitly disabled pending ordinary
driver composition. Existing-chat import is deferred; broader association semantics
do not authorize exposing an import flow.

| Operation              | Owner and boundary                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Account discovery      | `server/app.ts` composes `OutputContributors` with `loadAccountProfiles`; `list` validates existing account profiles and ordinary route compatibility. No separate contributor account store.                                                                                                    |
| Exact work selection   | `/api/sessions/:id/outputs` uses `SessionOutputReferences` and the EventStore-owned `SessionOutputReferenceStore`. A finalized transcript reference carries source message/block/end sequence/hash. It is not independently retained content.                                                    |
| Contributor creation   | `/api/sessions/:id/contributors` is mounted behind interactive operator authentication. `OutputContributors.add` resolves optional Library guidance and the selected ordinary account/model before allocation.                                                                                   |
| Atomic identity        | `EventStore.createSymposiumSession` owns one immediate transaction for coordinator configuration, request fingerprint/allocation receipt and output association. Different requests can create independent contributors to the same exact output; exact retries return the original coordinator. |
| Guidance and authority | Existing `SymposiumHostGrants` validates the output/context digest and each coordinator's own membership. A saved profile supplies guidance, not account credentials or a grant. Recipe-bearing and isolated-reviewer profiles remain unsupported.                                               |
| Directed execution     | `SymposiumSharedSeatExecutor` and `createOrdinarySymposiumTurn` call the ordinary `startChat` port with an independently generated child ID. Follow-up uses that contributor's retained child. Each delivery rechecks account, context, membership and exact dispatch authority.                 |
| Provider acceptance    | `ordinaryTurnLifecycle` observes exact command acceptance and terminal receipts through the existing Codex route. Responses/native retained sandboxes are not substitutes for this bounded adapter.                                                                                              |
| Attribution and replay | Existing coordinator delivery/attempt records retain the exact account/model and child identity. Request IDs are scoped to each coordinator; identical local request IDs cannot merge two contributors' histories.                                                                               |
| Stop and uncertainty   | `/contributors/:contributorId/stop` cancels or reconciles that contributor's existing delivery IDs. An uncertain terminal remains fenced on its original coordinator; it does not relabel cleanup or fence another independently admitted contributor.                                           |

The association lookup still repeats the EventStore owner's parent authority
check after exact source/digest validation inside the same transaction. Removing
the one-contributor restriction changes membership cardinality, not credential,
filesystem, runtime-capacity or lifecycle authority. The existing per-child
ordinary admission remains mandatory. No account migration or native retirement
is performed.

## Remaining product cutover

Ordinary `ChatView` and `DesktopChatView` intentionally neither mount an Outputs
panel nor fetch its state automatically. Preserve that approved quiet-chat design.
`OrdinaryCollaborationEntry` opens the existing `OutputContributorPanel` and
`useOutputContributors` on an explicit Collaborate action in Workspace. Its shared
host remains above responsive screens; closing or changing conversation stops
reads, and the parent transcript remains unchanged. New invitations from this
ordinary action use the existing eligible account catalog and output service,
without entering dedicated native setup. Runtime-bound ordinary conversations
remain unavailable here until their contributor adapter is qualified.

Retained `AddAgentSheet`, `NewSymposium` and Director configuration still use
the dedicated Symposium catalog/configuration path. Personal/subscription login
components call `/api/symposium/personal/*`; native creation is mounted at
`/api/symposium/sessions`. Those paths are not replaced by API contributor
eligibility. Do not claim that separate sign-in or new native admission is retired.

The ordinary runtime selection owners already distinguish Agent, Account, Model,
Thinking and Run on, derive the harness and retain immutable driver/target/workspace
bindings. The bounded contributor request does not yet carry that complete
runtime selection or enter the new owned Local/OpenShell command drivers.
Local Responses, Local Codex, Claude SDK and Gemini/Vertex contributor parity
require explicit adapters and unavailable-choice behavior; ordinary chat support
alone is not proof of contributor support.

Before disabling new legacy allocations, qualify the replacement's explicit
entry, standard catalog/driver composition, same-account independent identities,
follow-up/replay and exact Stop. Audit creation/configuration, internal, bootstrap
and recovery callers. Preserve authenticated legacy read/export/history and exact
Stop/reconciliation until original custody is settled. A feature flag does not
complete retirement, and an ordinary successor must not inherit native credentials
or historical attribution.

## Evidence still required

Offline tests cover same-account independent allocation, directed child history,
idempotent retry, atomic persistence/backup, real Express composition with mocked
providers and uncertainty isolated to the original contributor. These tests make
no model calls and do not grant runtime capacity or provider enrollment.

Canonical staging and its pipeline were stood down on 15 October. Do not check,
enqueue, recover, restart, recreate or deploy them. Retained incident and ownership
records are historical evidence to preserve. Live qualification requires a separately
selected authorized target; no production fallback is permitted.
Live qualification must explicitly use a supported Luna model and announce its
exact charged account before calling it. Production activation is separate.
