# Mitzo: desktop design, existing UI, and implementation effort

**Existing PR designs:** `mitzo-existing-chat-designs.md` records #456, #457/#462 SessionTray and #446 Symposium. Preserve these surfaces; its corrections supersede earlier generic source/composer sketches.

7 September 2026 · supplements and corrects the earlier design handoffs

## Effort and recommended scope

Planning estimate: **15–25 engineer-days (3–5 engineer-weeks) for a production-quality desktop and mobile UI redesign that reuses current workflows.** This is effort, not a delivery commitment. One engineer working full-time would need roughly that elapsed time, plus any external review/deployment delay. AI assistance is assumed as part of the working method; it does not remove integration, review and validation work. The repository has now had a targeted read-only inspection, not a complete implementation audit.

Budget the work approximately as follows:

- Existing-screen inventory and design-to-component mapping: 2–3 days.
- Shared navigation, layout, styles and Today: 4–6 days.
- Adapt existing Chats, TELOS/task views, agent board, Inbox, Calendar and settings: 6–10 days.
- Cross-screen integration, accessibility, responsive fixes and release verification: 3–6 days.

Those ranges sum to 15–25 engineer-days. Tests accompany each implementation slice; the final verification allocation is for cross-screen behavior and release checks, not postponing all testing to the end. Follow the repository's test-first and branch/PR workflow when implementing.

An early useful release—shared shell and Today with existing destinations retained—can plausibly land in **4–7 engineer-days**, included in the total above. This is the sensible first milestone. Preserve message rendering and backend behavior during that slice.

The full proposal is bigger than a visual redesign. If reliable goal-to-execution attribution, cross-provider usage reconciliation, new source authorization flows, new per-agent lifecycle controls and cohort-aware efficiency must also be built, provisionally allow **another 15–30 engineer-days**. Combined envelope: **30–55 engineer-days, approximately 6–11 engineer-weeks**. This is conditional, not a claim all that infrastructure is missing. The inspected repo already has goal reporting, authentication, task orchestration and workflow pause/resume; reuse them before estimating new development.

The next estimating step is a 1–2 day audit within the inventory allocation: enumerate existing routes, source-account providers, message states, goal IDs, usage reporting paths and test coverage. Produce an issue list with “reuse / adapt / genuinely new” labels, then replace these ranges with estimates per issue. Do not price 34 prototype states as 34 separately implemented pages.

## Desktop layouts now supplied

`mitzo-desktop-design.html` contains eight navigable desktop compositions:

1. Today: persistent navigation rail, briefing/focus in the primary column, recent work and tomorrow’s schedule in a narrower secondary column.
2. Chats: session list and conversation side by side. Keep the established renderer and composer, adding goal definition/association controls around them.
3. Inbox: requests/updates list with adjacent request detail and draft editor.
4. TELOS: priority and goal list with a selected-goal inspector for outcome, acceptance and token scope.
5. Agent taskboard: three simultaneous sample state lanes with an execution inspector. At wide desktop widths the inspector sits to the right; at narrower desktop widths it sits below the lanes without covering them.
6. Calendar: day agenda beside selected-event context and saved notes.
7. Connected accounts: provider list and selected account/access details.
8. Efficiency: primary outcome efficiency and guardrails beside secondary consumption scopes.

Default app content widths should remain readable rather than filling an ultrawide screen with stretched text. In the prototype, the rail is 164px, main padding 24px, and content at large widths caps at approximately 1280px. At 1300px and wider the board inspector moves to the right. At intermediate widths secondary content moves below the main content. Below 620px this desktop demonstration stacks; the dedicated mobile prototype remains the reference for mobile navigation. Production should share components, data and routes across breakpoints.

These are designed desktop compositions, not screenshots of the current running app. All data is illustrative. The chat has been revised after source inspection to show known content categories, but a final visual comparison against the live chat remains part of the inventory task.

## What already exists in Mitzo

