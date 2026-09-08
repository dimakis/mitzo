# Mitzo: connected screen designs

**Existing PR designs:** `mitzo-existing-chat-designs.md` records #456, #457/#462 SessionTray and #446 Symposium. Preserve these surfaces; its corrections supersede earlier generic source/composer sketches.

**Source-inspection update:** Read `mitzo-desktop-and-implementation.md` for desktop designs, effort ranges and corrections grounded in the existing repository. It supersedes earlier assumptions about simplified message rendering, SSO, per-run pause and goal creation.

Design handoff v2 · 7 September 2026

Extends `mitzo-design-spec.md` and the clickable `mitzo-design-preview.html`. All screen content, identities, token totals, outcomes and connection states in the preview are illustrative. The supplied screenshot shows only the original homepage; these are proposed layouts for the other destinations, not claims about their current behavior. Preserve existing capabilities when mapping these designs to the repository.

## Shared structure

Primary navigation: **Today · Chats · Inbox · Work · More**.

Work contains **TELOS · Tasks · Agents**. Each has a distinct purpose: TELOS connects priorities to outcomes; Tasks manages individual work items; Agents exposes execution and dependencies. TELOS and the agent taskboard are first-class destinations with their own deep links, not buried settings. Work remembers the user’s last selected view. A link to a particular task, goal or agent view overrides that remembered selection.

More contains Profile & security, Connected accounts, Calendar, Stack efficiency, Notifications & display, and System status. Home token visibility stays a readily accessible preference. Provider accounts and Mitzo sign-in are separate flows.

Every detail view has a clear route back to its collection and preserves list filters, scroll position, unsent drafts and selection. Use the platform Back behavior in addition to visible Back actions. Top-level navigation changes should not reset ongoing work or trigger model calls. On implemented route transitions, move accessibility focus to the new heading without altering document reading order; support keyboard navigation and native history.

Use one accent family, structural dividers, readable titles and stable status wording throughout. Status names must describe actual state, not inferred sentiment. Technical identifiers remain available in expanded execution details.

## Chats

Purpose: resume the right conversation quickly while preserving token visibility.

Layout: compact heading and New chat action; search; All / Active / Saved filters; In progress group; Earlier group. Rows contain a title, a useful last-work summary, current execution state when applicable, last activity and **session tokens**. Avoid stacks of decorative cards. A saved conversation is a pin/bookmark, distinct from whether the underlying goal is active.

The conversation opens with linked goal context and separate Session / Goal counters. Keep actual messages visually dominant. A previous conversation linked to the same goal must open its own history, not silently redirect to the current conversation. Offer a named link to continue the current work where useful.

New chat creates a new conversation. Sending from Today must not append to whichever existing conversation happens to be visible in another view. Local draft creation requires no model call; sending does. Do not increment tokens until metered usage exists. A session with unknown usage displays an unknown/partial state.

Search and filters use local/server indexed metadata, not generative classification on every interaction. Group headings disappear when their results are filtered out. Show a concise no-results state and preserve the query. Production overflow actions can include save, rename and archive; retain existing supported actions when the repository is connected.

## Inbox

Purpose: make decisions and requests distinguishable from informational updates.

Two views: **Needs you** and **Updates**. Needs you includes explicit decisions, requests for action and broken connections that prevent relevant work. Updates holds routine progress and completion notices. Badge counts derive from unresolved actionable items, deduplicated across sources. Do not badge 1,114 unread items.

Lead with a concrete question, why it matters, and a next action. Detail shows the source, linked task/goal, relevant context and an editable response draft. Opening, dismissing, sorting and editing manually consume zero model tokens. An optional “Draft with Mitzo” would be explicit and metered, not automatic on open.

Saving a draft and sending it are separate actions. In production, Send names the destination and requires an authorized write capability. The mockup has a local Save response draft action only. Removing an item from Needs you does not resolve or edit its Jira source issue; implement Undo and retain the item in its appropriate history. Reconnection should resolve the corresponding local connection alert once the new connection is confirmed.

When nothing remains, show “You’re caught up” and a link to Updates. Loading and source failures must never look like this empty state. A stale source is disclosed on any item whose currency depends on it.

## Work / TELOS

Purpose: connect what matters to the next action and a verifiable result.

Work’s TELOS overview shows a current priority, active goals, achieved goals, and an efficiency link. Full TELOS adds **Now / Next / Achieved** views:

