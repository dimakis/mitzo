# Mitzo: Today and tokens to goal

**Source-inspection update:** Read `mitzo-desktop-and-implementation.md` for desktop designs, effort ranges and corrections grounded in the existing repository. It supersedes earlier assumptions about simplified message rendering, SSO, per-run pause and goal creation.

Implementation design · 7 September 2026 · v2

Status: proposed design for implementation. Based on the supplied mobile homepage and the accepted Today concept. No source repository or existing telemetry contract was supplied. The prototype uses explicitly illustrative data; it does not connect to Mitzo or execute work.

The companion `mitzo-screen-designs.md` specifies the expanded Chats, Inbox, TELOS, agent taskboard, Calendar, Connected accounts and profile flows. It supersedes the initial placeholder destinations and naming below.

## Product intent

Mitzo should help the user choose the next useful action and achieve it with fewer tokens. The homepage answers “What matters now?” Goal details answer “What outcome are we pursuing, what happened, and what did it take?” Efficiency answers “Is the stack achieving comparable outcomes with fewer tokens?”

Tokens are a first-class product metric. Keep them visible in the places where the user can connect consumption to an outcome. Avoid a large homepage usage dashboard by default. Offer an optional compact token line on Today and preserve token counts in conversation history.

## Information architecture

- **Today:** time-aware briefing, up to three focus items, resume recent work, persistent Ask Mitzo entry point.
- **Chats:** search, conversation history, compact token totals, new conversation. Conversation details link to the associated goal.
- **Inbox:** requests requiring action first; informational updates in a separate view. Navigation badges count actionable requests only, never all unread content.
- **Work:** goals and tasks. Goal details expose outcome, status, acceptance criteria, activity, linked conversations, and token accounting.
- **More:** Calendar, Efficiency, Connected accounts, connection health, settings. Efficiency is also reachable from every goal’s token summary.

Keep Calendar reachable in one tap from a briefing’s event link. This proposal moves Calendar out of primary navigation; validate whether direct Calendar use is frequent enough to retain its tab before release. Work is the user-facing navigation label; TELOS remains a source identity within records.

## Screen 1: Today

Order on mobile:

1. Compact Mitzo wordmark and Search; no technical status icons in the header.
2. Date and short time-aware heading. Morning: “Start with what matters.” Evening: “A little clarity for tomorrow.”
3. One briefing surface with a concise grounded summary and one primary action. It should expose useful information before requiring a conversation. Until a summary is available, show “Review changes across calendar, email and Jira,” without inventing changes or counts.
4. “Your focus,” maximum three items. Each has a readable action title, a supported reason to act, source, and next action. User-selected focus is visibly distinguished from suggestions. “Later” removes an item from focus, preserves the task, and offers Undo. Suggested focus requires evidence such as an actual deadline, explicit request, blocker, or user pin. Age alone is not urgency.
5. “All tasks · 70” as a quiet link; use the actual filtered total, not the sum of overlapping categories.
6. “Pick up where you left off,” one or two conversations. Show title, last activity, and optionally a muted token count when the user enables Home token visibility.
7. Ask Mitzo composer near the bottom of the content, above bottom navigation. In the implemented app it can dock above navigation while respecting keyboard and safe areas.

Briefing schedule defaults: morning 05:00–11:59, afternoon 12:00–17:59, evening 18:00–04:59 in the user’s configured timezone. These are UI defaults, not inferred user preferences. No model call solely to change the greeting or time label.

Expanded briefing includes source links, last refreshed time, and clear “not checked” markers for unavailable sources. Do not interpret a failed source fetch as no changes. Refresh should reuse available source deltas and cached summaries where valid.

Homepage token visibility defaults off. The optional token line is descriptive (“254k tokens · session”), links to details, and does not claim efficiency. Budget attention can appear on Today if a goal actually crosses a configured threshold; use “Review token usage,” not an unsupported prediction.

## Screen 2: Conversation

Header contains Back, readable title, and conversation actions. A compact context strip shows “Goal: Resolve Centaur PR 455 review issues” and links to goal details.

