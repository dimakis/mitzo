# Immutable Symposium review records

**Prepare PR review record** exports a verified snapshot to the host review
store. It does not write into the reviewed repository or create a pull request.
The existing trusted-host check must confirm that the workflow's artifact is
still current. Unavailable host authority, stale artifacts, unresolved findings,
and missing verification evidence continue to fail closed.

The version 1 snapshot includes owner, session, workflow, artifact revision and
SHA-256 hash, the complete verified workflow (including result, role/profile,
review, fix, usage, and evidence identities), and its ordered history through an
exact final sequence. State and history are read in one SQLite transaction.
Canonical JSON sorts object keys recursively and preserves array order. The
UTF-8 snapshot is limited to 1 MiB. Its SHA-256 digest determines the record ID
(`review-<digest>`); repeated exports of the same snapshot return the same ID,
creation time, and content. Changed evidence, history, or artifact verification
produces a different snapshot. No update or deletion operation is exposed.

`GET /api/sessions/:id/symposium/reviews/records/:recordId` requires interactive
authentication and scopes lookup to the authenticated application owner and
session. It can retrieve a historical record after the runtime is unavailable or
the workflow advances. Responses use `Cache-Control: no-store`. Retrieval checks
the canonical payload digest, record identity, scope, artifact identity, and
history boundary before returning data. A mismatch fails closed. These integrity
checks detect changed stored payloads; they are not an external signature or a
claim that a fully compromised host database is trustworthy.

The UI exposes the authenticated reference and content hash. The link is not
public sharing, and the snapshot does not imply that the current branch still
matches it. Future publication must independently recheck current artifact/Git
identity and seat authority at approval and dispatch, then use the existing
reviewed publication capability. This slice does not add that capability.

The saved record opens inside Mitzo through `apiFetch`, so Capacitor and other
configured API origins retain bearer authentication as well as browser cookies.
The view checks the returned record ID and content hash against the selected
immutable reference; the server continues to enforce owner/session scope and
stored-content integrity. Failed or mismatched reads show an error and retry,
never a substituted record or unauthenticated browser navigation.

Each prepared record also exposes a permanent app route at
`/sessions/:sessionId/review-records/:recordId?hash=:contentHash`. This copyable
link reloads the authenticated record independently of the review panel's state,
including after a refresh. The URL contains identity and integrity metadata, not
credentials; opening it still requires the owning Mitzo login.
