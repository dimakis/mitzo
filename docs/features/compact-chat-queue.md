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
spacing/type/control tokens and the existing IndexedDB-backed queue. It adds no
new palette, font preference, modal or backend admission route. Storage flush
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

Steering and recovery continue through their existing runtime owners and checks.
The queue now shows the actual unavailable reason instead of a disabled unexplained
lightning button. Main at `f7a474ea9` still enables native turn steering only for
bound Codex chats. Bound Claude SDK steering is **not added by this UI change**.
PR #1310 supplied related Local Claude/Codex peer-runtime work and was accepted as
`94b60f4f8fffd0f319bebbae00a4f7fa1b5f6faf` on 12 November 2026. Full native Claude
user steering remains a separately unfulfilled runtime requirement; peer-message
support alone does not prove the user-composer path. No unsupported route silently
falls back to Stop, replacement admission or a different turn.

## Validation record

- Test-first: ten compact tray/composer regressions initially failed on the old
  popup and missing order controls. Two queue-hook tests additionally reproduced
  crossing an unconfirmed dispatch and overwriting a different row identity.
- Focused unit run: 130 passed across compact tray, existing save-ownership,
  queue persistence, order fencing, composer status, direct corrections and send
  receipt coverage. A further regression reproduces failed Make next persistence,
  explicit recovery and a later text save; all 12 focused tray/persistence tests
  pass after retaining the changed position throughout recovery.
- Review regressions also cover retaining edited text during Make next, guarding
  row switches during editing, pending context receipt checks, and retrying the
  actual failed IndexedDB write rather than only flushing its failed receipt.
- Runtime resolver, steering-route and owned queue-control suites passed 74 tests.
  Two additional suites could not run locally: the native SQLite owner addon was
  absent, and a Claude fixture attempted to inspect a policy-denied account path.
  These failures are retained as CI obligations, not runtime qualification.
- Package TypeScript builds passed. The full frontend TypeScript check exhausted
  the required 1 GiB heap; it is not recorded as passing and remains a CI check.
- Updated offline browser fixture preserves the existing steering, attachments,
  receipt, reply and ordering journey, checks inline queue placement and minimize,
  and selects the new inline editor region instead of a dialog.
- Browser execution and screenshots remain pending CI: the preceding mockup
  attempt failed macOS Chromium process registration. The failed launch was not
  retried, no browser binary was substituted, and no production/staging target
  or real model calls were used.

Record subsequent checks and CI in the PR. Production activation is outside this
change; a PR and passing mocked callbacks do not establish deployed runtime support.
