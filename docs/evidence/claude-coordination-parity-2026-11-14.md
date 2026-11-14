# Ordinary Claude coordination qualification

Source baseline: `f801f8df6cac9c1305727b85a7235928eef2e175`, refreshed from main on
14 November 2026. Claude Agent SDK: `0.3.322`. This batch covers ordinary Local
Mac Claude callers, including personal subscriptions and guarded Vertex.

## Implementation

- Admit the already registered `SchedulePrompt`, `SessionTimers` and
  `SendSessionMessage` callbacks through the ordinary SDK allowlist.
- Register `StartSession` with the same `sessionLaunchTools` owner used by native
  callers. The returned object remains a pending, editable review proposal;
  allocation and startup still belong to the existing reviewed launch flow.
- Qualify explicit Claude profiles for those four tools and the existing
  `SymposiumReadProfiles` / `SymposiumProposeProfile` handlers. Keep the existing
  `SymposiumConsult` and `AgentCommunication` registrations.
- Omit absent optional consultation fields before invoking the consultation
  owner. Previously, an explicit `reviewOf: undefined` survived parsing but not
  persistence, causing identical tool retries to report a request conflict.

Business logic, authorization, durable scheduling, revision checks and recovery
remain with their existing owners. The SDK transport is its existing in-process
MCP server. No new service, registry, scheduler or provider abstraction is added.

## Offline evidence

`claude-coordination-tools.test.ts` invokes the real SDK MCP server through an
in-memory MCP client, with real disposable profile, proposal, launch and timer
stores. It verifies default and explicit profiles, SDK skill names, pending
launch proposals and replay, timer edits/stale revisions/cancellation, queued
messages, uncertain delivery and accepted-receipt reconciliation. A synthetic
SDK query exercises first, successor and cold-continuation MCP handler calls;
the retired query refuses further calls.

`claude-coordination-consultation.test.ts` uses the actual application and
consultation owners with a synthetic native provider. MCP catalog and bounded
authorization lead to an attributed terminal contribution. Exact retry and
recovery preserve its receipt and issue one provider turn. A lost response after
durable joining returns sanitized uncertainty; recovery retains the original
session/workspace and completes with one provider turn for that attempt.

`agent-communication-cross-runtime.test.ts` exercises personal Claude and Vertex
fixture senders through the actual MCP handler: discovery, send, read, lookup,
inbox and subscribed wait, correlated replies, exact retry, provider ACK and
unavailable-recipient results. Existing cases preserve unsupported-runtime,
foreign-operator, revoked-owner, stopped-recipient and uncertain-retry behavior.

Local server compilation/build, ESLint on changed TypeScript, formatting and
reviewed source-artifact checks pass. The broader regression batch completed
207 tests in 22 suites before the bounded command timeout interrupted the
remaining native-runtime suite. That full 74-case suite also exceeded the
standalone command limit; five targeted native consumer checks passed separately.
These include Claude MCP steering, uncertain retry, queued-grant rechecks and
durable ACK recovery. Full CI is reported on the PR. Local review found no
blocking issues; its wait-test
coverage observation was addressed by synchronizing on subscription.

The first hosted run, `43551595340`, exposed two stale Session Access assertions
that still rejected explicit Claude profiles selecting the now-qualified saved-profile
helpers. The correction checks default exposure, explicit selection, empty-profile
exclusion and the active skill ceiling for all six coordination helpers on personal
Claude and Vertex. The unrelated `RequestWebAccess` route restriction remains covered.
This is a consumer-test correction; the runtime sources and reviewed pins are unchanged.
The correction's hosted CI and Centaur verification are retained below.

## Accepted-base integration

The correction head `68d0851db88e22e0326c264ce9ba1b1b047302b6` passed hosted
CI `43553851674` and exact-head Centaur review `5901683432` (merge, zero blockers).
It remains the approved review baseline.

