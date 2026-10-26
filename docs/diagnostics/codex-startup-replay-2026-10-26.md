# Codex startup replay stalls

## Incident evidence

Read-only inspection of the existing server logs and durable event timestamps
matched the reported OpenShell chat's tool sequence. The configured release was
`7d36d4c8dd56`, which includes the earlier immediate durable-prefix delivery fix
from #1125. No runtime, account, sandbox or deployment was changed.

On 26 October 2026 (UTC), the prompt echo was stored at 00:02:49.816. A reconnect
at 00:02:53.218 retained the client cursor at that echo. Initial send returned at
00:02:59.440 after 10.654 seconds. The server persisted 37 text deltas between
00:03:01.483 and 00:03:02.769, and eight tool results between 00:03:03.993 and
00:03:20.172. At 00:03:23.299 the client reconnected again with the same old cursor.
The thirty-second interval matches the client's unapplied-snapshot timeout.
These records establish progressive server output and delayed client application;
they do not capture the phone's exact receive or render times.

## Reproduced startup race

The shared client defers correlated Local/OpenShell output while a first-command
HTTP receipt is pending. It also deferred `session_reconnect_snapshot`, even
though the transport had already installed that snapshot's delivery fence. The
later send receipt could select the chat and restore ordinary history, but that
restore could not acknowledge the exact outstanding snapshot offer. Live output
then waited for snapshot timeout and another reconnect.

The client now reads the bounded snapshot transcript and acknowledges its exact
offer through the existing background delivery path. This does not select the
chat, render its deferred content, or accept the pending native command. Those
remain owned by the command receipt. Failed reads retain the existing recovery
path; transport identity and offer matching still reject stale acknowledgements.

This is a reproduced cause of the reported symptom, not a claim of device-side
acceptance or a measured reduction in provider startup time. The existing
10.654-second startup work is separate from the subsequent output delivery stall.

## Offline verification

The regression uses the real store, SSE connection and applied-delivery ordering,
with mocked HTTP and EventSource. It exercises both `local` and `openshell`, a
correlated early echo, reconnect during pending send, a delayed transcript read,
exact offer acknowledgement, unchanged draft authority and immediate text deltas
after the receipt. It failed before the fix because no snapshot ACK was sent.

Related startup, SSE, applied-delivery, store and prior durable-prefix tests pass.
No live model calls, staging checks, runtime activation or production deployment
were performed. This changes delivery logic only; no rendered component or design
was changed.
