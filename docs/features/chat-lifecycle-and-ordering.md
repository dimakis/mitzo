# Hidden conversations and calmer ordering

Requested by Dimitri on 13 November 2026 in conversation
`526e3840-74f0-8343-a473-5f8455eb4b5e`, including the instruction to incorporate
and supersede PR #1307. This branch includes that PR's complete ordering,
grouping and reply-read implementation, integrated with current main.

## Behavior

- **Hide conversation** is available from the existing sidebar/library action
  menus and phone previews. It retains history and resources. A merged PR is a
  useful reason to hide a conversation; it never authorizes automatic cleanup.
- **Hidden chats** is available beside sidebar filters and in Chats options.
  It pages through retained hidden history. Opening a preview does not attach
  to a provider, allocate a workspace, run a model or clear a removal fence.
- **Restore chat** unhides an otherwise retained conversation. An existing
  resource-removal record requires recovery review instead of silently restoring
  admission. HTTP mutations preserve operator authentication and same-origin JSON.
- **Review resource cleanup** opens the existing coordinated removal dialog.
  It keeps its stop/settlement, fresh ownership/recovery checks, explicit deletion,
  uncertain-operation recovery and auth-revocation fences. Hiding itself grants
  no cleanup authority.
- **Continue in new chat** saves an editable draft with the source conversation
  ID and the exact previewed excerpt (up to three recent text messages, 12,000
  characters each). Earlier messages, tools and attachments are explicitly omitted.
  The agent is told that previous resources may have been released and to verify
  current state and prepare a fresh isolated workspace through ordinary admission.
  The new chat chooses its own account/runtime; nothing is sent automatically.
- Both collections promote one row at a time with a shared 1800ms reorder token
  and at least five seconds between moves. Labels remain live. Pointer, scrolling,
  keyboard, search, menus and dialogs retain the existing browsing holds. Reduce
  Motion remains authoritative. Active view's Show latest controls its displayed
  queue, and detached nested scrollports no longer hold the list forever.

## PR #1307 review findings

The six blocking findings on its retained head `c4536e00` were reproduced and
addressed here: carry live message_end sequences through parser/reducer; separate
acknowledgeable reply sequences from synthetic error anchors; share the Active
sidebar ordering queue; prune detached nested scrollports; hydrate off-page pinned
read state with coalesced reads and visible failures; and match JavaScript's full
whitespace predicate in both SQLite reply selection and its index. Existing
read/unread actions, grouping, drafts, status ownership and appearance remain.

## Limits and verification

Local cleanup still preserves protected worktree bytes: retirement is not disk
reclamation. Linked/external/uncertain workspaces remain protected. Reference-aware
expiry, actual local byte reclamation and sustained-use acceptance remain part of
the existing cleanup outcome `769f3f8d8e9be028`; this UI does not claim them delivered.
Continuation creates a new conversation with an explicitly bounded handoff, rather
than claiming to revive a released provider checkpoint in place.

Reused patterns: conversation rows, SessionActions/SessionContextMenu, HomeDialog,
SavedSessionHistory, shared secondary actions, MotionList and semantic motion tokens.
The approved design ledger retains prior revisions and records the explicit
incorporation of #1307's unread-marker change.

Offline test-first evidence includes the real EventStore and HTTP visibility
router, retained history/admission fences, hidden-dialog failures/continuation,
both ordering queues, parser/reducer live receipts, whitespace and synthetic-error
replay. The combined core run passed 251 checks. A separate 83-check review-fix
run includes 67 source-qualification checks; later targeted hiding and actual
parser/reducer-to-ChatArea consumer checks also pass. Design checks pass 109 with
one existing skip; changed-source ESLint and source-artifact verification pass.

The shared package TypeScript build passes. The full frontend build exceeds the
required local 1 GiB heap and remains CI acceptance. The all-intercept browser
suite discovers its mobile/desktop, light/dark history, restore-failure and cleanup
fixtures, but macOS denied browser Mach service registration at startup even
through the approved bounded executor. No fixture ran and no rendered capture
was inspected. Do not claim visual acceptance until CI supplies that evidence.
No production activation, live model call or actual resource deletion occurred.

## Combined-main integration

PR #1340 supersedes the now-closed #1307; its branch and review history remain.
GitHub reported an actual manifest conflict after #1333 landed on main as
`f850dcc2`. Integrated that accepted change, preserving its deliberate sharing
controls and this feature's read boundaries. The combined candidate passed 161
focused chat, prompt-context, receipt, hidden-history and design checks, with one
existing skip. Runtime source inventory advanced to
`v1.0.1126-chat-lifecycle-integration`. Full CI and exact-head Centaur review remain
separate delivery evidence.

## Landing verification

Dimitri authorized merging #1340 only after Claude sign-in fix #1336 is accepted.
The first CI candidate passed compile/source preflight and frontend builds, then
exposed a desktop menu regression: asynchronous read/pin diagnostics increased
its height after the one-time viewport placement, hiding the final action. The
retained browser trace confirms the failure. The menu now observes its rendered
size and repositions on changes; a regression covers the actual read-failure and
retry path, geometry correction and observer cleanup. All 31 related menu,
preview, library and sidebar unit checks pass. Full browser verification remains
required on the final combined candidate.

CI now retains the hidden-history and guarded-cleanup screenshots in its existing
responsiveness artifact; previously their filenames were omitted from the upload
patterns. All 30 focused workflow/gate checks pass. The reviewed source inventory
includes these changes at `v1.0.1128-chat-menu-resize`.
