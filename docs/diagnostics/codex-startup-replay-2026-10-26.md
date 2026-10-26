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
offer through the existing background delivery path. If the receipt selects the
chat while that read is pending, the loaded bounded prefix is installed before
acknowledgement and replay; it supersedes any competing full-history restore.
Newer snapshot offers and transport identities invalidate older background reads.
This does not select the chat, render its deferred content, or accept the pending
native command. Those
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
after the receipt. Reverse receipt/read ordering uses nonempty streamed content to
verify each replayed suffix appears exactly once, including when a newer snapshot
supersedes an older in-flight read. The original regression failed before the fix
because no snapshot ACK was sent. Delayed ACK regressions also cover the receipt
installing newer history before ACK confirmation, and history still loading at
confirmation. Both Local and OpenShell must render the suffix exactly once and
then render the next delta immediately.

Related startup, SSE, applied-delivery, store and prior durable-prefix tests pass.
No live model calls, staging checks, runtime activation or production deployment
were performed. This changes delivery logic only; no rendered component or design
was changed.

## Local landing review

Independent reviewers `/root/review_correctness` and `/root/review_behavior`
reviewed candidate `d79b1ba3abeff3f62f233e98ad445930a1ab1a09` against
`5ecfa3e13b2e67ec5f91b4aa86b186fee1e192d2`. Both identified the same P1:
a receipt could install newer history before the background snapshot read finished,
then its older ACK replayed a suffix twice. The added regression failed with
`PrefixSuffixSuffix`. The follow-up restores the loaded exact prefix before ACK
when the chat has become selected and discards superseded background reads.
Reviewers cover source behavior and offline fixtures; CI and device acceptance
remain separate evidence.

## Pending-ACK ordering

Centaur finding `CEN-A0B31DE7A680` on `f3398c4d` identified a second valid
ordering: the background bounded read finishes and requests its ACK, then the
receipt installs newer full history before the ACK response arrives. Confirming
the old offer would replay an already-rendered suffix. The added Local/OpenShell
regressions reproduced `PrefixSuffixSuffix` before this follow-up.

Applied delivery now records the latest actually installed transcript boundary
on the pending offer without advancing its transport cursor. Exact server ACK
confirmation releases the fence at the offered cursor. Already-rendered events
still follow their predecessor chain and receive individual ACKs, but do not
render again. Later events render normally. A subsequent bounded restore replaces
the recorded boundary exactly, even if older; new offers and replay/session
clearing discard coverage. Rejected or lost ACKs retain recovery fencing. This
uses the existing delivery protocol and does not acknowledge missing events.

A receipt history request that is still pending at ACK confirmation can fail
without installing its prefix. Current receipt recovery failures now surface the
history error and reconnect for an authoritative snapshot; stale failures do
neither. Bounded restore failures keep their existing timeout fencing, avoiding
an immediate reconnect loop. Local/OpenShell success, failure and stale-failure
fixtures cover these orderings. The launch fixture now creates a fresh HTTP
Response for each request instead of reusing a consumed response body.

## Combined-base acceptance

The combined branch includes main's composer-receipt changes at `01c3126d`.
Two non-Git browser journeys filled their departing composer immediately after
route navigation, before the destination draft owner committed. CI retained empty
destination composers after that fill, with successful metadata and no runtime
refusal. The journey fixtures now wait for exact destination metadata/transcript
reads, the committed session selection and cleared loading state before the first
advisor, lead or worker input. They retain every send, receipt and native-dispatch
assertion and do not retry input. No rendered product code changes are involved.

The same CI attempt's native API repository workflow exceeded its existing
240-second outer test budget after successful preparation (141.3s) and handoff
(36.8s), while inspection was still reading successfully. Its timings matched the
earlier intermittent failure that passed unchanged on retry. No native deadlines,
assertions or execution policy were relaxed. Qualification remains required.

The next combined-head CI passed both non-Git journeys and both native account
workflow qualifications. Its chooser journey exposed the same draft-owner race
in an additional chat's first send. The readiness barrier now covers equivalent
ordinary first-command entry points in shared-app and process-hosted journeys,
including initial unsent peer/lead drafts used as isolation controls. Process
fixtures capture only actual session metadata/transcript responses before
navigation; recovery/retry phases retain their original contracts.
