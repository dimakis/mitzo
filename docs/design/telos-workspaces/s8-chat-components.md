# S8 ordinary chat presentation components

Slice `b47a0c568f1d98ba`, parent `85e8444019a4ae4a`. Independent implementation
began on accepted Mitzo `4bac7e8f`. The frozen mock remains artifact
`9d0559132154b92d0bbb427a982a0002@r1`, SHA-256
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab` (verified).

`TelosChatList` consumes the accepted `TelosWorkView`. A single projection owns
the unique conversation count and rows, merging role links and reviewed source
snapshots by namespace/conversation identity. Only current assignments produce
Assigned lead/worker labels. Unknown and unavailable conversations remain visible.
Source inspection must use the existing reviewed-source opener. The list makes
no API writes, settings changes or allocations; its callbacks delegate to the
ordinary setup owner. New chat and assignment replacement have separate callbacks.

`telosDirectChat` permits direct entry only when the complete list contains exactly
one available ordinary non-origin chat. Multiple conversations always require a
choice. Origin-only items retain source inspection and explicit role setup.

`TelosChatFrame` accepts the existing ordinary header and transcript/composer as
slots. It adds one slim item/chats/work row. The tree starts closed, resets on conversationId changes without remounting its slots, shares
`MotionPresence`, and restores the trigger's focus on Close/Escape. Desktop gives
the transcript its full column when closed. Below 48rem of available width the
tree temporarily hides the mounted transcript; closing reveals the same composer.
The 20rem tree column is reading geometry, matching the existing Telos brief.
Styles apply only to Telos controls, leaving slotted ordinary controls intact.

## Evidence and remaining adoption

The first implementation artifacts were failing component tests. The checks and
inspected screenshots are in [the evidence record](../../evidence/telos-s8-components/checks.json).
Six intercepted browser scenarios cover 320px WebKit/Chromium and desktop Chromium,
dark Mint/System and light Teal/Georgia with enlarged text, keyboard focus, tree
width recovery, selection/Back and reload. They use the actual `ChatArea` and
`ChatInput`; worker and reviewer retain independent drafts using the existing
ordinary draft store. The fixture performs no backend/model calls.

This PR deliberately has no production call-site adoption. S5b's ordinary workspace
contracts and Symposium's shared header/page changes were still unaccepted at
start. Preserve their owners; adopt these slots in their combined accepted source.
The fixture's account labels and Awaiting review/P7 text are synthetic. They do
not verify real account/runtime settings, reconnect execution state or priority.

Remaining CT15/CT16 work: wire the actual item Chat tab and ordinary route Back;
use the existing source opener and role setup for distinct New chat/replacement;
load authoritative human chat titles and account/model/target metadata; subscribe
to current links/assignments and reconnect refresh; adopt the actual work tree
and accepted priority/execution projection; exercise repository-backed and non-code
journeys through full `ResponsiveChatView`, including Resources, Access, settings,
voice, attachments, commands and queued/interrupt/stop behavior. Keep the ordinary
renderer and per-conversation settings/draft owners. Pass the actual ordinary conversationId so its disclosure resets on route changes;
do not remount the composer for a tree toggle.

Both CT15/CT16 and S8 remain open. Full build/browser CI, exact-head review and
dependency acceptance remain separate from this component evidence. No staging,
live target, model call, production change or merge is authorized by this increment.

## Bounded Centaur corrections

Review `5565480763` on `f21eab11` identified two blocking defects. Both have
test-first corrections with [retained red/green evidence](../../evidence/telos-s8-components/review-corrections/checks.json).
Valid external Codex origins can delegate their retained URL to `onOpen` after an
explicit click, including when ordinary availability is unknown. Ordinary direct
entry remains restricted to an available Mitzo non-origin conversation. This reuses
the existing `TelosItemSources` external-inspection contract; it grants no assignment.

During normal-motion tree exit, the retained inert panel is positioned outside grid
flow at the same top/end edge, bounded by the transcript height. Closing restores
the transcript column without adding a temporary second row or scroll height.
Shared `MotionPresence` and its tokens remain unchanged. Six new normal-motion
scenarios sample the actual WAAPI exit at three points on all browser projects,
in light/dark, alongside the six original reduced-motion scenarios. They verify
layout, focus, unmount and the same mounted ordinary composer/draft. All 125 focused
checks pass (one existing design skip), as do all 12 browser scenarios plus two
startup checks. Exact-head trusted review must still verify both CEN findings.

Accepted Symposium source is now `3882cd217daad3e61e3642f84f7377c1d2caef52`.
Its shared `ConversationAgents`, mobile/desktop header and source-link owners were
inspected through that Git ref. This correction does not adopt or rebase those
changes. S5b and its remaining WebKit dependency were unaccepted at handoff; full
ordinary/non-code integration remains open. The original evidence above retains
its historical base and scope.
