# iOS notification approval recovery

Outside-app approval buttons are authenticated native actions. They do not use
the foreground web view or its WebSocket. `ALLOW_SESSION_ACTION` remains
`always` on the wire; once, conversation, search-session and deny retain their
original distinct actions and scope checks. The native handler first fetches
the request. The authenticated server adapter rechecks the live pending owner,
displayed input, scope and expiry immediately before calling its resolver.

The callback owns a background task and a 12-second overall deadline. Expiration
or deadline cancels its network task and completes the OS callback exactly once,
even if an underlying operation does not cooperate. A late fetch cannot proceed
to submission after cancellation. Local failure-notice scheduling cannot delay
that completion. Failures use stable sanitized codes; native logs retain the
request identity and private original cause, and server logs retain the original
error and permission correlation. Notice-scheduling failures are logged too.

Each native submission has an independent response ID. The notification store
durably records receipt before invoking the permission owner, then records its
actual allowed, denied or expired result. A duplicate exact submission reads
that receipt; conflicting payloads are rejected. A retained `received` receipt
after interruption is unconfirmed and is never replayed. Receipts describe
approval settlement, not completion of the subsequent tool or continuing grant
validity. The existing permission owner still applies revocation and expiry.

The phone retains only response/action/session/notification identity, origin and
sanitized outcome for reconnect. It stores no command, credential or grant in
that record. Unconfirmed identities are retained; only terminal history is
bounded. An exact terminal receipt stops further recovery reads. Reconnect uses
fresh authentication and the same configured origin
to read the exact response receipt. It never repeats a POST or infers success
from an unrelated notification's allowed state. Rejected and expired receipts
update the visible failure notice. Confirmed receipts remove the stale notice;
the Inbox continues to show the server's current request state.

The native Watch relay now sends hello before waiting for welcome and retires
old socket receive, heartbeat and reconnect tasks. Generation checks fence late
callbacks; cancellation during hello retires the socket. The WatchConnectivity
host serves cold session/history reads with fresh REST authentication. Chat
demand and foreground scenes share a native connection owner; notification
approval launches alone do not open its WebSocket. The same authenticated actor
retains watch membership (including zero-event sessions) and received cursors
across socket replacement. Welcome restores subscriptions through the owning
server's reconnect adapter before queued commands. Attempted commands and
permission responses are never replayed. Changed origin, credentials or logout
retire stale clients and their queues; acquisition revalidates authority across
asynchronous setup and preserves a concurrent foreground reconnect request.
These cursors record phone receipt, not Watch application: recovery from a
subsequent unreachable Watch relay remains a separate limitation.

## Evidence and limits

On 9 November 2026 the original isolated incident checkout was located read-only.
Its unpublished transport commit and unfinished tests were preserved separately
and brought into a fresh checkout. The original dirty tree was not modified.
The server policy changes already accepted through separate work are not repeated.

Read-only current server logs show a specific recent session-scoped native-command
approval received over WebSocket and audited as `always`/`allowed`, with its
original trace identity retained in the local recovery evidence. That establishes
receipt for that request only. The available logs do not correlate it to the
reported outside-app notification tap. No matching synced iPhone crash report
was available. An absent receipt cannot distinguish never-sent, interrupted,
expired or rejected submission without additional evidence.

The buttons have no foreground option: normal dismissal of system notification
UI can therefore occur while the host app runs in the background. That is not
evidence that Mitzo crashed. Conversely, completion of a fixture does not rule
out a device crash or OS termination. Lifecycle logging and response identities
support a subsequent diagnosis; `applicationWillTerminate` is not guaranteed.

Focused Swift transport/action/HTTP-adapter tests, authenticated server adapter
and durable-reopen tests, browser push/Inbox unit tests, and source/design checks
cover this change. Shared iPhone/Watch code and the complete Watch UI typecheck
against their simulator/device SDKs. Full shared testing in the local sandbox
also encounters unchanged certificate-trust and temporary-file fixture failures;
those are recorded separately from the passing approval regressions. CI must
build the actual iPhone target and pass all required checks before source acceptance.

Real-device acceptance remains separate: with reviewed server and native sources
explicitly deployed to an authorized target, test background and cold-launch
notification actions for each scope, expiry/revocation, locked-device auth,
network loss before/after settlement, OS expiration and foreground reconnect.
Include cold Watch chat wakes and a phone foreground transition with an already
open Watch chat.
Record the response ID, server receipt/audit, process/lifecycle logs and an iOS
crash or jetsam report if the app terminates. Verify one resolver settlement and
one callback completion. No production activation or device installation is part
of this source task.
