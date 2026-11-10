# Readable queue details and explicit recovery

The 10 November 2026 user screenshot shows eight queue entries containing the
same internal agent-message header, clipped cancellation controls and a squeezed
status summary. Source inspected at `9f165ea599d8` confirms that queue previews
contain only the start of the internal prompt and that a fixed grid competes with
multiple action buttons. Queue detail failures are also discarded, leaving an
indefinite loading message. These are reproduced presentation and error-delivery
defects; the screenshot alone does not establish why that live queue stopped.

The existing composer status row and HomeDialog remain the presentation owners.
Queue text and actions occupy separate rows, actions wrap, and quiet message rows
use bounded vertical scrolling and wrapping excerpts. The dialog supplies its
existing Close action. Shared semantic colors, UI font, spacing and control-height
tokens remain effective. The 50dvh list limit is structural viewport geometry.

The authenticated queue endpoint enriches only already-listed command IDs with a
recipient-scoped, bounded excerpt from the original session-prompt delivery. Its
SQL projection excludes login custody. Readable source chat names replace raw
session IDs. Queue order, IDs, dispatch, continuation qualification and cancellation
authority are unchanged. A saved queue without an interrupted or failed turn is
described as waiting to resume rather than as an interrupted chat.

Failed detail reads now show an explicit error and read-only Retry queue action,
while retaining the metadata count. Invalidated/session-switched requests remain
expected cancellation. Server diagnostics retain the original error internally;
browser diagnostics contain a stable code, stage, session ID and exception type,
without response bodies or prompts. Repeated browser failures are coalesced until
a successful details read.

## Verification

The focused unit and HTTP regressions cover recipient isolation, bounded original
text, attribution, unchanged queue identities/order, visible failure/retry and
waiting-versus-interrupted wording. The approved composer-status tests remain
unchanged. The design guard passed locally on 10 November 2026.

The offline `queue-status` fixture includes eight long peer messages at narrow
phone and desktop widths, larger text, dark Mint/System and light Teal/Georgia,
touch targets, horizontal bounds, reachable actions, failure recovery, Escape and
draft retention. It intercepts all application requests and starts no backend or
model. Local browser startup was unavailable through the approved host runner;
native execution also stopped at the macOS Seatbelt preflight. No visual pass or
screenshot capture is claimed. ESLint passed for touched TypeScript files. The
frontend type check exceeded the required 1 GiB local Node heap, so its result
is unverified and the full build/type checks remain with CI. CI browser execution and visual review remain
required before acceptance. No live conversation was resumed or cancelled, and
no production deployment was performed.