- **Now:** user-selected goals and actionable tasks with their next step, blocker/decision when present, acceptance progress, and token spend where attribution exists.
- **Next:** candidate work and backlog that has not been promoted to focus. No automatic red urgency based on age.
- **Achieved:** verified outcomes with final tokens to goal and completion evidence.

Use existing TELOS records and identifiers. The proposed relationships are priority → goal → tasks / agent runs. This is a UI mapping to validate against the repository, not authorization to replace the existing TELOS schema or discard its broader purpose/planning content. Preserve existing hierarchy, prioritization controls, search, history and goal metadata; map them into detail views as needed.

Cards must answer: What result are we pursuing? Why is it in focus? What is the next step? Is anything waiting on me? What tokens have been spent? A simple task without an associated goal shows “Not linked to a goal,” not a made-up tokens-to-goal figure.

Create goal asks for a short name, “Done when” acceptance description, and optional token budget. This creates a planned goal and does not silently start an agent. Starting work is a distinct action. The prototype supports one local created-goal example; production creation appends durable records and supports multiple goals.

The task detail has source context, a concrete next step, focus membership and goal association. Source-provided metadata is retained but visually secondary. Focus changes are reversible and obey the three-item homepage limit. Promote/associate actions must preserve task and goal identity instead of duplicating work.

## Agent taskboard

Purpose: show what agents are doing, why work is waiting, and where intervention is useful.

Entry points: Work → Agents, TELOS goal → Agent work, and goal detail → Agent taskboard. Opening from a goal applies that goal as a filter. Global entry shows all permitted runs with a goal picker. The prototype illustrates one goal and deliberately omits a single-choice picker.

Mobile: vertical state sections with quick filters. Desktop: aligned **Queued / Running / Waiting / Complete** lanes, with Paused and Failed states surfaced as needed. Include empty lanes only when they support moving/scanning the board; do not pad mobile with empty panels. Keep deterministic sorting: actionable failures and user blockers first, running work next, then dependency waits and recent completion. Use timestamps and source status, not an LLM to order every refresh.

Each execution item contains:

- Concrete task title and agent/role.
- State and a meaningful current step.
- Goal association and optional parent execution.
- Tokens spent for that execution scope, including its own retries under a documented policy.
- Last activity / freshness, with a stale marker if updates stop.
- Next action: inspect result, answer a question, review an error, or open the run.

Do not display made-up percent complete. A count of satisfied acceptance criteria is valid on a goal; elapsed runtime or budget consumption is not completion progress.

Waiting must name the reason: a dependency, external result, explicit user input, or a paused state. “Waiting on verification” is different from “Needs your decision.” Dependency waits should wake on relevant events, not repeated model polling. Viewing the board and live status updates consume no model tokens.

Run detail contains current step, linked goal, token scope, activity, result/evidence and collapsed execution details. Model/request/run IDs, tool activity and timing remain inspectable. Differentiate tool/model errors from a final failed run. Allow a user to understand a failure before choosing retry; a retry is a new attempt in the same accounting lineage, not a token-counter reset.

Pause is an explicit control with states Running → Pause requested → Paused, followed by Resume when supported. Explain whether the current call continues until a safe boundary; a pending pause must not be rendered as completed. If pause is unsupported, explain that state and offer only supported controls. Cancel is separate and describes the effect on dependent work before commitment. The prototype simulates Pause/Resume only; it controls no real agent.

Agent-task completion is distinct from goal achievement. A completed implementation task can have tokens spent while its parent goal remains active awaiting verification. Only the achieved goal receives a final tokens-to-goal label.

The sample board partitions 42.8k goal tokens into coordinator 20.4k, implementation 14.1k, and verification 8.3k. These are execution-role aggregates; if a role contains multiple attempts, its detail must reveal those attempts. Label the scope consistently. Do not add role totals to the already inclusive goal total or count parent-reported child tokens again.

## Calendar

Purpose: understand commitments and move directly to relevant work.

Default mobile layout is a chronological agenda, with a compact day/week selector and visible timezone. Keep time in a narrow left column and event context on the right. Show duration and meeting state; avoid filling the screen with month-grid chrome by default. The connected product retains day/week/month access if already supported.

Event detail shows time, participants and meeting link when available, source identity, relevant tasks/goals, and existing notes. A meeting link opens the actual provider destination; do not fabricate URLs. Preparing a new AI briefing is explicit and attributed to a goal or shared overhead. Reading cached notes generates no model calls.

A source connection link goes to that account’s detail. A disconnected calendar offers Connect Google Workspace in context; a stale agenda remains timestamped and does not pretend to be current. Event changes/writes are separate authorized actions and are not implemented by this prototype.

