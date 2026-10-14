# Prompt delivery across reconnect

The first prompt after foregrounding must reach the existing agent without a second prompt. Three independent failures caused this behavior: client queueing based on stale `running`, ignored HTTP failures, and registry rekeying while the SDK query loop retained the old key.

## Contract

- A runtime registry key is stable for the entire SDK query. `ownerConnectionId` identifies the replaceable event connection. Reconnect, send, interrupt, suspend, and disconnect use the connection identity without renaming the runtime.
- `/api/chat/send` accepts an authenticated, schema-validated command even without an SSE stream. `clientMsgId` identifies the whole command, including creation of a new session.
- SQLite stores the complete command and its allocated session UUID before dispatch. A retry with the same payload returns the same receipt; reusing an ID with different content fails. The session UUID is passed to SDK startup and registered before asynchronous boot work, so rapid follow-ups find the same input queue.
- HTTP 202 acknowledges durable acceptance, not completion of model execution. Startup failures are persisted and replayed. After a server restart, commands without evidence of delivery are surfaced as interrupted; they are not automatically re-executed across an ambiguous crash boundary.
- The client outbox submits in order, independently of SSE readiness and agent running state. Network errors, 429, 5xx, missing acknowledgements, and 15-second request/body timeouts trigger retries with the same ID, backing off to ten seconds. Definitive rejections are shown in the UI.
- A current stream welcome or matching liveness nonce supersedes offline retry backoff. The outbox retries the unchanged command immediately, without overlapping an in-flight request, changing FIFO order, restarting stopped/auth-invalidated delivery, or automatically recovering guarded Local commands. HTTP backpressure, malformed receipts and failed durable handoffs keep their existing retry deadlines: SSE connectivity does not resolve them. Replay readiness remains a separate control-message barrier.
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

## October 14 foreground latency investigation

Read-only Jaeger v3 queries and structured logs from deployed release
`af2c45eadeb9` establish the following timeline (UTC). The affected send trace is
[`b998f0e2fcc3a464375fd0e407405199`](http://localhost:16686/trace/b998f0e2fcc3a464375fd0e407405199).
Raw provider frames, prompts, credentials and transcripts are excluded from this
record.

| Time                | Observation                                                   |
| ------------------- | ------------------------------------------------------------- |
| 07:30:25.370–25.399 | A new SSE stream closes after 29 ms.                          |
| 07:30:27.082        | Its reconnect POST receives `connection_expired`.             |
| 07:30:31.606        | A replacement SSE stream opens.                               |
| 07:30:32.964        | `ws.reconnect` takes 3.28 ms, including session reattachment. |
| 07:30:51.495        | The affected `ws.send` begins.                                |
| 07:30:51.507        | `chat.send` begins and subsequently takes 30,057.69 ms.       |
| 07:31:21.522        | Codex reports a transport timeout with `activeTurn: false`.   |
| 07:31:34.976        | The recovered `codex.turn` begins.                            |
| 07:31:45.335        | The first recorded output message begins.                     |

This distinguishes browser stream churn, command admission, provider transport
recovery and model output. Reattachment itself does not explain the 30-second
wait. In that deployed source, the idle `config/read` preflight in
`admitExplicitSend` inherits the app-server's general 30-second RPC deadline.
The idle transport timeout coincides with the end of that wait. The HTTP outbox's
15-second retry cannot shorten it: the server serializes retries behind the
same command's pending acceptance. Recovery then adds about 13.45 seconds before
the provider turn starts. Existing spans do not break that recovery interval
into individual RPCs, so it must not be attributed wholly to inference or SSH.

Accepted main already contains #926's separate two-second idle deadline,
generation retirement, cancellation cleanup and dispatch/preparation spans.
It was absent from this deployed release. The follow-up extends that existing
idle check to ordinary host Codex transports rather than selecting it solely by
the presence of an OpenShell workspace-recovery callback. Guarded host commands
retain their owning admission fence; enrolled OpenShell keeps its workspace
recovery guard. Terminal owners cannot become legacy recovery owners.

Only idle, ready, unpaused transports are probed. Active/pumping turns are
excluded. A failed read retires the old generation and its timers before new
command persistence; late responses/notifications cannot affect a successor.
Recovery persistence or observer failure refuses admission. Authentication,
account binding, provider thread continuity and uncertain dispatched turns keep
their existing checks. Two seconds bounds the idle health check, not total
network recovery or model response time.

Each allowed app-server request now emits `codex.rpc` with its finite method,
configured deadline, duration, status and bounded failure class. Success,
provider rejection, close and timeout all end their own span. Telemetry excludes
request parameters, responses and raw exception text. Future diagnosis can
distinguish `config/read`, `account/read`, `thread/resume` and `turn/start`
instead of assigning every wait to `chat.send`.

Offline fake-clock regressions cover host/OpenShell retirement, late callbacks,
busy turns, terminal owners, cancelled/persistence-failed probes, matching and
unmatched liveness responses, stalled replay, FIFO retry identity, concurrent
send suppression and authentication loss. The deterministic HTTP integration
fixture verifies lost acknowledgements produce one SDK input after reconnect.
No real model call is required for these contracts.

The reviewed Connections runtime revision advances to `v1.0.119`, with only the
four changed runtime source fingerprints updated. Source fingerprint checks and
provider policy versions remain enforced. Guarded host/OpenShell runtime contract
identities include that reviewed code closure; activation must qualify the
selected source-bound runtime configuration through its existing owning
procedure. No retained private runtime receipt or staging configuration is
rewritten by this source change.

Runtime acceptance remains separate. The canonical staging check refused with
uncertain custodian state both inside and outside Seatbelt. Its retained
owned-custodian topology is also outside the ordinary readiness pipeline's
supported topology; no replacement, drain or enrollment is inferred. Source
acceptance alone does not change the deployed backend or native app bundle.
Production activation requires the user's separate explicit action.
