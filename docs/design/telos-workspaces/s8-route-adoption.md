# S8 ordinary route adoption candidate

This branch joins accepted main `8a7dab62` (including Symposium `3882cd21`) with
the frozen component correction `3f08dd81` from PR #1050. It is an offline
acceptance candidate, not accepted main. #1050 retains its own exact-head CI and
Centaur baseline; this branch does not rewrite that review target.

The real item Chat tab now mounts `TelosItemChatTab`. Multiple conversations
list first with no selection. Exactly one available ordinary non-origin chat can
enter directly on initial entry. A refresh cannot silently select a remaining
chat. Chooser-entry Back and the Chats action return to the explicit chooser,
including after direct entry and reload. Source-entry Back restores its actual
Overview/Materials or previous-chat snapshot. Collection/item navigation state travels with that return.
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

## Bounded route review corrections

The independent review of the initial route candidate identified three P2 gaps.
Materials and linked-context source entry now reuse the existing source owner’s
validated snapshot selection (`telosItem`/`telosSource`) before validating the
conversation’s recorded association. The inspected item wins over another bound
role. The source URL/snapshot/backend contract remains intact; both existing
source openers carry the original navigation state. Unrelated ordinary chats
still skip work-link lookup.

The chooser and ordinary route refresh through the existing broadcast-stream
connection owner on reconnect. No synthetic work event or visibility change is
needed. Refresh cannot silently select a remaining conversation.

Tree navigation reuses S7’s unchanged history parser/device fallback, extracted
with its owner’s agreement. It reads the current item’s trail, appends that item,
carries the full return state and clears the stale item snapshot. Explicit empty
or invalid trails override device history; only undefined uses the current item’s
stored trail. Item-keyed persistence, collection preferences and artifact/tab
owners retain their behavior.

Real red results are retained for the source selector, SSE-only reconnect,
missing tree return state, and source opener state loss. Final qualification:
199 checks pass with one existing skip, including the existing S7 route/scroll/
output-return suites, source/linked-context tests and runtime artifact registry.
All 18 browser scenarios plus two startup checks pass, including actual filtered
collection → item → chat → tree child → Back → original item → collection, with
stale child history, preserved category/query/profile/scroll state, source-only
Materials entry, retained drafts and broadcast-only reconnect. HTTP, events and
runtime effects remain deterministic fakes.

The original six stale UI pins, the extracted TodoDetailView owner, and the two
source openers are explicitly qualified; the new shared history helper is pinned.
Runtime identity is `v1.0.334-telos-chat-routes`. All other source pins and approved
references/protected tests remain unchanged. Exact before/after hashes and raw
logs are under `docs/evidence/telos-s8-adoption/route-review-corrections/`.

S5b’s production owner has resolved the earlier backend conflicts in candidate
6091 and is composing the frozen route source; that is separate from the earlier
688 frontend overlay. Its composed page hashes/runtime identity need their own
qualification, and S9 must verify the joined candidate. At76, UX17/journey6 coordinator lead setup remained an S6 interface/S8 adapter
gap. The bounded coordinator adapter below addresses UI routing; reviewed
coordinator guidance and the joined native control journey remain unaccepted.

## Coordinator entry adapter after the76 baseline

Explicit coordinator kind now uses the existing backend lead role in the Chat
tab/list, Overview role entry and tree. Choose/Change remains explicit assignment;
New chat remains additional lead and confers no current control assignment. The
tree retains Coordinator display labels and reads only authoritative current
lead assignments. Unknown kind is not inferred. One shared mapping keeps these
four callers consistent; the existing setup/revision owner remains unchanged.

The six pre-fix failures and248 passing checks, actual coordinator/lead setup
route scenarios, source qualification and inspected light/dark mobile/desktop
captures are retained under `docs/evidence/telos-s8-adoption/coordinator-entry/`.
The earlier76 route review stays the baseline; review of this new mapping is a
separate bounded delta. S5b and S6 own V2 host composition and coordinator-specific
mandate/control proof; S9 owns the joined application acceptance. No full UX17
completion follows from this UI adapter.

## Loading Back, actual source origin and viewport parity

The final navigation-only return snapshot is qualified by item, target
conversation/current URL and local app path before the header uses it. Back is
available while metadata is pending; work data, item/tree controls, assignment
and tool authority remain independently validated. Chooser entry returns to the
chooser; source entry restores its actual prior view or chat, including query,
collection state and tab snapshot. Explicit snapshots take precedence over later
stored tab changes; no-explicit-view artifact navigation keeps its remembered tab.

The existing source-follow tests caught a real45px gap after async slim-row
hydration. A viewport ResizeObserver now retains ordinary following only when the
reader already chose it and no retained source anchor owns the position. Source
boundary and manual-scroll assertions remain unchanged. The two artifact unit
fixtures use the same new-Chat isolation seam as the old role entry, preserving
all artifact/retry/tab assertions.

Production9b595892 qualifies311 focused tests (one prior skip) and36 combined
route/source/motion scenarios plus startup checks. Raw red/green evidence and
scoped source fingerprints are in
`docs/evidence/telos-s8-adoption/navigation-return/`. The existing coordinator/lead
setup route suite is separately requalified on that source. Prior76/81af reviews
are retained; loading/source-return/viewport corrections need bounded closure.
No full joined V2/native/coordinator acceptance or final trusted gate is inferred.

The final production9b595892 rerun passes all12 coordinator/lead setup
scenarios plus their startup checks. With the36 combined source/route/motion
cases, the final selected browser evidence covers48 distinct scenarios.
