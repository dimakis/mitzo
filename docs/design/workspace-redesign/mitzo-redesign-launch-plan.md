# Mitzo redesign: TELOS launch plan

8 September 2026 · approved implementation handoff; TELOS records created

## Recommended structure

One parent TELOS item for the redesign, four ordered delivery items, and one separately linked goal-accounting follow-up. Reuse the existing Symposium and SessionTray workstreams. Do not create a new implementation session per mockup or per screen state.

### Parent: Mitzo — ship a coherent desktop and mobile workspace

Outcome: Mitzo helps the user choose and resume useful work through a consistent Today, chat, work and settings experience while preserving the existing rich conversation, provider controls, sources/outputs and token visibility.

Done when:

- The four delivery items below have landed through tested PRs.
- Desktop and mobile navigation and screen layouts follow the accepted design, reconciled against actual current behavior.
- Existing streaming, message blocks, permissions, queues, attachments, source/output resources, account/model controls and token counters still work.
- TELOS and agent workflows remain inspectable and operable, including existing tree/review controls.
- Navigation, filtering, opening resources and manual editing introduce no new model calls.
- A final smoke pass covers desktop, narrow mobile and the supported iOS path, with any device testing gaps explicitly recorded.

No redesign of provider execution, authentication architecture or task scheduling is required by this parent. New connectors and complete Symposium runtime delivery are not implicit scope.

### Delivery 1: Mitzo — shared shell and Today

Priority: first. One implementation owner; one isolated worktree based on verified current main.

Scope: shared design tokens/primitives, desktop rail/mobile navigation, responsive content layouts, time-aware Today, up to three focus items, recent work and Ask Mitzo entry. Existing destinations remain usable through navigation.

Done when:

- Today works at desktop and mobile widths in light/dark themes.
- Focus and resume actions open the correct existing records/sessions.
- Existing token counters remain reachable; optional Home visibility is presentation only.
- The greeting/time bucket and routine navigation do not make model calls.
- Existing rich chat, provider/toolbars and task controls are preserved; no parallel replacement of their internals.

Test-first: responsive shell/navigation regression tests and relevant Today behaviors precede implementation. Commit tests and code together; open a focused PR and run required checks.

Dependencies: approved design package and current-main inventory. Does not wait for complete Symposium or goal accounting. Include any necessary design-token additions in this PR rather than spinning up a competing global-CSS owner.

### Delivery 2: Mitzo — adapt chat around the existing renderer and SessionTray

Scope: desktop session-list/conversation composition and mobile presentation; preserve the actual ChatArea/ChatInput, account/model/reasoning controls, permissions, queue/interrupt, voice and tokens. Integrate/restyle the current SessionTray implementation.

Done when:

- Outputs and Sources follow #462 or its verified landed successor, including consolidated attachment/context controls.
- No duplicate composer attachment/context controls are restored.
- Rich message blocks, streaming, replay/reconnect, code/file previews, tool results and nested agent activity retain their behavior.
- Context occupancy, session spend and any available goal spend are labeled by scope.
- The design supports the existing Symposium task's Add reviewer / seat controls without claiming the runtime is complete.

Test-first: extend existing ChatArea, ChatInput, SessionTray, PermissionBanner and DesktopChatView coverage as needed. Preserve existing cases rather than replacing them with mock-only tests.

Dependencies: Delivery 1. Coordinate against the session tray's latest PR/main status immediately before editing; do not rebuild #457's obsolete stacked implementation. Existing model/reasoning changes are integration inputs, not a second model-picker feature.

### Delivery 3: Mitzo — TELOS and agent taskboard presentation

Scope: clarify priorities and next steps in TELOS; add the desktop board/inspector composition and mobile state sections around existing task and loop data.

Done when:

- Goal/task detail retains hierarchy, source context, next action and existing associations.
- Agent work shows actual state, dependency/human-review reasons, execution context and measured token counts.
- Existing tree/attention views, review approval, workflow start/pause/resume/stop and spawning controls remain available.
- Task completion is distinguished from verified goal achievement.
- No fabricated percent complete, new per-run pause semantics or new scheduler is introduced by the visual work.

Test-first: TaskBoard/TaskNode/LoopControls behavior and responsive inspector/navigation checks. Wire supported actions through existing APIs.

Dependencies: Delivery 1. Delivery 2 need not block every component here, but coordinate shared shell/style changes through one owner. Default to sequential PRs unless there is a clear, non-overlapping second work package.

### Delivery 4: Mitzo — proposals, Calendar and account/settings presentation

Scope: bring remaining collections/details into the shared design while labeling actual behavior accurately.

Done when:

- The current proposal-file Inbox is presented honestly: no unread semantics without a real read state, no “Approve” label that implies execution if the action only archives.
- Review in session is the natural path for a proposal; Archive means archive.
- Calendar agenda and event details preserve source links, existing controls and freshness.
- Mitzo sign-in, AI provider account/model selection and source-service connections remain distinct.
- Settings expose token visibility and existing preferences without inventing unsupported source connectors.

Test-first: preserve existing Inbox/Calendar/auth behavior and add tests for changed labels/routes. Verify file archive semantics before changing the action label. Do not move or archive the actual user's proposals as part of this redesign task.

Dependencies: Delivery 1 and reconciliation with the existing Inbox findings. New source authorization capabilities are separate work if absent.

### Linked follow-up: Mitzo — define goals in chat and make tokens to goal trustworthy

