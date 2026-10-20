# Ordinary conversation preparation and retained forwarding

This source contract extends the existing Symposium owners. It does not establish
native capacity, permission to send, or a configured runtime. The independent
requirements and acceptance map remains
[the integration acceptance workstream](https://github.com/dimakis/mitzo/pull/1022),
which owns `docs/evidence/symposium-integration-acceptance.md`.

## Begin Add agent

Authenticated same-origin `POST /api/session-collaborations/:id/begin` accepts the
existing `CollaborationBeginSchema`: `{ requestId, sessionId }`. It delegates to
`EventStore.collaborationConversation.begin`. The immutable receipt contains
revision 1 and only that existing ordinary source session. Exact retries recover
the same receipt before mutable source availability checks, including after
restart. Competing group identities use the existing enrollment transaction.

This retains relationship metadata only. It allocates no agent session, invokes
no review owner and starts no turn. The typed client rejects another group,
additional participants, later revisions and caller-supplied authority. Actual
review, joining and ordinary commands retain their separate owners.

## Retained forwarding storage

`packages/protocol/src/collaboration-forward.ts` owns the exact selection shared
by source preparation and storage. The server producer re-exports that schema
and uses its normalized selection fingerprint. A fingerprint is an identity
check, not access authorization or a native request capability.

The following methods belong to the existing collaboration conversation store:

| Method                       | Retained effect                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `reserveForwardPreparation`  | Bind the original operator, exact selection, note and current recipient settings before asynchronous source reads.           |
| `getForwardPreparation`      | Observe the original private operator/request record for retry recovery.                                                     |
| `completeForwardPreparation` | Retain the exact serialized packet and digest after a required synchronous host fence in the existing immediate transaction. |
| `confirmForward`             | Once only, create an operator context message and independent pending context receipts for the explicit recipients.          |
| `readForward`                | Return the redacted preparation identity, immutable confirmation and current independent delivery outcomes.                  |
| `getForwardPacket`           | Resolve private exact bytes for a future ordinary input adapter; it grants no access or permission to send.                  |

These use existing collaboration records, request receipts and events. No new
queue, account store, session registry or uncertainty ledger is introduced.
Only `requestReply: false` is supported. Confirmation creates no reply-origin
delivery and invokes no model. Public read shapes omit packet bytes and private
operator/preparation fields. The storage read methods require the host caller's
current access checks before any future HTTP exposure.

The original literal packet is hashed before parsing. The JSON must match the
producer's canonical encoding, exact selected pins, complete blocks and decoded
artifact bytes. The packet plus UTF-8 note is bounded at 512 KiB; the next byte
refuses. Current recipient membership/settings and the synchronous host fence
are checked before writes. Missing, asynchronous, value-returning or reentrant
fences refuse; rollback preserves the original pending identity. Exact confirmed
retries return the original receipt, while reads expose later delivery outcomes.

## Delivery remains unavailable

There is no public prepare/confirm/read forwarding route in this source change.
The ordinary delivery adapter explicitly refuses messages containing a forward
reference before staging. It cannot deliver only the note and then acknowledge
the omitted selected content. Legacy ordinary discussion/reply delivery and its
context ACK/error precedence are preserved.

A future adapter must bind the actual confirmation/message/delivery identities,
include every selected block and supported artifact's exact decoded text, preserve
real filenames/versions, and renew original source/item/access/settings authority
at the existing ordinary dispatch fences. Opaque `application/octet-stream`
metadata does not establish model input support. Unsupported artifacts/media,
missing synchronous authority and unresolved native capacity must remain
unavailable. Retained custody alone does not order host revocation with native
consumption and cannot establish a one-use send permit.

## Bounded offline evidence

The combined source/producer/storage/delivery-refusal and begin/client checks pass
177 tests in ten files, with zero skips, one worker and a 1 GiB heap. This includes
the original producer assertions. The new owner tests first reproduced missing
APIs, reentrant writes, unsupported recipient keys, note-only delivery and invalid
begin receipts. A scoped source TypeScript check reports zero diagnostics.
These results overlap earlier producer/owner runs and must not be added together.
Full actual application joining, web/iOS acceptance, current-head CI and the
required Centaur reviews remain separate acceptance gates.