Read-only inspection of the local repository at commit `2854520` found the following. No source changes or deployment were made.

- `frontend/src/pages/DesktopChatView.tsx` already uses a three-part `DesktopShell`: `SessionPanel`, chat center and `CommandCenter`. Reuse this structure rather than inventing another desktop app shell independently.
- `frontend/src/components/ChatArea.tsx` renders finished and streaming turns through `UserBubble`, `TextBubble`, `ThinkingBlock`, `ToolPill`, `ToolGroup`, `ProgressWidget`, `SessionBanner` and `PermissionBanner`. It also handles near-bottom streaming scroll behavior, session restore and per-block voice playback.
- `frontend/src/components/MessageBubble.tsx` supports GFM Markdown, highlighted code, copied code/text, horizontally scrollable tables, images, context labels, timestamps, file links, Markdown file previews, sharing, read-aloud and collapsing long completed responses.
- `frontend/src/components/ToolPill.tsx` retains raw tool inputs, command/code/diff previews, tool results and result images, file navigation, tool error/running states and nested `SubagentCard` content.
- `frontend/src/components/ChatInput.tsx` has skills, image/context attachments, worktree/session identity, queued-message controls and `TokenBar`. Desktop also has account/model selection, Ask/Agent/Auto modes, session close and voice settings.
- `frontend/src/components/TokenBar.tsx` already separates current agent context from cumulative session tokens, with turns and compactions in details. Context occupancy must remain distinct from lifetime spend and from goal totals.
- `frontend/src/pages/TaskBoard.tsx` treats root tasks as candidate execution goals, maintains a hierarchy and exposes tree/attention ordering, workflow creation, spawning, review/approval and loop controls. A Kanban-style view must not discard these capabilities or imply that hierarchy no longer exists.
- `frontend/src/components/LoopControls.tsx` already implements workflow start, pause, resume, stop and spec review. The first redesign should restyle/reposition those controls. A new independently pausable agent-run API is not assumed.
- `frontend/src/pages/TodoDetailView.tsx` already has Open in Chat and Promote to Tasks. Promotion calls `/api/workload/items/:id/promote`, then opens the resulting task on the taskboard.
- Existing Mitzo sign-in is passphrase-based (`frontend/src/pages/Login.tsx`, `server/auth.ts`), not the SSO placeholder shown in the early mockup. Keep the actual method unless a separate auth change is requested. AI provider account selection in chat is also distinct from connecting source services such as Jira or Calendar.

## Preserve the conversation renderer

The initial simple chat bubbles were an incomplete design abstraction. They are not a replacement specification. Keep the existing message protocol, streaming state, block rendering, attachments, file interactions, permissions, voice, queue/interrupt behavior and token display. Improve spacing, color hierarchy, content width and the placement of controls around those components.

Do not flatten a rich assistant turn into one text bubble, remove tool evidence to make the screen quieter, hide permission questions inside collapsed history, or replace live tool status with a generic “working” indicator. Keep expandable detail and make the summary readable. Render only actual provider-supplied thinking/redacted-thinking content; do not fabricate reasoning text for the mockup or implementation.

At minimum, the implementation regression matrix should include: long Markdown, code/table overflow, file-preview links, images, streamed text, streamed tools, completed grouped tools, nested agents, progress items, permission questions, redacted-thinking blocks, queue/interrupt, reconnect/restore, voice and the distinct context/session token counters. Use the existing tests as the starting point.

## Chat → defined goal

The user stays in the same conversation. Goal definition is an outcome contract attached to that work, not a new chat mode.

Recommended UX:

