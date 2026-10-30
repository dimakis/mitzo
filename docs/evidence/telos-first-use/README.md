# Telos first-use repair

The collection, focused workspace, chat links and home pins now use the saved
canonical item IDs. The legacy Python list reconstructed IDs from item content;
children created with independent IDs could disappear from the UI even though
they existed beneath the intended parent. No database migration is needed.

## Data and request ownership

- `GET /api/telos/work/collection` uses the existing lifecycle read owner for the selected canonical database,
  requires a current interactive operator, and returns private/no-store records.
  Initialized databases stay read-only unless the bounded snapshot proves snoozes
  are due. That case rechecks the current operator and uses an owned IMMEDIATE
  writer transaction to persist status, deadline, timestamp and history together,
  matching the legacy local-calendar expiry. Only that explicit signal renews a
  reader as a writer; I/O errors never trigger escalation. Genuinely missing
  additive lifecycle tables use the existing narrow schema initializer. It rejects selections above
  5,000 items rather than silently truncating.
- One transaction selects items, resolves inherited lifecycle in one recursive
  ancestry query, and groups sources, links and kinds once for selected identities.
  Completed children remain beneath active parents; completed roots stay out of
  the active view. Invalid records produce explicit per-item failures.
- The client shares one collection owner across the workspace, Today, home pins and chat
  links. Accepted collection records seed tree presentation; they do not trigger
  an additional per-row record-hydration pass. Focused exact-record reads retain
  their own refresh/error handling. Requested ancestors omitted from a filtered
  collection use exact reads; already-seeded descendants need no hydration.
  Related-record retries refresh both the collection and the selected record.
  Reconnect and session notifications invalidate once before active consumers
  join a shared renewal; task-board refresh remains a separate owner.
- Concurrent identical item relationship GETs share only their outstanding
  request, with independent consumer cancellation. Refresh retires old requests;
  an authentication change aborts all outstanding requests. No settled permission,
  credential or attestation result is cached by this change.
- Unclassified rows expose ordinary chat navigation without a relationship read
  simply to expand the tree. Typed roles keep their existing authority checks.
- Descendant membership uses one grouped traversal rather than repeated full
  scans. The 100-sibling SQL regression retains a constant read budget; the
  2,000-node reversed hierarchy regression verifies linear membership work.

## Human-readable workspace

The canonical frame remains during initial loading and navigation, including
priority controls when an accepted snapshot exists. The brief appears once;
full text and context remain accessible through disclosures. Materials and Work
also retain access to the original brief.

Saved Markdown uses the shared document renderer and a wider reading dialog.
Saved PDFs use local PDF.js assets, one bounded canvas and selected-page
navigation/zoom. The original retained PDF is fetched once per opened version; history pagination
retains its page and zoom without reloading its bytes;
there is no external viewer service or all-page image prefetch. Unsupported or
unavailable files retain download/file options and an explicit error.

[Desktop overview](desktop-overview.png), [desktop PDF](desktop-pdf.png),
[mobile PDF](mobile-pdf.png) show synthetic offline fixtures, not personnel data.
These checks use the shared shells, spacing/type/color tokens, controls, focus
and motion patterns. No approved-design references or protected tests changed.

## Creation is distinct from preparation

Child-creation receipts and agent guidance distinguish a work item, a dedicated
conversation and saved original source files. An originating conversation link,
local file path or digest is not proof that a report chat or original PDF exists.
The unclassified detail explicitly offers chat setup rather than claiming a
session has already been prepared. Creating a chat still follows ordinary role
setup/settings; opening the control sends no model prompt.

This code does not upload existing local PDFs, fabricate missing conversations,
change existing work records, deploy production or revive staging. Existing
source attachment and session setup remain explicit operations after the UI fix
is adopted. Their state must be verified before claiming a report is ready.

## Validation boundary

Focused unit, SQLite/HTTP and intercepted browser checks run locally with one
worker and a 1 GiB Node heap because this Mac reports warning memory pressure.
Browser checks run outside the macOS sandbox per repository policy. Broad
TypeScript/build/unit/browser coverage remains mandatory in CI. No real model
calls, live backend, production configuration or credentials are used by these
fixtures. Review and CI results are recorded in the pull request.