Below the context strip, show two distinctly scoped counts: “Session 18.2k” and “Goal 42.8k.” Both labels include “tokens” in accessible text. Session is this conversation’s model calls; Goal includes all attributed calls across conversations and agents. Do not add these overlapping totals together.

Tapping the count opens the goal accounting panel with scope, breakdown, reporting completeness, and timestamp. A conversation without a goal shows only its conversation total and a “Link to goal” action. Ordinary chat remains available without forcing goal creation.

The composer supports text, attachments, and voice if already supported by Mitzo. Token updates are quiet and nonblocking; announce meaningful changes in an opened details view, not every streamed increment. The prototype composer illustrates local interaction only.

At task completion, present the outcome and evidence first, then “Tokens to goal · 42.8k.” A completion claim must be grounded in acceptance evidence. Explicit user confirmation is needed only for criteria that require user judgment; do not add an approval step to every objective check.

## Screen 3: Goal details

Top: title, state, source links, and an explicit outcome. A goal is a unit of desired outcome, distinct from a chat session and a single execution attempt.

States: planned, active, blocked, achieved, cancelled. A failed attempt can belong to an active or blocked goal; it is not automatically an achieved goal. Reopening preserves historical usage and completion history.

For active and blocked goals, the headline metric is **Tokens spent**. For achieved goals, it is **Tokens to goal**. For cancelled goals, it is **Tokens spent · cancelled**. Never display a final tokens-to-goal figure for unfinished work.

Below the metric: reporting completeness, input/output split, configured budget when present, acceptance criteria and evidence, activity, linked conversations. Input includes cached input; show cached input as a subset. Show reasoning output as a subset of output only when supported by the provider; never add it a second time.

Budget display: “42.8k of 60k tokens” with a labeled progress indicator, only when a budget exists. Budget is a user setting, not an estimate of completion. Suggested default thresholds are attention at 80% and exceeded at 100%; do not automatically terminate work unless the user explicitly enabled a hard limit. Do not infer remaining work from remaining tokens.

Usage details expose model and agent breakdowns, retries, and tool-result/context contributions when separately measurable. Avoid stacking overlapping dimensions as though they sum to a total. Provider/model tokenizers differ; mixed-model totals are operational counts, not identical units of compute.

## Screen 4: Efficiency

Accessible via More → Efficiency and from token summaries. Default period: last 30 days, with a previous matched period comparison when sufficient comparable data exists.

Primary metric: median tokens to goal for achieved goals in the selected cohort. Display cohort, completion count, and coverage alongside it. P90 and total tokens spent are supporting views. Use task family and acceptance/quality version to define comparability; show model and routing mix when it changes. Do not call an unadjusted change in a mixed workload “stack improvement.”

Guardrails beside the primary metric:

- Achievement rate for goals created in a defined cohort, with still-active goals shown separately and an explicit observation cutoff.
- Tokens spent on failed attempts, cancelled goals, and still-active goals; these must not disappear from overall consumption.
- Time to goal and reopen/rework rate, so fewer tokens are not rewarded at the expense of usability or quality.
- Reporting coverage, unknown usage, and small sample warnings. Avoid a trend arrow when a comparison is unsupported.

Do not use “total tokens / completed goals” as the headline tokens-to-goal metric; it conflates workload volume, unfinished inventory, and successful-goal efficiency. A separately labeled portfolio burn ratio may be useful later.

## Metric contract

Proposed definition pending confirmation of any existing Mitzo contract:

**Goal tokens spent = sum of attributable model-call input tokens + output tokens over the goal’s lifetime.**

**Tokens to goal = that total as of a verified goal achievement event.**

Include planning, delegation, child-agent calls, retries, failed attempts, context compaction calls, and verification calls attributed to the outcome. Tool text counts when supplied to a model as input. Do not independently count the same tool bytes as additional tokens. Pure tool execution contributes no model tokens unless the tool performs separately metered model work; expose known external model usage and label unavailable usage as unmeasured.

