# S8 ordinary route adoption candidate

This branch joins accepted main `8a7dab62` (including Symposium `3882cd21`) with
the frozen component correction `3f08dd81` from PR #1050. It is an offline
acceptance candidate, not accepted main. #1050 retains its own exact-head CI and
Centaur baseline; this branch does not rewrite that review target.

The real item Chat tab now mounts `TelosItemChatTab`. Multiple conversations
list first with no selection. Exactly one available ordinary non-origin chat can
enter directly on initial entry. A refresh cannot silently select a remaining
chat. Back and the Chats action return to the explicit chooser, including after
direct entry and reload. Collection/item navigation state travels with that return.
External Codex sources use explicit retained-URL inspection; reviewed ordinary
sources use the existing exact-source API. Several retained exchanges require an
explicit choice in Materials rather than guessing a snapshot.

The existing role setup function is extracted into `useTelosChatSetup`, shared by
Overview and Chat. New chat remains `additional`; replacement remains `assign`.
The ordinary draft, runtime/catalog, review and allocation owners are unchanged.
Session names come from the existing catalog; profile/account/model/target display
comes from identity-checked metadata with at most four concurrent reads. Unknown
metadata stays unavailable and does not change availability or assignment.

`ChatView` and `DesktopChatView` now mount `TelosChatRouteLayout` around their
existing headers and ordinary transcript/composer. Association lookup validates
the selected item against the current conversation's recorded links. An explicit item selector or identity-checked bound role metadata selects the
association to validate. Unrelated ordinary chats do not issue a work-link lookup;
several associations are never arbitrarily selected. The existing item context
disclosure remains, with its duplicate item link suppressed only once the valid
slim item/chats/work row has hydrated. The approved Settings and Access owners
remain in the original header. The composer stays mounted during async hydration,
tree toggles and reconnect refresh. Ordinary unlinked chats retain their layout.

The initially closed tree reads the actual canonical record collection and exact
attempt/task associations. It reuses `TelosOutcomesTree`, accepted priorities and
role-row refresh. Pending review displays Awaiting review; task done remains a task
fact, separate from the outcome's canonical status. Source capture, worker readiness
and returned work do not mark the outcome completed. Connection transitions,
visible resume and existing work/session events invalidate the appropriate reads.

## Evidence

[Checks and captures](../../evidence/telos-s8-adoption/checks.json) retain the real
red failures and green results. The six full-route scenarios use the actual
`TodoWorkspace`, `ResponsiveChatView`, `MobileShell`, `DesktopShell`, client store,
API clients, metadata/settings, Resources, renderer, composer and draft storage.
Only HTTP/events/runtime effects are synthetic. They cover repository and non-code
records on 320px mobile WebKit/Chromium and desktop Chromium in dark Mint/System
and light Teal/Georgia with normal motion. Worker/reviewer settings differ; opening
Settings or Resources keeps the current chat and unsent text. Chooser/Back/reload,
actual P7 and pending-review task projection are exercised. Event refresh changes
the priority to P8 and the task to done while the outcome stays active and the
unsent draft remains intact. Tree captures wait for normal enter motion to settle. The original twelve
component/motion scenarios remain alongside them. All 144 focused checks and 18
browser scenarios pass locally (plus two browser startup checks; one existing
design skip). Broad compilation and suites remain CI work.

The source still needs exact-head CI/review and combined S5b/native/peer delivery
acceptance. S5b #1048 `688d9a57` has four backend conflicts with the accepted-main
candidate in addition to two frontend composition points. The conflict packet is
retained separately; backend resolutions are not guessed here. Frontend consumer
qualification against those exact S5b interfaces passes 28 focused checks and
12 intercepted browser scenarios plus two startup checks. The original S5b
ordinary-chat fixture is byte-identical to its published source: its write guard
caught an unnecessary links POST, corrected in the product by restricting lookup
to explicit item selection or bound role metadata. Two frontend composition
resolutions and exact fixture hashes are retained in the
[evidence manifest](../../evidence/telos-s8-adoption/s5b-ui-consumer/manifest.json).
This frontend overlay does not establish a complete merged application, real workspace allocation or model
execution. S9 owns the joined HTTP/SSE/outbox/native-fake acceptance chain.

The frozen Telos mock, priority amendment, approved settings ledger/protections,
shared tokens and shared motion implementation remain intact. No live model,
staging, production change, deployment or merge occurs in this work. S8, CT15/CT16
and parent acceptance stay open until their complete evidence is verified.
