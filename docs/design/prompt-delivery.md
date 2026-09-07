# Prompt delivery across reconnect

The first prompt after foregrounding must reach the existing agent without a second prompt. Three independent failures caused this behavior: client queueing based on stale `running`, ignored HTTP failures, and registry rekeying while the SDK query loop retained the old key.

## Contract

- A runtime registry key is stable for the entire SDK query. `ownerConnectionId` identifies the replaceable event connection. Reconnect, send, interrupt, suspend, and disconnect use the connection identity without renaming the runtime.
- `/api/chat/send` accepts an authenticated, schema-validated command even without an SSE stream. `clientMsgId` identifies the whole command, including creation of a new session.
- SQLite stores the complete command and its allocated session UUID before dispatch. A retry with the same payload returns the same receipt; reusing an ID with different content fails. The session UUID is passed to SDK startup and registered before asynchronous boot work, so rapid follow-ups find the same input queue.
- HTTP 202 acknowledges durable acceptance, not completion of model execution. Startup failures are persisted and replayed. After a server restart, commands without evidence of delivery are surfaced as interrupted; they are not automatically re-executed across an ambiguous crash boundary.
- The client outbox submits in order, independently of SSE readiness and agent running state. Network errors, 429, 5xx, missing acknowledgements, and 15-second request/body timeouts trigger retries with the same ID, backing off to ten seconds. Definitive rejections are shown in the UI.
- Unacknowledged prompts survive page reload in per-tab session storage when available. Storage failure preserves in-memory retries. Switching conversations does not discard accepted user intent. Only unattempted follow-ups from the same draft inherit a newly acknowledged session ID.
- SSE replay remains separately acknowledged, with a 15-second timeout. Any tracked session is replayed on welcome, including a command accepted before the first stream exists. Foregrounding rebuilds the stream rather than trusting a stale connected flag. Replaced streams cannot deliver late callbacks.

This is one durable command dispatch per message ID, not a claim of exactly-once external tool side effects. Server crashes interrupt live model execution; recovery reports uncertainty instead of repeating possible side effects.

## Salvaged work

PR #445 supplies the removal of `wasRunning`, `pendingSend`, its five-second timer, and parser-side queue draining, with the corresponding tests. Unrelated changes in that branch are excluded.

PR #440 correctly identifies reconnect ownership churn as redundant. This fix removes runtime rekeying while retaining transport reattachment, permission/suspend recovery, cursor replay, and periodic event sync. Removing those mechanisms wholesale is not necessary to fix prompt delivery and would widen the validation surface.

## Regression evidence

`reconnect-delivery.integration.test.ts` connects the actual HTTP router, durable EventStore, SseConnection/outbox, SessionRegistry, and query loop to a deterministic SDK stream. It creates a session, suspends it, reconnects, submits one prompt, loses its HTTP acknowledgement, and verifies automatic retry produces exactly one additional SDK input and a response on the new stream, with no runtime-key change.

Additional tests cover receipt deduplication, changed-payload rejection, native commands, restart interruption, SDK pre-registration, rapid follow-ups, offline acceptance, reload recovery, response-body stalls, reconnect timeouts, and stale callbacks.

## Review follow-up

The first Centaur review identified two client correctness bugs and an unhandled
interrupt startup rejection. Replay requests are now serialized per EventSource
and connection ID. A receipt adding a session during replay schedules one later
replay with the updated session set; readiness is emitted after that replay.
Receipts for sessions already tracked do not trigger redundant replays. Navigation
clears the previous conversation's delivery banner. Interrupt resume reports
startup rejection through the transport, like normal send startup.

The response parsing concern also exposed a real distinction: a non-retryable
HTTP rejection with an HTML body must fail visibly and release the next queued
command. A malformed successful response remains ambiguous and is retried with
the same command ID, because the server may already have executed it.

Other review suggestions were intentionally not adopted:

- Navigation preserves submitted prompts. Clearing them would silently lose
  acknowledged user intent. Draft scopes prevent cross-conversation reassignment.
- Receipts require an explicit session ID or null. Missing session identity is
  not equivalent to a successful native command and must not discard the outbox
  entry. Persistent malformed responses keep delivery pending, visibly, rather
  than claiming success or inviting a duplicate command.
- Stopping delivery pauses new sends while allowing the bounded in-flight
  request to settle. A valid receipt is saved immediately, even while stopped.
  An unresolved request remains eligible for a deduplicated retry on restart.
- Browser foreground recovery probes the existing stream with a nonce delivered
  over SSE. A matching reply preserves the stream and resumes/replays suspended
  sessions. Missing replies rebuild the stream after one second. HTTP success
  alone never proves SSE liveness. Native force-reconnect and bfcache recovery
  remain available; prompt delivery never waits for the probe.
- The post-dispatch receipt read remains: legacy handlers report some synchronous
  failures through transport events rather than throwing. The durable failure
  check prevents those paths from returning a successful receipt. Replacing the
  handler result contract is separate work, not a cosmetic simplification.

## Second review and integration with #456

Startup metadata now enters the durable event log through the HTTP command
transport even without a stream. Already sequenced query events are not appended
again, and user-message echoes carry the sequence of their original append.
Delivery status is separate from delivery errors. Tests cover stopped
acknowledgements, 429/5xx retries, invalid receipt identities, pending retry status,
queue capacity, startup persistence, and healthy/dead foreground probes.

Merge #455 before integrating #456's provider lifecycle. #456 is stacked on #453;
#453 must land before #456, but neither is required by #455. A merge simulation
against #456 at e4322eb found conflicts in server/chat.ts,
server/ws-handler-v2.ts and frontend/src/styles/global.css. Reconcile those in
the provider stack after this transport change, preserving initialSessionId,
clientMsgId, the stable runtime registry key and account/provider selection.
In particular, the transport receipt must identify the same session as the
Codex conversation and its durable queue. Repeat lost-acknowledgement and
foreground/reconnect tests through the provider queue to prove a retry creates
one queue entry and executes one turn. Do not infer compatibility from a clean
textual merge or activate the development-gated provider as part of this fix.
