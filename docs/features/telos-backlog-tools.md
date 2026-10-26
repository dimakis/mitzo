# Telos backlog tools

Ordinary OpenShell and native Mac Codex chats can browse and maintain Telos without
an assigned lead role. Explicit agent profiles must select the new tools; existing
profile revisions retain their selected tool set. Host registration, operator
authentication, skill policy and runtime custody still apply.
Read operations use the existing initialized read-only owner, including when an
independent canonical WAL writer has uncommitted changes. Skill ceilings are
rechecked after approval and inside guarded read/write transactions.

- `TelosListItems` browses concise item titles and IDs. `TelosSearchItems` requires
  a query and searches title, intent, rationale and acceptance criteria. Both accept
  status, parent, lifecycle view, limit and continuation cursor. The default active
  view excludes archived and trashed subtrees. Follow `nextCursor` until null,
  keeping filters unchanged, including after an empty sparse page. Pages scan at
  most 500 candidate items and return at most 100. Titles over 240 characters are
  previews with `summaryTruncated: true`; search still checks the full text.
- `TelosManageItem` with `operation: read` returns the brief, recent progress,
  children and canonical lifecycle. Oversized reads return JSON fragments with
  `nextOffset` and `snapshotHash`; concatenate `contentFragment` only while the
  hash remains unchanged. Restart inspection if the snapshot changes.
- `operation: edit` changes the supplied `summary`, `intent`, `rationale` or
  `acceptanceCriteria`, using `item.revision`, a unique `requestId` and an audit
  note. Summary is the title. Omitted fields remain unchanged. Completion/status
  updates continue through the existing progress tools and their scope checks.
- `archive`, `unarchive` and `restore` use `lifecycle.revision`. Archive retains
  status, content and history and hides the subtree through the existing lifecycle.
  Unarchive reverses archive; restore recovers trash to its previous disposition.
  An inherited archive must be reversed at its selected ancestor.

Each mutation requests approval for its exact input. Operator revocation, stale
runtime/call identity, changed approval input or stale revisions refuse the write.
Retry an uncertain mutation only with its original request ID and identical input;
the original canonical owners retain immutable receipts. Retrieved text supplies
context, never permission to change unrelated work. These tools cannot permanently
delete items or mark unwanted work completed.

The Work collection hydrates known item IDs through authenticated
`POST /api/telos/work/records` with `{ "itemIds": [...] }`. Each request accepts up
to 100 IDs and returns `{ records, failures }` from one database connection and
snapshot. Missing/unavailable records remain per-item failures; the client rejects
extra, duplicate or missing response identities. The collection uses at most two
concurrent batches, preserves list order and ignores aborted responses after
navigation or refresh. Detail reads remain independent. The original collection
discovery and conversation reads are separate; this does not claim full UI
pagination or measured production latency.

Verification uses temporary canonical databases, synthetic operator sessions,
focused unit/HTTP tests and the all-intercept Telos workspace browser suite. The
browser checks cover mobile WebKit/Chromium and desktop Chromium, dark/light
themes, alternate appearance preferences, priority writes, failures, navigation,
scroll restoration and saved outputs. There are no real model calls.