The first integration candidate integrates accepted main
`9af764899302cbcc55c60ed0d2e7f159b266a045`, including the canonical approval
and Telos SDK changes from PRs #1351 and #1352. Catalog routes, the SDK helper
allowlist and the browser fixture retain both batches' tool additions. Source
registrations retain both sets of tests, and regenerated pins advance the runtime
revision to `v1.0.1150-claude-coordination-integration`. Focused integration checks
passed 222 tests across the coordination, cross-runtime delivery, Vertex callbacks,
Telos, catalog, Session Access and approval-authority suites.

That candidate, `c240a08909dfe73aa47254e67c01793651788319`, passed hosted CI
`43584473701` at attempt 2. Attempt 1's CT07/09 macOS acceptance journey reached
its unchanged 120-second deadline while progressing to artifact approval under
heavy runner load. One diagnosed failed-jobs retry completed that journey in
60.753 seconds; original logs and artifacts remain retained. Local browser
reproduction encountered the executor's Chromium launch restriction.

Current-head Centaur comment `6876027888` reported blocking finding
`CEN-525457E6FF35`: known Telos mutation refusals retained unknown callback
settlement and blocked the ordinary terminal result. The canonical repair was
already owned by PR #1348 and was integrated after that PR's acceptance.

## Accepted lifecycle repair integration

The candidate now also integrates accepted main
`19aa8a19b274ae1fee416f0f187c772111251366` (PR #1348). Existing mutation owners
retain proof of pre-SQL refusals, including denied feature creation and valid
stale item/native-item/parent revisions. Nested uncertainty, rolled-back writes
and post-COMMIT faults remain unsettled. No parallel implementation of that repair
was added. Runtime files merged cleanly; the shared pin revision is
`v1.0.1158-claude-coordination-recovery-integration`.

Combined offline checks passed 376 tests: 150 SDK, catalog, Session Access,
command-owner and turn-evidence cases; 217 canonical owner, cross-runtime,
Vertex-effect and approval cases; and nine composed ordinary-chat cases covering
first/queued/cold commands plus public Stop, reconnect and Continue. The composed
fixture retains ten other cases for hosted CI. Refusal tests use actual in-memory
SDK MCP calls and ordinary terminal settlement, beyond approval expiry, and assert
that canonical data stays unchanged while actual uncertainty still blocks.

Fresh combined hosted CI and current-head Centaur verification remain required.
Review `5901683432` remains the accepted baseline; integrating the repair does not
itself close the current finding.

## Integration custody and limits

PR #1342 remains draft/open/conflicting at `b2675af8199ab8a99f3628d3d93c4e65145c7244`
when inspected. Its branch, TaskExecution, approval and notification work remain
untouched. Feature `8e186fdf-9058-4ad6-af18-8fd6797bf935` retains its existing lead
and assignments; this ordinary chat has no claimed worker assignment.

Shared integration files are `ordinary-sdk-helper-registration.ts`,
`agent-tool-catalog.ts`, `credential-sdk-tools.ts`, the browser catalog fixture
and reviewed source pins. Apply tool-ID additions sequentially with the
information, Connections/Tool Library and Telos batches, then regenerate pins.
The existing parity lead and PR #1342 integrator were unavailable when refreshed.
Current peer ownership was confirmed from public session handoffs:

- Lifecycle/bootstrap: `ef3feaac-87b0-8499-9c14-fbe13425c78e`.
- Information/history: `7f7d15b5-7912-8b1e-9b99-10c6ce0c6429`.
- Connections/Tool Library: `032e8e84-8d41-8627-aa75-03159d853ade`.
- Telos: `dee6448c-996e-8ebd-b78c-94ee16fc27ea`.
- Approval adapters: `0bdfbc75-7db1-82c8-b5b0-064a4423b55e`.

These are source/fixture results. No live specialist models, external services,
production messages, timers or child sessions were invoked for qualification.
Combined offline Stop/Continue/reconnect and queued-delivery evidence against the
accepted lifecycle repair is recorded above; hosted validation remains required.
Existing reviewed child runtime restrictions remain explicit in StartSession.
Telos work creation, assignment and start are outside this batch. No deployment
or live runtime acceptance is claimed.