1. **Chat freely.** A factual question or exploration does not require a goal form or a workflow start.
2. **Make the outcome visible.** The conversation header offers “Define goal” / “Define done.” Mitzo can suggest a title and success criteria as part of an existing assistant response when a concrete outcome emerges. Do not add a separate inference call on every keystroke or message solely to classify goal intent.
3. **Review inline.** A compact editable panel shows the proposed title, “Done when” criteria, and optional association to an existing TELOS task/goal. The primary action is “Save goal definition”; secondary is “Keep chatting.” Desktop can keep this next to/in the thread; mobile uses an inline panel or sheet with the draft preserved.
4. **Keep context and usage.** Saving retains the session ID, transcript, worktree, message draft and relevant usage history. The linked goal becomes discoverable from TELOS. Opening it from TELOS returns to the same work.
5. **Choose execution separately.** Defining a goal does not silently start a workflow, spawn agents, change Ask/Agent/Auto mode or grant permissions. If the user already explicitly requested execution, preserve that authorization without asking again. Otherwise provide a separate Start workflow action using existing orchestration.

If the user explicitly says “Create a goal to X, done when Y,” there is no need for redundant confirmation of the same values. Save the authorized definition and show an editable confirmation. Ordinary “Can you fix X?” is authorization to do that work, but the app should avoid automatically promoting every incidental message into a separate visible planning item.

## Existing automatic goal records change the implementation

In `server/query-loop.ts` around lines 543–550, the SDK path automatically requests a ContexGin registry goal from the initial prompt. `deriveGoalTitle()` in `server/goal-client.ts` uses the first sentence or a truncated title; this is not a verified success criterion. Around lines 603–640 the result handler stores the resolved goal ID and submits usage deltas. Existing resumed-session metadata can restore a registry goal ID.

Therefore, **look up the existing association before creating anything**. Where an automatic registry record exists, Define goal should enrich/link that record. “Suggested” or “not yet defined” is proposed presentation metadata; it is not claimed to be a currently implemented registry status. If the registry is unavailable, preserve a pending definition/link operation and existing local usage, with a retryable state. Do not claim goal accounting is complete just because a local form was saved.

Registry goals and taskboard root tasks are not proven to be interchangeable IDs. The inspected code has registry `goalId` metadata, taskboard root goals, workload item promotion, and `telosTaskId` links. The implementation needs an explicit mapping and idempotent create/link/update operations. The frontend must not assume a registry ID can be passed directly to `/api/loop/start` as a task root ID.

The auto-create/report behavior was verified in the SDK query loop. Equivalent behavior across the Codex and Responses session implementations has not yet been established. Provider parity is part of the audit, not a completed finding.

## Tokens before the goal is defined

Tokens used understanding and defining the outcome belong in tokens to goal when attributable to that work. Defining the goal must not reset the counter and make later definition appear more efficient.

For a single-purpose session, retain its existing usage association from the start. If a session contains unrelated work, preserve total session spend and offer a clear attribution boundary or separately mapped contributions. Do not silently assign the whole session to a new outcome. The current session-level contribution approach means precise turn-range reassignment may require additional backend work; it should not be promised as a free UI feature.

The accounting layer must normalize provider fields correctly. Cached-read and cache-creation counters can be separate from a provider's ordinary input count, while the UI's normalized input total should include all consumed input once. Preserve raw counters and normalize them; do not blindly apply a “cached is always already included” assumption to raw provider usage.

## Scope correction for the first release

Keep the existing message renderer, authentication, task hierarchy, execution loop and provider controls. Ship the shared design, Today, and the desktop/mobile arrangements around them. Treat goal-definition linking and reliable accounting as a focused follow-up after verifying the two goal systems. Treat new source connectors and per-agent controls as separately scoped features only if existing implementations do not support them.

## Desktop prototype validation

Eight desktop compositions were checked in light/dark themes at 320, 736, 1024 and 1440px. Goal-definition save preserves the displayed session usage; conversation selection, goal detail selection, taskboard selection and simulated workflow pause/resume, account authorization handoff, calendar and Inbox switches passed. No script errors, duplicate IDs or horizontal page overflow were detected. Today, taskboard and conversation layouts were visually inspected. This validates the design demonstration, not production behavior or backend integration.