## Connected accounts

More → Connected accounts lists providers with connected identity/workspace, status and next action. Initial examples: Google Workspace connected, Jira needing reconnection, GitHub not connected. These are sample states, not observations about the user’s real accounts.

Provider detail shows access in plain language, selected account/workspace/resources, sync state, last successful sync and Connect / Reconnect / Review access / Disconnect as appropriate. “Connected” means authorization exists; “Up to date” means a successful sync occurred. Do not collapse the two concepts. Authorization success should ordinarily transition through initial sync before showing up-to-date content.

Connection flow: provider selection → requested-access summary → provider-owned authorization → callback handling → account/identity confirmation → initial sync → return to the originating view. Preserve intent: a calendar connection started from a briefing returns there. No Mitzo screen collects a provider password. Show declined, cancelled, failed, expired and insufficient-permission states with contextual recovery.

The prototype’s “Preview successful connection” is explicitly a local simulation. The real button must use the supported provider authorization flow and established backend secret handling. Exact scopes, account selection and callback details depend on the existing connectors and must be verified during implementation. Do not request broad write permissions merely to support a read-only briefing. A send/edit action can request the necessary capability when the user chooses it.

Disconnect explains which future sync/actions stop, and separately describes existing-data retention. Cancelling a connection flow preserves the previous valid connection. Disconnecting an account does not silently delete history; deleting stored data is a separate clearly scoped action. Read-only previews consume no model tokens; source fetching also consumes none unless it invokes separately metered model work.

## Profile, sign-in and preferences

More → Profile & security contains Mitzo identity, configured sign-in method and sessions. The sign-in screen is outside the authenticated app shell; hide authenticated navigation when signed out. Use the workspace’s actual authentication methods. The design does not prescribe adding a new identity provider or password system.

Signing out of Mitzo does not automatically revoke connected-service credentials. Production session actions must clearly distinguish this device from other sessions. The prototype simulates the screen transition only.

Notifications & display separates actionable-request notifications, goal completion/blockage, and informational updates. Appearance defaults to system and supports light/dark. Timezone is explicit. The preview uses Europe/Dublin from the session environment; the product uses the configured user timezone.

System status contains service health such as yapper/contexgin and telemetry diagnostics. Actionable failures still appear alongside affected product content. Do not make the user inspect diagnostics to discover that their briefing is stale.

## Implementation slices

1. Shared app shell, route mapping, typography, spacing, tokens and accessible row/button primitives across every screen.
2. Today, Chats and read-only conversation/goal token scopes; preserve current behavior and instrumentation.
3. Work overview, TELOS views, task detail and goal creation/association mapped onto existing records.
4. Agent board and run detail backed by execution state, event updates and accounting aggregates; implement supported pause/resume semantics.
5. Inbox triage and Calendar agenda/detail, retaining source links, freshness and any existing editing capabilities.
6. Connected accounts, authorization-return states, Profile & security and settings. Reuse the existing authentication infrastructure.
7. Cohort-aware efficiency once attribution and outcome coverage are trustworthy.

Do not implement the preview’s in-memory handlers as production persistence. Navigation is a design demonstration; identity, authorization, agent lifecycle, token reconciliation and external writes belong in their existing backend contracts.

## Review and verification

Check light/dark at 320px, normal mobile widths and enlarged text; check desktop lane and rail layouts when implemented. Verify route destinations, preserved list state, search/filter combinations, account-connect cancellation, pause acknowledgement, focus limits and draft isolation. Confirm no model calls from viewing, filtering, account management or manual editing.

Read the original token metric contract alongside this supplement. No redesign should remove counters, reset usage when work moves between agents, or conflate a finished agent task with an achieved goal.

## Prototype verification performed

Browser checks passed for the 34-screen mobile preview at 320px and 430px in light and dark themes: route destinations, search/filter behavior, task identities, local goal creation, TELOS navigation, agent board filters and simulated pause/resume, simulated connection/disconnection, local response drafts, actionable Inbox counts, Calendar event selection, and signed-out navigation. No script errors, duplicate IDs, missing destinations or page overflow were detected. TELOS, taskboard and account layouts were visually inspected.

The preview opens on Work to make the expanded screens easy to review; the proposed app default remains Today. These checks validate the prototype only. Desktop layouts, real provider authorization, actual agent lifecycle transitions, screen-reader focus handling, persistence and backend token accounting still require implementation validation.