Cached input still counts toward token reduction; record it separately for cost analysis. Cost can improve without token volume falling. Store provider-native counters, apply a versioned normalization policy, and keep reasoning tokens within the output count when already included. Missing counters are unknown, never zero. Estimated usage is clearly marked and replaced with authoritative totals when available.

Attribute each model call once to one accounting owner. A subgoal’s calls may roll up into its parent, but portfolio totals sum unique usage events, not parent plus child totals. For shared work, retain an explicit shared-overhead bucket unless a documented allocation policy exists; do not duplicate a call across goals. Unattributed conversations remain visible in overall stack usage, with an attribution coverage metric. A link change updates attribution through an auditable process, not silent deletion of usage.

Global retrieval/indexing/maintenance model calls belong in stack overhead. Efficiency includes total goal-attributed usage plus shared overhead plus unattributed usage, each deduplicated. This prevents apparent improvement caused by moving consumption outside the goal path.

An achieved goal stores an achievement timestamp and usage snapshot revision. Late provider reconciliation can revise its total while retaining an audit trail. Reopening resumes the cumulative accounting lineage; retain earlier milestone snapshots for analysis. A material change to the outcome creates a linked new goal instead of rewriting the old success definition.

Display rounding: under 1,000 show integers; 1,000–999,999 show up to one decimal with k; one million and above show up to two decimals with M. Exact integer totals are available in details. Rounding is presentation only.

## Data requirements

These are conceptual frontend contracts, not claims about existing APIs.

Goal: id, title, outcome, state, createdAt, achievedAt, sourceRefs, acceptanceCriteria with evidence, parentGoalId, cohortKey, qualityVersion, optional tokenBudget, accountingPolicyVersion.

UsageEvent: stable eventId, unique providerRequestId/callId, goalId or overhead bucket, conversationId, runId, parentRunId, agentId, provider, model, occurredAt, inputTokens, outputTokens, cachedInputTokens when available, reasoningOutputTokens when available, authoritative/estimated/unknown status, revision. Use idempotent ingestion and final counter reconciliation.

UsageSummary: scope and scopeId, input/output/total counters, subset counters, reporting completeness, unknownCallCount, measuredCallCount, lastUpdatedAt, accounting revision, optional budget. Return aggregate counters from the backend; the mobile homepage must not download all usage events to compute them.

TodayData: local date/timezone, briefing summary and per-source freshness, focus items with selection reason and evidence, recent conversations, actionable inbox count, optional relevant budget attention.

EfficiencyData: explicit date range, cohort/filter definition, accounting policy, sample count, completion/active/cancelled counts, usage coverage, median/P90, supporting consumption categories, and valid comparator or a reason comparison is unavailable.

## Visual system

Retain purple as the Mitzo accent; use it for the primary action, active navigation, and links. Neutral rows replace red-bordered cards. Red is reserved for actual errors and urgent blockers, paired with a text label. A priority star is not an error indicator.

Light palette: background #FAF9F6; primary text #202127; secondary text #62636B; border #DEDEE3; briefing surface #EFEDF8; accent #5E42B8. Dark palette: background #131416; primary text #F2F2F5; secondary text #AAAAB4; border #33343D; briefing surface #242131; accent #B5A1FF. Validate contrast in implementation, including focus rings and disabled states.

System sans-serif; page heading 24/30, section heading 14/20 medium, body 15–16/22–24, metadata 12/18. Token numerals use tabular figures. Spacing scale 4, 8, 12, 16, 24, 32. Mobile horizontal gutter 20–24; 16 at the narrowest widths. One distinct briefing surface; most other sections are open rows with subtle dividers. Surface radius 16; composer 14; buttons 10.

Touch targets at least 44×44 CSS px. All actions keyboard accessible. Visible focus styles, semantic headings, descriptive labels for counts and icons. Support system text scaling, reduced motion, light/dark themes, 320px widths, and safe-area insets. Never make full titles or essential actions hover-only. Homepage titles may wrap to two lines; full title remains available in details. Numeric scope labels must not truncate away.

Desktop: centered content around 1120px; persistent navigation rail, main briefing/focus column, secondary resume column. Keep the same information order for keyboard and screen-reader reading. Avoid stretching mobile cards across the entire viewport. Goal and efficiency details can use additional horizontal space without hiding their scope labels.

