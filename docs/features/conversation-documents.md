# Documents in chat Outputs

Resources → Outputs brings workspace documents, independently saved copies and
documents saved in Work into the same conversation surface. This is shared host
behavior for ordinary chats on Anthropic Vertex, Google Vertex, OpenAI API and
Codex subscription accounts. Listing, previewing, keeping and downloading make
no model call, reconnect request or task creation.

## Discovery and recovery

Successful normalized document writes appear automatically as **Created in
workspace · not kept**. Native Codex multi-file changes retain bounded path
metadata through the existing tool projection. Failed/declined writes and deletes
do not prove creation. Assistant Markdown links, local path mentions and
code-formatted file handoffs appear as **Linked in chat · file not checked**.
They never prove that the file exists or has been saved. HTTP links, user inputs,
read tools and result images do not become generated documents.

Discovery reads bounded existing events (512 recent write/result events and up to
100 finalized response blocks, with a 1 MiB discovery text budget). It returns at
most 100 workspace candidates and does not read files or wake sandboxes. **Keep
another file** recovers older/unlisted outputs by exact workspace path. Merely
opening Outputs never imports or saves a file.

Preview verifies the selected conversation's original workspace authority and
reads at most 5 MiB through the existing descriptor-relative no-follow helper.
Host workspace reads do not require a live model session. Recorded secondary
repository worktrees retain the same conversation-scoped access as Files. The
original directory inode is pinned before capture; custody/private-path policy
and the exact file witness are renewed after the asynchronous read. Remote reads use the
original retained runtime/account receipt and report unavailable workspaces
without recreating them or substituting another account. Existing private-path
and custody checks still apply. Supported deliverables include Markdown/text,
CSV/TSV, JSON/YAML, Office/PDF documents and common image/HTML formats; source
code changes are left to the repository workflow. HTML/SVG previews are inert text.

## Keeping and version history

**Keep a copy** requires the SHA-256 from the preview. A changed file refuses the
save until previewed again. **Keep a chat response** copies an exact finalized
assistant text block into a Markdown document after verifying its retained source
identity/hash. Existing conversation references remain reference-only and continue
to support output contributors; they are not relabelled as saved byte copies.

Copies live in `session_document_revisions` on the existing event-store owner's
SQLite connection. The owner's backup and conversation retention lifecycle covers
both bytes and `session_document_requests`. No new standalone database, filesystem
cache or Telos task is created. Copies survive model session closure and workspace
removal; they do not override the existing conversation deletion/access policy.
Each revision records its originating conversation, source path/key, account
routing reference (never credentials), filename, title, byte count, hash and date.
Legacy conversations without a recorded account retain a null account reference.

Changed content/metadata creates an immutable revision for the same canonical
source file. Unchanged saves deduplicate. Historical revisions remain selectable
and downloadable after the workspace is gone. APIs require an exact revision;
there is no silently changing latest-version download. Saved-document catalogs
use bounded keyset continuation after 100 records; version history loads earlier
pages after the first 50 without changing the selected revision. Downloads use attachment
disposition, octet-stream, nosniff and private/no-store caching.

Browser session storage retains only opaque request IDs and intent fingerprints
for uncertain saves. Retry reconciles the same request before rereading the source,
so a successful save remains recoverable after its original workspace disappears.
Other conversations cannot resolve that receipt or its saved bytes. Scope is
rechecked after asynchronous reads and before committing the copy.

Work documents reuse the canonical Telos source-material index and existing
artifact viewer with its current item/privacy policy. They remain in Telos;
Outputs does not duplicate them or grant access through account billing identity.
The first bounded page is shown with a Work-history notice when more exists.
Symposium seats keep their separate custody/publication contract; these ordinary
document APIs cannot be used to bypass it.

## Verification

Offline tests cover retained bytes/reopen, immutable revisions, uncertain retries,
conversation isolation, source hash conflicts, asynchronous scope changes,
successful/failed write discovery, native multi-file projection and each provider.
The intercepted `session-documents` browser fixture uses the actual Resources
dialog at 320px/1280px in light/dark themes with alternate font/accent preferences,
pagination, failure/retry, reload and conversation switching. No backend,
credentials or model calls are used. Broad builds/type checks run in CI when the
repository's local 1 GiB heap limit is insufficient.
