# Bounded owner/consumer diagnostics proposal

Status: proposed to the implementation owners; no diagnostic production code is
added by this acceptance slice. The original device incident is still open.

Required incident inputs remain absent: original user chat/conversation ID,
request ID, phone client build, original operation and its receipt. Obtain those
through the ordinary incident owner before attributing the phone freeze. The
empty-recipient reproduction, composer replacement and source admission guard
are independently observed defects, not a complete device root cause.

Use the existing logger and ordinary operation receipts. One bounded diagnostic
record should connect the producing owner to the consumer that renders its state:

| Boundary                                  | Existing correlation to retain                                                                         | Stable stage / proposed event                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Fresh preparation → setup consumer        | preparation operation ID, source conversation ID                                                       | `preparation` / `collaboration_preparation_failed`                          |
| Reviewed brief → joining owner            | review request ID, join operation ID, collaboration ID, source conversation ID                         | `review` or `joining` / existing rejection code where available             |
| Recipient qualification → shared composer | collaboration ID, participant session ID, membership revision, policy sequence                         | `recipient_readiness` / existing `collaboration_recipient_readiness_failed` |
| Explicit send → ordinary admission        | original request ID, message ID, delivery ID, participant session ID, ordinary command ID              | `admission` / existing admission result code                                |
| Ordinary reply → shared projection        | same command and delivery IDs, source conversation/message identity, last observed durable sequence    | `reply_projection` / `collaboration_reply_projection_unavailable`           |
| Stop / lost response → recovery consumer  | original request/message/command IDs and original Stop operation                                       | `stop` or `recovery` / distinguish unavailable, rejected and uncertain      |
| Progress read → responsive consumer       | read correlation ID, collaboration/source IDs, membership revision, client build and consumer mount ID | `progress_read` / `collaboration_progress_unavailable`                      |

Record `code`, `stage`, the applicable correlation IDs, outcome, and an allowlisted
sanitized error category/message. Preserve a diagnostic ID in the public error
response and its matching structured record. Do not log prompt bodies, joining
brief/context bytes, hidden reasoning, credentials, provider homes, private
account payloads or arbitrary serialized error objects. Use explicit categories
such as `workspace_root_missing`, `owner_unavailable`, `scope_changed` and
`receipt_unconfirmed`; retain the underlying exception privately only through
the repository's existing controlled error facility when allowed.

The original direct-source fixture failed because it lacked the physical task
root normally created by `index.ts`. Its public response had a diagnostic ID,
but the generic preparation log did not retain an actionable sanitized cause and
stage. Correcting that synthetic prerequisite is not a product fix. It is a
concrete example for a diagnostic test: the response diagnostic ID must match one
structured `preparation` record with `workspace_root_missing`, without a path or
private payload in the consumer.

The native ordinary SSE path emits queue and message events while its durable
command ledger has separate state. The acceptance harness therefore observes
real source streaming and command receipts rather than deriving native admission
from the legacy `messages.running` boolean. Any future consumer instrumentation
must name which owner/state it observed and avoid presenting missing telemetry
as proof of an idle or failed provider.

The retained WebKit trace at `8b65d6880` adds a separate consumer diagnostic
example: a progress-fetch pageerror occurs while the old document is navigating,
alongside cancelled requests. The progress hook catches its rejection. Keeping
one document across presentation captures passes, but does not qualify browser
unload or establish a device root cause. A bounded read diagnostic should
distinguish explicit unmount/auth cancellation from a network failure, preserve
the client build and read/mount correlation, and emit a failure/recovery state
transition rather than every 1.5-second poll. Record an allowlisted error category,
not a raw URL, arbitrary stack or authentication scope. This remains a proposal
for the owning producer/consumer; no instrumentation is added here.

Suggested verification: one missing-root preparation, one stale qualification,
one failed recipient with another already completed, one committed response lost,
and one Stop response lost. Each should produce one correlated owner/consumer
failure or uncertain state, without replaying a successful recipient or creating
a replacement request. Joining and reading still cause zero inference. This is
a bounded observability follow-up, not authorization for live-model or phone tests.
