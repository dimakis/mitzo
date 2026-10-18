# S6 durable scoped controls (CT11/CT12)

Controls extend the canonical Telos store. The current coordinator lead can hold
explicit, directly attached outcomes/coordinators while choosing a different
attached priority outcome. The composition tree supplies scope; a nested
coordinator cannot reach siblings, unrelated Job work or its ancestors. No model
turn, scheduler, interruption or abort is implied by a control.

Request, recipient acknowledgement, host application and release are separate
facts. Missing leads/workers stay requested. A lead acknowledgement never proves
its workers applied the hold. Host application requires independently verified
per-recipient evidence. Duplicate/delayed acknowledgements cannot downgrade
applied evidence. Current assignment revisions fence retired holders; historical
receipts remain immutable. Replacement holders appear requested and must supply
new evidence. Conversation reads are limited to their current recipient scope.

Publication, new worker dispatch and safe point are distinct scopes. A requested
control denies its declared future action even before recipients acknowledge.
Publication release requires a host-verified validation receipt for the exact item,
current work revision and current main commit. The caller must supply the actual
current commit again at publication; later main/work changes invalidate reuse.
No public API can manufacture host application or validation evidence.

All state/receipts live in the existing database and are included by its whole-
database backup owner. Offline tests use the accepted canonical MGMT schema and
synthetic rows: six outcomes, five held, one priority, unrelated Job work,
replacement, delayed/duplicate acknowledgements, denied fake host evidence,
restart, release and current-main validation. Four tests pass after observed red
missing-owner failures. These are store contracts; endpoint, ordinary-queue and
publication integration evidence is still required before S6 acceptance.
