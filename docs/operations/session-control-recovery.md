# Switch/suspend 404 investigation

On 13 October 2026 an iPhone conversation showed “Could not switch (404)” and
“Could not suspend (404)” while the header remained Reconnecting. Both strings
come from `SseConnection.doPost`, independently of the selected model/provider.
The investigation and fix start from accepted main `a169fa1615f9c04d845d2ecbafe7b2f932ae3e41`.

## Evidence and limits

The exact switch/suspend 404 path is `requireConnection` in
`server/chat-rest-handler.ts`: the POST has a connection ID no longer present in
`ConnectionRegistry`. A missing conversation in `handleSwitchSession` instead
emits a session-scoped error through the stream. The screenshot's switch 404
therefore identifies transport registration, rather than a missing provider thread.
The suspend route also rejects before touching the provider or session state.

Read-only logs from the existing `910b896018ca` runtime show SSE connections
closing and being replaced around 09:12–09:14 Europe/Dublin. Sessions are logged
as “detached (surviving)”; later reconnects take over and resume a suspended
session. This supports the stream-lifecycle explanation. These historical logs
lack the failed POST status/connection correlation, so they do not establish the
exact network reason for each close or uniquely identify the screenshot's chat.
The new rejection log records operation, connection ID and reason, without
prompt content or credentials.

The native transport default changed to SSE in `039d2755` late on October 12.
That made the SSE control path normal iPhone behavior; the deployed server logs
are from the following accepted release. The phone's exact installed bundle was
not independently captured. Reverting the default would leave the faulty SSE
failure boundary in place.

## Five orders of effects

| Order | Failure                                                                                        | Consequence                                                                                                         | Repair or check                                                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Server closes the stream and removes its connection while the phone still has the ID.          | Switch/suspend POST gets 404 before its session handler runs.                                                       | Explicit `connection_expired` response and structured log; bounded client recovery.                                                                                                                                                 |
| 2     | Client translates every HTTP control failure into the generic provider `error` event.          | Parser/reducer sets running false and drops `current`, despite a surviving server turn.                             | Local control failure uses the existing error banner; transient expiry triggers reconnect. Streaming state stays intact.                                                                                                            |
| 3     | Lost switch request is not restored merely by replaying messages.                              | Active view, permission-mode hydration and server active-session tracking can diverge or remain gated.              | Retain only the latest switch intent and issue it after welcome/replay readiness. Preserve transcript cursor.                                                                                                                       |
| 4     | HTTP requests finish after navigation or stream replacement; suspend belongs to the old owner. | Old failures affect a newer view; replaying suspend would suspend a resumed session.                                | Fence transient results to connection, stream, navigation scope and switch intent. Never replay suspend. Background recovery waits for foreground.                                                                                  |
| 5     | A broad retry rule also repeats decisions/cancellations, or mistakes every 404 for expiry.     | Repeated actions, misleading cancellation receipts, approval snapshot rollback or endless retry of a missing route. | Never automatically repeat submitted stop/interrupt/close/permission requests. Preserve exact rejection identity; retain auth ownership checks; distinguish unrelated 404s. Prompt delivery keeps its existing acknowledged outbox. |

## Repair contract

Control POSTs have a ten-second bound covering response headers and any required
JSON body consumption. A stalled error response or snapshot-ACK body remains
inside the same deadline and abort signal. Expired transport or network failure
replaces the current stream after the existing reconnect delay. A hidden page
waits for foreground. The latest selected chat is rehydrated after replay
readiness; no provider start/send is part of that operation. Explicit navigation,
logout and disconnect clear the old switch intent. Legacy servers are supported
only for the two exact historical expired-connection response texts, not arbitrary
404s. Unrelated HTTP failures remain visible without claiming the provider ended.

Automatic selection hydration drops `historyCursor` only for sessions included
in the exact completed reconnect request. Reconnect owns their cursor and pending
snapshot offer; resetting it before the delayed transcript ACK would invalidate
the offer and repeat recovery. Navigation during that request can select a new
chat outside its captured session set. Its queued switch retains the installed
REST cursor so durable retry delivers events created between that read and the
new watch. Tests exercise both actual snapshot ACK preservation and delivery of
that transcript tail with a deliberately delayed reconnect response. A foreground first-prompt assignment updates the recovery
selection, replacing the previous blank-chat intent. Correlated assignments
from an offscreen draft do not change the foreground selection. A confirmed
HTTP assignment releases the assignment wait even if the streaming `session_id`
event was lost; controls still wait for authoritative permission-mode hydration.

Destructive controls and permission decisions retain their nonterminal rejection
feedback and require deliberate retry. A lost cancellation response never
fabricates a correlated receipt. Delayed permission failures from a superseded
transport cannot replace the newer authoritative permission state.

Integration with accepted PR #911 preserves authenticated keepalive suspension.
Suspend failures remain quiet, do not consume rejected response bodies, and never
force a stream replacement; the foreground probe/reconnect owns recovery. Its
regressions caught conflicting behavior during integration before the combined fix.

The changes leave server detach/suspend/reattach ownership, provider thread
recovery, durable transcript storage and prompt idempotency intact. Reconnect
continues using the client's applied cursor. A local transient error no longer
pretends that the server has ended the turn. Genuine provider errors continue
through their existing error path.

## Validation and activation

Offline regressions first reproduced terminal switch/suspend errors, obsolete
response delivery, absent selected-chat rehydration, an indefinitely stalled POST
and an unnecessary background reconnect. Tests cover the repaired behavior,
legacy and unrelated 404s, stalled JSON bodies, new-chat background/resume,
actual server snapshot offers with deliberately delayed ACKs, no automatic
cancellation/permission replay,
preserved streamed content, authentication ownership and original transport
cleanup. All provider calls are mocked; no live model test was made.

Focused client/protocol/connection tests, server route/ownership tests and the
static UI design contract run with one worker and a 1 GiB Node heap. Shared
client/protocol TypeScript compilation and changed-file lint/format checks are
included. Broad build/test acceptance belongs to CI. No rendered markup, palette,
tokens or layout changes; feedback reuses `ChatArea`'s existing error banner.

Canonical staging is independently fenced. At the initial investigation its check
refused. Read-only registry
inspection found the owned launch in `retirement_uncertain`, with controller
generation 1 and source `9e301092e418307f772758e8bcab12db8dff65e5`; the installed
router delegates check/drain to that original source. This is an ownership
incident, not a stale ordinary release. The host resource report independently
refuses admission for memory pressure and disk headroom: pressure level 2,
7,007.5 MiB swap and 18.75 GiB free disk (limits: normal pressure, at most
2,048 MiB swap and at least 20 GiB disk). This later observation could explain
slow probes, but has not been correlated to the screenshot's precise failures. No lock, registry, process,
provider configuration or retained evidence was changed by this task. Recheck the
canonical operating state before live acceptance. Do not force a restart,
delete the uncertainty, create another stage or use production as a test fallback.

After source acceptance and separately reviewed staging recovery, verify on the
canonical instance: open a running chat, background/resume, navigate during a
delayed switch, and confirm latest-chat selection, uninterrupted transcript,
permissions and mode hydration. If provider-backed acceptance is enrolled, select
supported Luna explicitly and announce the exact model and charged account.
Updated iOS bundle adoption and production activation remain separate explicit
steps. This investigation does not claim an on-device deployed fix.
