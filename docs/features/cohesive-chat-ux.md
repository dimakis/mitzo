# Cohesive chat, links and focused review

Approved by Dimitri in conversation `e137e614-dff3-8059-b715-7fca773fa2b7`:
“This is fire. 🔥 let’s build this and open a pr and let’s get it merged”. The
selected concept is Design A, the compact sheet, with implicit quote navigation
and the existing Symposium entry retained as a robot icon. Subsequent explicit
direction covers plain accent header actions, actionable approvals, deletable
timers and stable Chats hydration.

## Reference and provenance

The original v007 reference remains in its originating workspace. Its SHA-256 is
`f6274457f658f6e6aecf5c5f84f2b6aa6d0d66440fc98c5e3a27e27871a155c0`.
The public ledger reference is derived from it by replacing personal sample home
paths and UUIDs and applying repository formatting. Those changes do not change
the proposed interactions. Earlier mock revisions and existing ledger approvals
are retained. The mock's simulated Symposium agent list does not replace the real
agent editor or its admission, account and lifecycle behavior.

## Resulting behavior

- Chats search focuses its existing field. Header actions share accent color,
  clear backgrounds, touch geometry and keyboard focus. Appearance settings keep
  controlling the theme, accent and font.
- Session launch review leads with title and handoff. Settings remain editable
  under a disclosure, and decisions stay outside the scrolling fields. Completed
  launch configurations are read-only summaries. Launch receipts are chronological
  transcript events instead of a permanent collection at its bottom.
- Links & access contains recent/all linked chats, New chat, Link existing,
  Permissions, Connections and technical session details. Permissions and
  Connections have Back navigation; grant edits remain mounted between panes.
  Links never grant access. Manual unlinking changes navigation only.
- New chat loads saved defaults without starting anything. Explicit Approve &
  start creates the retained launch under the existing controller. The request ID,
  frozen input, runtime validation, default-save transaction and startup claim
  retain their existing delivery fences. Unconfirmed startup requires inspection.
  A failed start keeps its reviewed input frozen. A successful Check request can
  expose an explicit retry with the same request identity and input when no
  retained request exists; failed reads never rearm it. A retained running request
  shows its existing chat without sending another start.
- Peer messages use quiet directional events with named chat links, timestamps,
  exact text, copy and delivery details. Longer messages retain the complete
  original in a disclosure. Queued, failed and uncertain differ from delivery.
- Transcript and composer use the same reply quote. Tapping a loaded exact source
  focuses/highlights it; Back to reply returns to the opener. Missing sources keep
  their reference. No nearest-message guess or broader reply admission is added.
- Drafts is a counted collapsible section with three recent rows and All drafts.
  Existing draft persistence, attachments, prepared repositories and discard
  confirmations retain their owners.
- Approval summaries display known concrete command/access fields before internal
  request details. Unknown shapes keep open details rather than inventing a scope.
  This includes unknown top-level/tool fields, such as sandbox-disabling flags,
  and incomplete or conflicting permission fields.
  Long commands retain their full text. Decision buttons are outside the scroll
  body in Inbox and the popup; question and Telos source review behavior is kept.
- Timers show a bounded title and collapsed full prompt. Delete requires explicit
  confirmation and a current revision. A retained tombstone cancels future checks
  and hides the timer without erasing command receipts or accepted chat messages.
  Repeated delivery uses its original request identity.
- Chats reserves metadata/status space. Already observed message freshness orders
  the first render; late initial hydration offers Show latest. Subsequent real
  activity still follows batching, browsing holds and reduced-motion preferences.

## Validation and limits

Focused red/green tests cover exact source navigation, retained draft input,
explicit new-chat approval, same-origin/authentication fences, link ownership,
revision-fenced timer deletion across restart, cancellation during preparation,
approval facts/scope, stale reads and list hydration. Existing related checks are
retained, including Symposium joining and grant expiry/revocation.

Offline browser contracts are updated for compact disclosures and Back navigation,
both themes, alternate appearance, header search/geometry, stable row height,
startup recovery, draft retention and full message text. Local browser startup was
blocked by the host process sandbox before any fixture ran. A full local type
check hit the repository's 1 GiB heap cap; it was not repeated with a larger heap.
CI must supply those broad/rendered results before merge. No live provider calls,
staging restart or production deployment are part of this change.
