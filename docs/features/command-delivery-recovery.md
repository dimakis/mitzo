# Ordinary message delivery recovery

Recorded and verified: 9 November 2026 against the source and offline regressions
in this change. Source: Dimitri's instruction to repair the investigated approval
expiry/message-delivery incident. Review when the outbox, storage adapter or
ordinary admission protocol changes. Implementation and test evidence do not
prove production deployment or physical-device acceptance.

Ordinary uncertain messages display **Message delivery not confirmed**. The
generic uncertain command state is also used by corrections, so its label cannot
claim the lightning/steering action was used. The existing composer status row,
details, Retry, message controls and approved layout remain in place.

The dedicated ordinary outbox retains a bounded display diagnostic for storage,
transport, deadline, HTTP, receipt and handoff failures. It records the operation,
failing stage, stable code, known HTTP status and measured time. An unconfirmed
receipt check preserves the known command state and the original submission
failure. A validated matching acceptance clears the old submission diagnostic;
a subsequent saving or local recovery failure remains visible until recovery
succeeds. Successful local-only Retry clears that failure without resubmission.
A diagnostic never supplies acceptance, authentication, permission or dispatch authority.

Storage flushes have a 15-second deadline, including the flush before HTTP
submission. Previously, this flush could wait forever before the network timeout
even started. A failed or expired flush retains the exact original command,
releases the busy state and does not submit when the original promise eventually
resolves. Deliberate Retry keeps the same command ID, settings and payload.
This stalled-storage path is reproduced offline; the historical incident lacked
client evidence sufficient to establish that it was its cause.

Browser persistence keeps delivery diagnostics in a separate namespace from the
strict command envelope, preserving older-tab compatibility and original bytes.
Malformed optional hints cannot replace or invalidate a command. Browser console
diagnostics and `command.delivery.failure` spans contain only bounded identifiers,
stage/code/status/time and a fixed exception category. Raw exceptions, message
text, credentials, backend URLs and response bodies are excluded. Cold optional
telemetry never delays submission or starts another request.

Acceptance removes obsolete display hints before enlarging the command envelope
with its receipt. Otherwise, a lost-response diagnostic could consume the quota
needed to save that receipt and leave accepted text in the composer. A focused
quota regression and the actual prepared-repository composer integration reproduce
that failure before this ordering repair and pass afterward.

Validation extends the existing ordinary outbox, receipt, client-store, real
browser-storage-adapter and ChatArea fixtures. It covers a stalled storage commit,
late completion, exact-ID retry, lost acknowledgment, malformed replies, refused
requests, original failure retention, successful reconciliation and private-data
exclusion. The existing all-intercept Local command browser fixture adds phone
and desktop cases in dark Mint/System and light Teal/Georgia, checking the label,
keyboard Retry and unchanged retry payload. It starts no backend or model.

The final historical head `c702a5fe` passed hosted compilation, frontend build,
browser interactions and every phone/desktop layout shard. Inspected retained
captures: [phone dark](../design/assets/command-delivery-mobile-dark.png) and
[desktop light](../design/assets/command-delivery-desktop-light.png). These captures
prove that historical UI, not the final combined candidate or a physical device.
Its CI run `42624572719` failed the composer case repaired above and two joined
acceptance timeouts (Stop isolation and coordinator CT12). Those failures remain
evidence; final combined-result CI and exact-head Centaur approval are required.
Local focused unit and shared design guards pass with one worker and a 1 GiB heap.
The original owner's frontend heap failures and all unique scratch evidence are
preserved in its source checkout and copied into the replacement's scratch archive.
The approved `chat-status/direct-interrupt-2026-11-06` layout and protected checks
are unchanged; no new styling mechanism or design exception is introduced.