## Loading, empty, error and offline states

- Initial load: skeleton the expected regions; never flash zero token counters before data arrives.
- No focus: “Choose your first focus” with a task picker; do not fabricate priorities.
- No recent chats: omit the resume section; retain the composer.
- No goal association: show session tokens and Link to goal.
- Unknown usage: “Usage unavailable” or “Partial usage · 2 calls unreported,” with last measured subtotal explicitly labeled. Never a green budget status based on partial data.
- Partial source failure: briefing remains readable with affected sources and retry controls identified.
- Offline: cached content with timestamp; drafts can be retained locally. Do not imply a queued message has been sent. Resume sending according to the app’s established user-controlled behavior.
- Budget exceeded: text label and details link; continue/stop behavior follows the configured budget policy.
- All focus complete: show the completed state and optional next-focus picker; do not refill automatically merely to keep the screen busy.

## Components and boundaries

AppShell owns navigation, safe areas, search entry, responsive layout. TodayPage composes TimeHeading, BriefingSummary, FocusList, ResumeList, and AskComposer. FocusRow owns its next action and reversible focus removal. ConversationPage uses GoalContextStrip and TokenScopeSummary. GoalDetailPage uses OutcomeHeader, AcceptanceChecklist, UsageSummary, UsageBreakdown, and ActivityList. EfficiencyPage uses CohortPicker, GoalEfficiencySummary, comparable history, guardrails, and coverage disclosure.

TokenCount is a shared formatting/accessibility component. UsageSummary owns active-versus-achieved labels and reporting completeness. Keep accounting aggregation and state transitions on the backend so every surface reports consistent totals.

## Implementation sequence

1. **Today shell:** new hierarchy, plain-language navigation, focus limit, readable titles, resume, composer, time-aware briefing. Preserve existing task/chat behavior behind the new components. Retain existing token counts in history and details; never delete telemetry as part of visual cleanup.
2. **Accounting foundation:** confirm metric policy, idempotent usage events, goal attribution, child-call deduplication, cached/reasoning subsets, unknown data and late reconciliation. Migrate legacy counters with an explicit legacy/unknown scope rather than pretending they are comparable.
3. **Goal and chat integration:** scoped counts, outcome/acceptance state, usage drawer, budget display, optional homepage token visibility.
4. **Efficiency:** add cohort-aware summaries once enough trustworthy achieved-goal data exists. Do not ship invented reductions or misleading baseline comparisons.

## Acceptance checks

- At 320px and enlarged text, titles, counts, composer, and navigation remain usable without horizontal page scrolling.
- At 22:06 local time, the page offers an evening review. Changing the time bucket makes no model request.
- Focus shows no more than three items; Later preserves the task and supports Undo.
- New conversation and resume remain directly accessible; source metadata and integration health are still reachable in details.
- A goal containing 10k parent-call tokens and 5k child-call tokens shows 15k, and the portfolio includes those calls once.
- For 10k input tokens including 6k cached input and 2k output including 500 reasoning output, the total is 12k.
- Retrying ingestion of a usage event does not change the aggregate. Reconciliation replaces estimates instead of appending duplicates.
- Active, blocked and cancelled goals show Tokens spent; achieved goals show Tokens to goal with evidence and reporting status.
- A missing provider counter never appears as zero or a complete metric. Unsupported comparisons show their limitation instead of a percentage improvement.
- Shared overhead, cancelled-goal usage, and unattributed chat usage remain visible in stack consumption.
- Read-only navigation, opening a usage view, changing presentation filters, and toggling token visibility make no LLM calls. Briefing generation is cached and refreshed from source changes under a documented freshness policy.

## Decisions to confirm when connecting the repository

Existing definition and instrumentation for tokens to goal; goal/task/session relationships; current frontend framework and routing; source freshness guarantees; actual Calendar usage; provider usage-field semantics; existing acceptance verification and budget enforcement behavior. These do not block reviewing the proposed design, but they determine the implementation adapters.
