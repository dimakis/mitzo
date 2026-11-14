# Ordinary Symposium acceptance — slice 3

Independent evidence session: `eed1a903-d6f2-8f8d-bfc6-e489e8fecd7f`.
This is an ordinary session, without a Telos lead/worker assignment. No other
session's execution grant, runtime qualification or merge authority is inherited.

## Source and test boundary

Baseline accepted main: `9af764899302cbcc55c60ed0d2e7f159b266a045`.
Verification branch: `test/symposium-integrated-acceptance`.
Runtime: Node `v24.10.0`, npm install through `npm@11.18.0`, macOS arm64.
No application production build was made for baseline; Vitest transpiled source.
Route: `/chat/:sessionId`, actual `ResponsiveChatView`, mobile widths 320/390 and
desktop width 1280 in JSDOM. These widths select real responsive owners; JSDOM
does not establish geometry, scrolling, keyboard layout or visual acceptance.

The new harness is `tests/integration/symposium-ordinary-acceptance.test.tsx`.
It keeps the real client store, ordinary shared host, responsive pages, cookie
authentication, application router, repository preparation, ordinary admission,
SSE connection/reconnect ownership, provider command ledger and reply projection.
`tests/support/application-event-source.ts` decodes real SSE bytes over a
disposable loopback listener. It manufactures no welcome, message or session
event. External account declarations, GitHub acquisition and provider processes
use the repository's deterministic application fixtures. No model is charged.
The unrelated broadcast EventSource and browser-only geometry APIs are DOM
adapters. No production configuration, staging, release checkout or live account
is used.

The first source-only reproduction uses the retained historical application
fixture. The larger journey creates a separate ordinary source through the real
`/api/chat/local-codex/send` owner and its authenticated SSE connection. It
restores that source's actual history before typing. This distinction matters:
the historical source-only fixture has no owning command and cannot establish
ordinary source dispatch acceptance.

## Approved reference and independent defects

