# S3 first increment: canonical records and origin backlinks

Parent `85e8444019a4ae4a`; slice `d4e0bf084cd61139`.
This increment is stacked on S2 #975 at
`aca87d627080ff15117408fb03eeb4bb777ff049`. S2 is pending acceptance;
the recorded merge order remains #972, then #964, then #975. This increment
cannot merge ahead of its prerequisites or release their hold.

The frozen UX remains binding: artifact `9d0559132154b92d0bbb427a982a0002@r1`,
SHA-256 `97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
No product UI or approved mock changes are included.

## Existing records stay authoritative

`TelosWorkStore.readRecord` projects the original canonical item, source and link
rows into S1's `TelosWorkItem`. It shares S2's transaction and exact-item read
authorization. The new operator endpoint is
`GET /api/telos/work/items/:itemId/record`; `TelosWorkApiClient.readRecord`
validates its response and supports cancellation. Interactive authentication
runs before opening the database. The existing internal read endpoint is unchanged.

The projection preserves outcome/intent, rationale, acceptance criteria, source
profile, status, star, authoritative parent, all context hints and full source
snippets. Dates retain their original text, including naive and offset timestamps.
Source `timestamp` is its creation date, not an inferred date of addition. Absent
dates remain null. Unknown kind stays null until explicitly classified. Source
profiles, keywords and session hints do not become categories, leads or workers.

Complete original item/source/link rows also remain in `legacyFields`, including
IDs, JSON text, urgency, snooze state, accounting goal, idempotency key, first/last
seen and unknown extension fields. Invalid stored JSON or incompatible known
field types refuse the read; the API returns a safe unavailable error. They are
not silently replaced with empty values. Explicit stored categories are projected
when present; the current canonical schema has no category field and yields an
empty list. Category discovery and pinning still belong to S7.

This is a read projection, not an import into a second store. Repeated reads do
not rewrite items, sources, links, history or progress. Retained materials continue
to belong to `TelosArtifactStore`; bytes, IDs, revisions, hashes, dates and source
attribution are unchanged. Existing unpinned general artifact links stay unpinned;
an exact adopted reference must use the artifact owner's revision/hash, not infer
approval of whatever a general link currently resolves to. Outputs, sources and
links remain separate.

## Source reference and backlink commit together

An operator's existing `source` command now records an `origin` role link in the
same SQLite transaction as the immutable source reference. It returns both in
the command receipt. Actor/request replay after restart retains the original
receipt. A new request for the same exact snapshot can idempotently ensure its
origin link; conflicting snapshot contents roll back without adding a link.

One source conversation can originate several items. A null source creates no
invented chat. External Codex origins retain their namespace and are never
enrolled as ordinary Mitzo sessions. Adoption does not assign a lead/worker,
enqueue an allocation, change ordinary session settings or start a turn.

## Test-first evidence and remaining S3 work

The record tests failed first on the absent `readRecord` method. Route and client
tests then failed on the missing endpoint and method. The origin test failed on
the absent backlink. The manifest regression failed on the missing projection
fingerprint before the manifest was updated. The focused suites subsequently
passed with the changes. HTTP tests use temporary fixture databases and sockets;
no provider, account, staging or production calls are involved.

Coverage includes full text beyond the former 200-character DTO limit, original
and unknown dates, malformed legacy data, exact-item authority, repeated reads,
actual retained artifact revisions/bytes/provenance, shared origins, conflicting
adoption, restart replay and absence of allocation/session mutations.

**S3 remains active.** This increment does not prove that a submitted source
reference is the authorized original exchange. The remaining integration must
reuse the accepted collaboration source/context owner (pending #964), resolve
the selected public messages/blocks at the reviewed immutable boundary, retain
their exact content and artifact revisions, and connect ordinary-chat creation
to reviewed Telos adoption. Later messages and brief changes must not rewrite
that adopted context. Caller-supplied bytes or source IDs are not proof. Do not
add a parallel conversation compiler to bypass that owner.

S7/S8 still own product composition and navigation: the original-chat backlink,
full chat advisor/lead/worker screens, multiple-chat chooser, shared configuration
controls, compact header, minimal back action and collapsible work tree. Their
frozen behavior must be implemented and qualified before claiming product UX
completion. S9 still owns the full device/runtime acceptance matrix.
