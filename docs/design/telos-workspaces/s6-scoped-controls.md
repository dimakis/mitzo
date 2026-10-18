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

The operator `POST /api/telos/work/controls` and exact-session internal
`POST /api/internal/telos/work/control` support request, inbox, read,
acknowledge and release. Neither accepts application or revalidation evidence.
The internal envelope pins both client and ordinary session IDs; request JSON
cannot select its actor. Coordinator/recipient authority is checked in the same
synchronous transaction as persistence. New pending delegation consumes the
new-worker-dispatch fence; an already committed allocation receipt remains
recoverable without creating another worker. HTTP and existing route tests pass
(26 tests); the new endpoint test was observed failing with a missing route first.

`TelosWorkControl` exposes these operations to retained ordinary lead/worker
roles through the existing native tool surface and MCP transport. Standard tool
permissions and exact unchanged-input approval apply. Native owner/retained-role
identity is rechecked after approval; the route independently checks current
assignment authority. Inboxes carry retained data and do not launch model turns.
The tool cannot claim applied evidence or revalidate a publication. The held
Telos profile catalog activation policy is preserved. Focused tool, MCP and
native regressions pass (118 tests), including observed red transport and native
registration failures before implementation.

The ordinary host now records application evidence when it actually denies new
worker dispatch or a new command at the safe-point boundary. The evidence commits
outside the refused action transaction, so throwing cannot erase the receipt.
The pure in-transaction denial fence remains a second check. A child/lead denial
never marks other recipients applied. Nested coordinator aggregation requires
all descendant leads and workers to have independent current evidence. Dedicated
red/green tests cover these distinctions; the delegation/command boundary suites
pass (39 tests). The server TypeScript check also passes under the 1 GiB limit.

The approved publication scope is **publishing to shared main**. The current
GitHub action creates/updates a feature branch and PR and has no main-merge
operation. This implementation does not broaden a main-publication hold to block
PR preparation or fabricate an applied main-publication receipt. Shared-main
publication owner integration and its exact-head/current-main validation remain
explicitly outstanding. The host guard/revalidation ledger is preparatory until
that action owner is connected and tested.

A new-worker-dispatch hold also fences the first provider turn of an already
allocated/queued worker. The existing execution ledger's durable provider-attempt
history distinguishes a started conversation from queue admission. Existing
workers can continue unless a safe-point hold separately applies. Restart
preserves that distinction. The new allocated-but-unstarted regression was
observed red and then green. The real delegation-host regression was updated to
use independent sibling workers for client rebinding; a separate real retry test
asserts CT11 retirement instead of expecting a retired worker to complete.

An operator reparent can remove a selected outcome from the coordinator. Its
former control cannot follow it into unrelated work or read its new recipients.
Other still-attached recipients retain their own gates/evidence. Detached scope
is pending/unavailable rather than applied. A dedicated red/green regression
covers current routing after reparenting; prior control records are retained.
