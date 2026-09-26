# Review publication preflight

This slice adds a concrete read-only adapter, not PR creation. The authenticated
`POST /api/sessions/:id/symposium/reviews/records/:recordId/publication-preflight`
route returns `preview_only` or an unavailable decision. Production bootstrap does
not yet install its dependencies. Both the normal runtime gate and trusted review
host must be available before the route can inspect a publication.

The adapter reuses `github.publish-pr@1` preflight: a clean committed feature branch,
allowed repository/base, bounded changed-file summary, remote branch policy, and
existing PR identity are inspected by the existing executor. Its mutation methods
are replaced with refusals, and the adapter exposes only inspection. It neither
creates an operation nor approves, pushes, creates, or updates a PR. It requires a
real pending operation already held in the capability operation store; the future
interactive binding must create that operation using the existing service flow.

## Artifact identity

`mitzo-committed-tree-v1` is SHA256 over its name plus a NUL byte followed by the
canonical JSON array of `{mode, oid, path}` entries, ordered by UTF-8 path bytes.
Entries come from bounded `git ls-tree -r -z --full-tree <sourceOID>` through the
OpenShell control transport and its Git-directory/workspace boundary checks. Blob
object IDs bind committed content; paths and executable modes are included in the
digest. This is a committed-tree manifest digest, not a working-directory checksum.
Only regular blobs with modes 100644/100755 are supported. Symlinks, submodules,
invalid UTF-8, control characters, duplicate/escaping paths and oversized manifests
fail closed. Existing opaque review hashes are not converted or assumed compatible.

The review record's revision must equal the inspected commit OID and its hash must
match this digest. A native record producer must deliberately implement this
identity contract before its records can pass. Git state is inspected before and
after digest collection, and again after remote policy/PR reads. Current review
history, builder selection, membership generation, capability operation/input,
connection revision/grant, volume labels, driver configuration and existing writer
lease are rechecked. The lease is not acquired or released by this adapter.

These repeated checks produce an inspection preview, not a lasting lock or approval.
An existing writer lease alone does not freeze the builder's process. Publication
must hold the appropriate artifact mutation exclusion and repeat the identity checks
across approval and dispatch; this slice does not claim that native exclusion proof.
The PR body must include the exact immutable record ID and SHA256. This is a record
reference, not public disclosure or attachment of the full authenticated history.

## Required next work

- The native ReviewHost must collect terminal result, structured findings, actual
  token/cost usage and host verification evidence from the same native attempt,
  enforcement identity, seat generation and artifact revision/hash. Process cleanup
  and provider acceptance alone do not establish terminal execution evidence.
- The user must choose concrete review-round, token and cost limits. That choice
  does not establish native enforcement: the host must prove hard remaining limits
  before admission and keep uncertain attempts reserved. An unanswered budget
  question cannot be replaced with guessed limits or estimated usage.
- Bootstrap must resolve the current physically admitted builder and its sandbox,
  exact artifact lease, account/profile revisions and live GitHub connection/grant.
  These dependencies cannot come from an HTTP body, model finding or saved record.
- Publication must use the existing forced approval, durable preflight/input hashes,
  idempotency, postapproval checks and recovery machinery. It needs durable
  record-to-operation association and an explicit attachment/disclosure policy.
  A preview must never be reused as authorization or dispatched through a direct
  shell publisher. No ordinary-session fallback or native gate bypass is added.

Tests use mocked OpenShell/provider control and local data only. They do not prove
live native review, OAuth, model execution, GitHub publication or deployment.
