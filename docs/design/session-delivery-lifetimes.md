# Session delivery lifetimes

Chat selection, command delivery, transport receipt and transcript rendering have
different owners. A durable sequence cursor is evidence of consumed delivery; it
must never grant a subscription or select a chat.

## Ownership and dataflow

The client store owns explicit session-interest lifetimes for the selected view,
unresolved command receipts and correlated provisional local startup observations.
Each lifetime has a subscription ID. The transports use that owner to build replay
and suspend requests; their cursor maps are only delivery bookkeeping.

1. A reconnect captures interested session IDs, subscription IDs and their cursors.
2. The server independently checks access, subscribes those sessions, and offers
   an exact durable cursor plus an opaque snapshot offer. It echoes the captured
   subscription ID. The ID correlates a lifetime; it grants no server authority.
3. The client rejects retired or mismatched lifetime offers before buffering or
   starting a transcript read. A retained background receipt may read its prefix;
   a selected chat uses foreground recovery. Historical output cannot select a chat.
4. Recovery work is fenced by connection, session lifetime, latest read and exact
   offer. There is one cancellable background read per interested session. Replacing
   an offer or retiring interest aborts the prior read. Late success/failure does
   not commit, acknowledge, re-enroll a chat or restart another chat's transport.
5. Exact snapshot acknowledgement releases its suffix. Applying a stream event
   can synchronously retire its owner; that delivery lifetime is rechecked before
   advancing or acknowledging a cursor.

Capable clients declare `clientManagedWatches` on selection changes. The server
then changes the foreground without implicitly removing other owned watches.
The store explicitly unwatches when the last interest retires. Legacy clients
retain their existing implicit-unwatch behavior. SSE selection, watch, unwatch
and reconnect requests are serialized per connection, so reselecting a chat after
an in-flight unwatch leaves its new watch installed last. Queued work cannot be
retargeted to a successor connection. Retirement is connection-owned control work,
independent of navigation's disposable send queue. A failed retirement replaces
that connection and replays only current interests; queued delivery is never
treated as confirmation. Completed retirement deduplication is bounded; in-flight
retirements retain exact identities so old completion cannot suppress a successor.
Ordinary ACKs also require the captured subscription
generation before dispatch and failure handling.

A pending exact snapshot remains the recovery authority if its chat is revisited.
The full REST restore can record rendered coverage, but its selection cannot
reset the server cursor and invalidate that offer. The bounded prefix restore and
exact ACK still release the buffered suffix. Both transports also strip a queued
REST cursor for sessions captured by the preceding reconnect, before its offer
arrives locally; WebSocket control ordering follows the server's FIFO handler.

Subscription IDs are echoed by updated servers. Older servers and clients retain
the existing optional-field compatibility path; they do not gain the stronger
cross-lifetime correlation of an updated client/server pair.

## Effects through five orders

| Order  | Failure before ownership correction                                        | Required invariant                                                              |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| First  | Offscreen view filtering reports failed application and reconnects.        | Deliberately filtered owned events are consumed without rendering.              |
| Second | Every foreign recovery offer reloads a transcript.                         | Retired offers perform no transcript work.                                      |
| Third  | A late read recreates a cursor and subscription after navigation.          | Only application intent creates interest; callbacks require its exact lifetime. |
| Fourth | Recreated subscriptions increase future replay, ACK and history work.      | Replay/suspend enumerate current interest, independently of received cursors.   |
| Fifth  | Repeated recovery competes with normal delivery and creates more timeouts. | Retired work is cancelled and cannot restart a healthy successor lifetime.      |

The regression suite covers five navigation/reconnect cycles, retirement during
read success/failure, pending receipt retention, reselecting during unwatch,
old offers after reselection, and retirement during event application. Existing
startup tests cover receipt/snapshot ordering, replaced offers, delayed ACKs,
late history and cancellation. A registry-backed offline fixture asserts actual
server watch and offer removal after delayed replay/navigation and HTTP failure,
and preserves a pending background offer through reselection. Server tests preserve pending offers across
client-managed selection and verify explicit unwatch retirement.

## Remaining resource boundaries

This change bounds retained recovery work by actual interested sessions. It does
not make complete transcript reconstruction byte-bounded or remove every global
resync for a failure in a still-owned session. Future recovery work should add
byte-bounded/paged projections, cross-session admission limits and per-session
retry/backoff, rather than weakening exact acknowledgement or receipt authority.

The separate history-tool optimization checks authorization around a synchronous,
unpublished bounded-row batch, every await and final output. Its 32 KiB output cap
is not an input-byte or CPU-time bound. Message-level history projection and input
bounds remain useful follow-ups; no real-model or production performance claim is
made by offline assertion-count tests.
