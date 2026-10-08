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
Symposium-only read-only OpenShell transport and the unchanged publisher
Git-directory boundary script. The existing reviewed publisher transport and its
trust manifest remain unchanged. Blob
object IDs bind committed content; paths and executable modes are included in the
digest. This is a committed-tree manifest digest, not a working-directory checksum.
Empty committed trees have the canonical empty-array digest. Only regular blobs with modes 100644/100755 are supported. Symlinks, submodules,
invalid UTF-8, control characters, duplicate/escaping paths and oversized manifests
fail closed. Existing opaque review hashes are not converted or assumed compatible.

The review record's revision must equal the inspected commit OID and its hash must
match this digest. A native record producer must deliberately implement this
identity contract before its records can pass. Git state is inspected before and
after digest collection, and again after remote policy/PR reads. Current review
history, builder selection, membership generation, capability operation/input,
connection revision/grant, current seat-scoped connection attachment to the exact
builder sandbox and gateway provider, volume labels, driver configuration and existing writer
lease are rechecked. An existing durable approval card and its hash must match the
new preflight exactly; a preview cannot replace a pending approval. The lease is not acquired or released by this adapter.

These repeated checks produce an inspection preview, not a lasting lock or approval.
An existing writer lease alone does not freeze the builder's process. Publication
must hold the appropriate artifact mutation exclusion and repeat the identity checks
across approval and dispatch; this slice does not claim that native exclusion proof.
The PR body must include the exact immutable record ID and SHA256. This is a record
reference, not public disclosure or attachment of the full authenticated history.

## Required next work

- The native ReviewHost must collect terminal result, structured findings and host
  verification evidence from the same native attempt, claim identity, seat
  generation and artifact revision/hash. Observed token/cost usage remains
  explicitly partial or unknown when final accounting is unavailable. Process
  cleanup and provider acceptance alone do not establish terminal execution evidence.
- The user must choose concrete application limits for host turns, review cycles,
  deadline, user stop, no progress and explicit continuation. Persisted reservations
  fence admission and keep uncertain attempts charged until exact-operation
  reconciliation. Missing selections cannot be replaced with guessed limits or
  estimated usage. Guaranteed native token/spend caps and mandatory final usage
  totals are deferred under the
  [current acceptance contract](symposium-integrated-acceptance.md#application-policy-contract).
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
