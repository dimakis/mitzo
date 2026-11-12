# Compact inline chat queue

Dimitri approved the compact revision 3 mock in MGMT task
`repo-129e0088-815f-8b2b-a064-053790a2b1cf` on 12 November 2026: “I love this.
Let’s build and open a or” (the preceding exchange concerns building the approved
mock and opening a PR). The retained HTML reference is in the chat-status design
ledger. Earlier references and approvals remain intact.

The shared QueuedDraftTray now renders above ChatInput rather than being projected
into the Conversation status popup. Single-line previews, compact dispatch state,
and a bounded scrolling list keep the transcript visible. Minimize retains the
count, next-preview and pause action. Tap a row for inline full text, attachments,
reply/context details, editing, removal and Make next. Reorder exposes direct
earlier/later controls. These update the saved pending queue; they never dispatch,
interrupt or steer. The existing composer drain chooses the new first entry when
the current response finishes, and Stop still pauses the queue.

The implementation reuses UiIcon, MotionPresence, semantic theme roles, shared
spacing/type/control tokens and the existing IndexedDB-backed queue. Storage flush
failure stays visible and holds automatic draining until an explicit save retry
succeeds. Original message IDs, payloads and uncertain delivery ownership survive
ordering. A row cannot move across an unconfirmed submission. A stale row identity
cannot overwrite a different pending draft.

## Engine and runtime scope

Ordering and ordinary dispatch use the same ChatInput/useQueuedMessages path for
every admitted engine and runtime. A consumer test queues two messages, reorders
them, and finishes the response through that shared composer. It invokes existing
owner callbacks; it does not qualify native runtime availability. Repeating this
test under different route labels would not establish additional coverage.

Investigation established that main at `f7a474ea9` enabled composer steering only
for bound Codex chats. PR #1310 supplied related Local Claude/Codex peer-runtime
work and was accepted as `94b60f4f8fffd0f319bebbae00a4f7fa1b5f6faf` on 12 November 2026. This branch integrates that dependency and adds a separate authenticated
user correction path for admitted Local Claude SDK owners. It never constructs
an AgentMessage or borrows a peer grant.

Phone and desktop use the same native-steering capability predicate: Codex on
Local Mac/OpenShell and admitted version-2 Claude SDK on Local Mac. The current
catalog does not enroll OpenShell Claude. Unsupported routes explain their limit
and retain the queued prompt. Ordering remains available through the shared queue.

Claude corrections retain independent SQLite receipts, an opaque provider input
UUID, complete text/images and frozen reply context. They enter the original
query at priority now, with original-operator and active-command checks repeated
immediately before stdin. Only an exact ACK from the same non-retired native
query confirms delivery; its ACK is consumed before ordinary result correlation.
The first HTTP action waits briefly for this ACK. Silence remains uncertain;
checks read the original receipt and never resubmit after restart or turnover.
Only the original command result releases its successor. Collision checks and
reply capture share a transaction; ordinary admission cannot reuse a correction
identity. Receipts are deleted with their owning session.

The pictured session's exact ID/runtime/button state was not supplied by the
public snapshot tools available to this task. The Codex-only UI gate is verified
in source; attributing that specific incident to it remains unproven.

## Validation record

- Accepted SDK child-recovery integrations retain child output when each native
  query retires while the joined conversation iterator remains open. A trusted
  host event marks unresolved children unavailable before admitting a successor;
  provider JSON cannot impersonate that boundary. Real-wrapper regression tests
  cover both SDK adapters, post-terminal iterator failure, successor input and
  cancellation without duplicate outcomes or result correlation changes.
- Test-first: ten compact tray/composer regressions initially failed on the old
  popup and missing order controls. Two queue-hook tests additionally reproduced
  crossing an unconfirmed dispatch and overwriting a different row identity.
- Final integrated UI run: 107 passed across eight tray, persistence, ordering,
  composer status and steering/recovery suites. Earlier focused coverage also
  passed direct-correction and receipt tests. A further regression reproduces
  failed Make next persistence, explicit recovery and a later text save; all 12
  focused tray/persistence tests pass after retaining the changed position
  throughout recovery.
- Review regressions also cover retaining edited text during Make next, guarding
  row switches during editing, pending context receipt checks, and retrying the
  actual failed IndexedDB write rather than only flushing its failed receipt.
- Final runtime run: 111 passed across six resolver, steering-route, queue-control
  and SDK suites. New tests exercise real SDK wrapper/ordinary command consumers, exact
  ACK correlation, revocation, stale targets, restart and same-runtime query
  turnover, identity collisions, reply metadata and image payload checks.
  The native SQLite addon was restored from the installed build. A separate
  Claude fixture still attempts to inspect a policy-denied account path; that
  suite remains a CI obligation rather than runtime qualification.
- Package TypeScript builds passed. Full frontend/server TypeScript checks
  exhausted the required 1 GiB local heap; neither is recorded as passing. The
  server dependency check also exceeded this limit. Hosted compile checks remain
  required.
- Updated offline browser fixture preserves the existing steering, attachments,
  receipt, reply and ordering journey, checks inline queue placement and minimize,
  and selects the new inline editor region instead of a dialog.
- Browser execution and screenshots remain pending CI: the preceding mockup
  attempt failed macOS Chromium process registration. The failed launch was not
  retried, no browser binary was substituted, and no production/staging target
  or real model calls were used.

Record subsequent checks and CI in the PR. Production activation is outside this
change; a PR and passing mocked callbacks do not establish deployed runtime support.
