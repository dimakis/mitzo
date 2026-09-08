# Mitzo: preserve Symposium and SessionTray

**8 September update:** The existing task “Design Mitzo symposium UX” contains a fuller Add reviewer / seat-catalog design. `mitzo-redesign-launch-plan.md` records that design and the task coordination plan; use it instead of treating the generic Symposium preview as the final feature definition.

Source reconciliation · 7 September 2026

## Verified PRs

- [#456 — development Codex lifecycle and durable queues](https://github.com/dimakis/mitzo/pull/456): merged. Owns account/model controls, queue/recovery surfaces and related chat behavior. Preserve these controls in the redesign.
- [#457 — swipeable session resources tray](https://github.com/dimakis/mitzo/pull/457): closed. Its replacement is #462; do not implement from the stale stacked diff.
- [#462 — swipeable session resources tray](https://github.com/dimakis/mitzo/pull/462): open at inspection, head `5b77a05e331a3560fdf06979fec345246ba73fb2`. The PR explicitly supersedes #457. The actual `SessionTray.tsx` was read to confirm its structure.
- [#446 — Symposium Phase 1](https://github.com/dimakis/mitzo/pull/446): open at inspection, head `949237219e740e9bb7d8672a1ff3ce817a9c6dbc`. Contains protocol/session configuration and persistence changes, alongside other branch changes. Its description and protocol diff do not supply a completed frontend design. The Symposium UI shown in our preview is a proposed composition grounded in these fields, not a reproduction of an existing frontend implementation. If a separate approved Symposium mockup exists, reconcile it before implementation.

These statuses are time-of-inspection observations. PR descriptions contain their authors’ validation claims; our design review did not rerun those PR suites or merge/deploy anything.

## Session resources are an existing design

Adopt SessionTray from #462 as a baseline component. It is anchored at the top of the session, with **peek / half / full** states. The current handle is labeled Session and includes a resource count. Opening on mobile covers the toolbar with an opaque tray and supports pointer swipes, Escape and backdrop dismissal. Preserve those interactions and test coverage when changing its styling.

Keep the PR’s visible categories and order:

1. **Outputs**: derived from assistant links, generated images and file-writing tools. These are the session’s produced artefacts. Preserve resource links, previews and stable identity; do not create a second competing artefact list.
2. **Sources**: source references, selected context blocks, draft/pasted images, and boot/session context through the existing SessionBanner and ContextPanel. Attachment limits and stable thumbnail removal behavior remain enforced.

The tray consolidates image/context attachment controls. Do not restore duplicate +image / @context actions in the composer simply because an earlier redesign sketch showed them. Skills, voice, token controls, production account/model/mode controls and queue/interrupt behavior remain available in their appropriate existing surfaces.

Desktop should reuse the same resource model. The updated preview places a Session resources surface above the conversation content, with Outputs and Sources side by side when wide enough. A permanently docked inspector could be a later presentation option; it is not a requirement to replace the PR’s tray now.

The static design demo uses explicit Half / Full buttons and in-flow expansion so it can be inspected inside the conversation. It is not a replacement implementation of the PR’s physical snap sizes, swipes, backdrop or toolbar coverage. Production must reuse/verify the actual component for those behaviors.

Resource membership and model input are distinct: listing a document under Sources must not automatically resend every document on every turn, or to every Symposium seat. Respect selected context and actual prompt assembly. Actual model input tokens still count even if the source content is cached or was already shown in the UI. Opening a resource tray or switching its display state requires no model call.

Goal details should link to the outputs of associated sessions, retaining their provenance. Avoid copying session artefacts into separate stores solely for display; identify producing session, message/tool and goal association where available. A generated file is not automatically verified completion evidence.

## Symposium within chat

Verified protocol fields in #446:

- `SessionType`: chat or symposium.
- `SeatConfig`: name, model, system prompt and display color; v1 documents exactly two seats.
- `TurnRules.mode`: round-robin, directed or budgeted.
- `TurnRules.maxTurns`: maximum turns.
- `TurnRules.budgetUsd`: optional dollar ceiling.
- `InterceptMode`: auto or manual.
- Session metadata stores session type and serialized Symposium configuration.

The type names alone do not establish the runtime scheduling behavior of each mode. Preserve the intended semantics and verify the runtime implementation before exposing a working selector. In particular, a token ceiling is not already present in this configuration. A new `budgetTokens` capability would need an explicit backend/protocol extension and tests.

Proposed frontend integration:

- Set up a Symposium from the conversation/goal context, with two named seats and their model choices, turn order, turn cap and interception behavior.
- Keep one conversation transcript with clearly attributed seat responses. Use seat names and labels; color is supplementary.
- Retain rich content blocks, tools, progress, permissions and source/output associations for each seat. Do not flatten a Symposium into plain alternating text bubbles.
- Display the current turn, next/waiting state and whether a response is held for human interception. Manual interception needs explicit inspect/edit/deliver controls consistent with the runtime contract; opening the panel never delivers anything.
- Outputs and Sources remain in the shared SessionTray, with producing-seat provenance where supported.
- Link the Symposium to the same desired outcome. Do not silently convert an active ordinary session if the existing runtime cannot do that. Creating a separate Symposium session linked to the same goal is a valid implementation path and must be described clearly before the action.

The preview’s “Preview symposium” action is explicitly local. It displays illustrative two-seat responses and token counts, makes no model calls, and demonstrates manual review as a held response. It does not implement scheduling, authentication, model selection or response delivery.

## Tokens to goal

Each seat’s model calls, repeated context, orchestration calls, retries and final synthesis count toward the linked goal once. Display separate **seat spend**, **Symposium total**, **session context occupancy** and **goal total** labels where appropriate; these scopes can overlap and must not be summed blindly.

Symposium should be an explicit choice when the additional perspective is useful. It should not silently launch on ordinary chats or add an automatic multi-model assessment to every goal. Reuse existing response/context work when valid, and meter whatever is actually sent. A turn cap limits turns, not tokens; the UI must not label it a token budget.

## Implementation scope and effort correction

SessionTray is existing PR work to integrate and restyle. Its core implementation should not be costed again as a new redesign feature. The same applies to #456’s account/model and queue controls.

Symposium protocol, scheduler, seat execution, interruption, usage attribution and persistence are a separate feature stream from redesigning the shell. Its frontend can share our new layouts, but the previous 3–5 engineer-week UI estimate does not promise delivery of a complete Symposium runtime. Confirm which Symposium implementation/design work exists beyond #446 before assigning incremental effort.

The redesign's preservation checklist now explicitly includes SessionTray, outputs/sources, account/model/queue surfaces, rich single-agent chat and Symposium’s seat-aware chat states. This supplement supersedes earlier generic composer/context sketches where they conflict with #462.