Separate scope from the visual release. First inspect existing registry IDs, task root IDs, session associations and cross-provider usage reporting.

Done when:

- Define done enriches or links existing work without duplicate registry/execution goals.
- The same conversation, transcript, worktree and attributable prior usage are retained.
- Mapping between ContexGin registry goals, TELOS/workload items and taskboard execution roots is explicit and idempotent.
- Missing/late usage is visible and recoverable; provider counters are normalized without double counting.
- Active work shows tokens spent; final tokens to goal requires established completion evidence.
- Symposium and other delegated usage roll up exactly once when those capabilities are present.

Do not hold the new Today release hostage to the full accounting implementation. Preserve current counters from day one; deliver stronger attribution through this linked follow-up.

## Existing task ownership and sources

Task state was read on 8 September 2026. These are coordination references, not instructions to restart, interrupt or archive any task.

- **Redesign FE homepage** — this task (`01a07db5-8cb9-7871-9607-e454684d3518`): accepted visual direction and design/implementation handoff.
- **Design Mitzo symposium UX** (`01a07b9b-63ca-7771-96f4-6dbeb03f1c48`): existing detailed Symposium product design. Its recent guidance is more complete than #446's protocol-only description and supersedes this task's generic Set up symposium sketch for implementation.
- **Add this to Mitzo** (`01a07b88-01ac-7cc3-bbc3-1f0ee0643399`): existing SessionTray work; preserve its PR ownership rather than opening another tray implementation.
- **My inbox in telos gives me the creeps** (`01a07e08-cc4d-77f2-b665-26a61ec820a3`): findings about the proposal backlog, absent read state and archive-only Approve behavior. Verify against current code when implementing Delivery 4.
- **Improve Mitzo homepage and images** (`01a07ddf-d67b-7750-806c-2ae284ac7a9b`): despite its title, the latest user clarification explicitly narrowed it to models/thinking/images and left homepage design alone. Do not assign it a duplicate homepage remit based only on the title.
- **Audit Mitzo for demo readiness**: use relevant findings as acceptance inputs, not a second concurrent owner of the same frontend files.

No messages were sent to these tasks, and none were restarted or archived in preparing this plan.

## Symposium reconciliation

The existing **Design Mitzo symposium UX** task calls for a focused Add reviewer flow in the same work session, a seat catalog, explicit profile + connection + model binding, controlled context packages, read-only review, structured findings, delta re-review and conversational profile creation. It warns against exposing every mode/account/authority control in the composer.

Use that as the Symposium feature definition. Our basic two-seat mock demonstrates placement only. In particular:

- Prefer Add reviewer / Ask another agent over the abstract Set up symposium action.
- A saved profile excludes credentials, transient paths, transcript and session-specific authority.
- Independent review uses a selected context package by default, not the entire builder conversation.
- Preserve original and delivered versions when interception edits a response.
- Re-review only relevant changes where possible; meter both seats and orchestration against the goal.

This existing feature stream should be linked to the redesign parent, not recreated as four more TELOS items from the mockup.

## Starting execution without creating more session sprawl

Keep TELOS as the durable outcome/dependency record. Use the taskboard for the current executable slice. Promote or link Delivery 1 once, check the resulting ID, and reuse it on retries. The inspected promote endpoint can create a new task root for a TELOS-only fallback, so check for an existing link/root before invoking it again.

One implementation task owns one delivery slice and its PR. Start only Delivery 1 now. Use a clean isolated worktree from current main; do not use the checkout previously reported as having missing tracked files without checking its state. Do not send the full discussion transcript to every coding session.

The approved handoff is versioned in this directory through a prerequisite docs PR. Delivery 1 has a pending taskboard root; use the recorded IDs in README.md rather than promoting it again.

Each implementation handoff should contain only:

- Its exact scope and done criteria.
- Canonical design references and relevant source components.
- Known PR dependencies and explicit behavior to preserve.
- Validation requirements and the resulting PR/commit identifiers.

On completion, record the PR, checks, remaining issues and measured session token usage back against the item. One parent progress update is enough; avoid multiple planning tasks retelling the same history.

## Ready-to-use first implementation brief

Implement Delivery 1, “Mitzo — shared shell and Today,” in the Mitzo repository using a fresh isolated worktree from verified current main. Read AGENTS.md and follow its test-first, branch and PR workflow. First reconcile the existing shared shell/navigation and SessionList/Today entry points with the approved designs. Use the versioned handoff in this directory as the design source. Build the shared desktop/mobile presentation and Today while retaining existing routes and behavior. Preserve rich ChatArea/ChatInput, account/model/thinking controls, sources/outputs work, task orchestration, authentication and token counters. Do not implement a new Symposium engine or redesign goal accounting in this slice. Check current PR dependencies before editing overlapping frontend files. Deliver a focused PR with appropriate tests/builds and desktop/mobile visual validation; do not deploy automatically.

## Canonical handoff files

- `mitzo-redesign-launch-plan.md` — this work breakdown and current cross-task corrections.
- `mitzo-desktop-and-implementation.md` — code-grounded reuse findings, desktop layouts and effort envelope.
- `mitzo-existing-chat-designs.md` — PR references for SessionTray and Symposium protocol. Read with the fuller Symposium task guidance above.
- `mitzo-design-spec.md` — original layout and accounting requirements, subject to the corrections above.
- `mitzo-screen-designs.md` — broader screen behavior.
- `mitzo-desktop-design.html` and `mitzo-design-preview.html` — interactive design demonstrations; not production frontend code.