Preserve ledger `symposium-fresh-agent`, active revision
`fresh-agent-review-2026-10-18-test-syntax`, and
`docs/design/approved/symposium/fresh-agent-review.html`, SHA256
`175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
Ordinary chat first, compact participant header, one Agents view and shared
composer remain the reference. No ledger/reference/protected test is changed.

PR [#1347](https://github.com/dimakis/mitzo/pull/1347) was checked 14 November:
open, draft, conflicting, head `4f5dd94981c9c4bd4b9b31e639a3fae7f560772f`.
Its repository readiness, permissions and dialog work is separate. It does not
close transcript/composer/navigation defects or the original phone incident.

## Baseline acceptance matrix

| Case                                                                                                          | Observed result at baseline                                                            | Exact evidence / remaining boundary                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary responsive composition, 320/390/1280                                                                 | FAIL: two `.chat-messages` containers; one composer and one retained source text entry | `baseline-responsive-matrix.log`; new responsive acceptance test                                                                                                                                                  |
| Fresh setup, prepared repository, edited review, silent join                                                  | Joining succeeds with zero additional `turn/start`                                     | Actual responsive acceptance journey; provider RPC count excludes the explicit source bootstrap                                                                                                                   |
| Existing enabled ordinary composer with unsent draft → join                                                   | FAIL: textarea replaced and visible draft becomes empty                                | `baseline-owned-source.log`; ordinary source started through actual first-command admission                                                                                                                       |
| First explicit reviewer request and attributed streaming/finalization                                         | Reached; one provider turn, exact recipient/command provenance and final reply         | Actual responsive journey; continuation currently stops at source readiness below                                                                                                                                 |
| Exact retry of completed first request                                                                        | No extra provider turn                                                                 | Actual responsive journey; exact input read from real client request                                                                                                                                              |
| Existing source included in All agents                                                                        | BLOCKED: real live source rejected by ordinary prompt port                             | `baseline-owned-source.log`: `collaboration_recipient_readiness_failed`, stage `recipient_readiness`, `SessionPromptError: Choose a fresh configured group participant.`, `server/session-prompt-dispatch.ts:449` |
| Source/concurrent activity, partial failure, selected retry, Stop, lost response, reconnect/remount           | Harness prepared; full ordinary continuation blocked by preceding source readiness     | Do not substitute the passing shared-body-only suite for this acceptance                                                                                                                                          |
| Review/joining/messaging/admission/reply-provenance owner omitted                                             | PASS: all five actual-application mutation controls prevent acceptance                 | `tests/integration/symposium-required-owners.test.ts`; positive owners are untouched in the responsive suite                                                                                                      |
| Existing application-only setup/recovery suite                                                                | PASS: 4 tests in 2 files                                                               | `baseline-existing-owner-selection.log`; useful owner evidence but misses ordinary screen composition                                                                                                             |
| One Chats conversation after first reply/restart, inspectable participants                                    | Pending combined slice 2 source                                                        | Final current-head integrated assertions required; raw sessions remain separate execution owners                                                                                                                  |
| Actual ordinary composition vs approved HTML, light/dark, 320/390/desktop, keyboard, long history, large text | NOT RENDERED locally                                                                   | Playwright startup could not find `chromium_headless_shell-1243` under the bounded executor's temporary browser cache; startup failed and both selected cases did not run. Use hosted CI; no local visual pass    |
| Physical phone and live runtime                                                                               | NOT QUALIFIED                                                                          | Separate authorization/observation required                                                                                                                                                                       |

The source-readiness failure was sent to slice 1 with its exact code, stage and
owner location. It is caused by the inspected guard
`live && !ownedSessions.has(live.session)` rejecting an already live ordinary
source owned outside the shared dispatcher. The original source's admission,
queue, account, Stop and recovery authority must be preserved in any repair;
the acceptance slice does not loosen that guard independently.

## Phone incident and observability

Exact user chat/request, phone client build and original operation/receipt remain
missing. The empty-recipient and actual draft/scroll reproductions do not establish
the complete phone freeze root cause. Do not close that incident from these tests.

Bounded follow-up proposal, coordinated with production owners: retain existing
operation/request correlation through setup, review, admission and reply consumers;
record stable `code`/`stage`, conversation/participant/request IDs and a sanitized
cause through the existing logger. Keep an inspectable failed/unavailable/uncertain
state. The direct ordinary bootstrap exposed a fixture prerequisite (the physical
task root normally created by `index.ts`); the public response retained a diagnostic
ID, but its logged generic preparation failure omitted the actionable cause/stage.
That fixture issue was corrected by creating only its synthetic task root. It is
not evidence about the user's phone.

## Delivery gates

No merge/deployment is authorized. The Claude parity PR stack has merge priority;
all Symposium merges remain held. Any later landing needs combined accepted-main
CI and Centaur's exact-current-head final LGTM/`merge`, zero blockers, and separate
merge authority. Source, browser, device and production acceptance remain distinct.
The present red tests and original failures are retained intentionally for the
combined repair; they are not a feature-completion receipt.

## First combined checkpoint

Production candidate head `0ae4454d2542e79199568996a081a97a7b889719` integrates
slice 1 originals `441591947`, `dbf72bc9e`, `60cc2dda3`, `66cb1a780`, and slice 2
originals `ad6be7430`, `68a99f6e9`, `fc9215570`, `074aab96f`, `bca1155bb`,
`74775efb8` ([draft #1354](https://github.com/dimakis/mitzo/pull/1354)).
The only conflict was adjacent imports in `SharedConversation.tsx`; all three
imports were retained. No production behavior was independently edited here.

`combined-ui-0ae4454d2.log` records 8/9 new integrated checks passing: singleton
transcript/composer at all three responsive widths; actual enabled ordinary
textarea and draft retained through the full real joining flow; attributed
streaming/finalization and exact successful-request retries; all five omitted-owner
controls. The long journey still stops at the real existing-source readiness guard.
`combined-focused-0ae4454d2.log` records 126 passes/1 existing skip in 12 files,
including the protected design checks and selected transcript/input/navigation
owner regressions. These selections overlap; their counts are not added.

The extended harness also exercises actual phone-to-desktop-to-phone owner
transitions. `combined-viewport-0ae4454d2.log` retains two immediate failures:
the visible composer briefly becomes an empty disabled qualification placeholder
at each layout-owner change. The original input, draft, focus and selection do
return after requalification. That eventual restoration does not satisfy the
immediate stability assertion. Slice 1 received this independent failure as well
as the ordinary source-admission blocker. The first-reply Chats list projection
already passes through the real client store, without hiding the raw participant.

Partial failure, uncertain Stop, lost-response UI recovery and full process restart
remain prepared but unreached in this checkpoint. They must run to completion
after both blockers are repaired; they are not inferred from earlier shared-body
tests. Browser execution and visual comparison still require hosted CI. No merge,
phone/device, live-runtime or production completion follows from this checkpoint.
