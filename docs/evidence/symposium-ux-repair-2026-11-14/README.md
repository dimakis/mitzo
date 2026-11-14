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

## Completed deterministic application journey

Production candidate `7f4055305ae3171b94d0f8ad4b182aa72043fe29` additionally
integrates slice 1 originals `7f91d07f8`, `23fecb979`, `706aae1cf`, `5908c4dc6`
and slice 2 `e5b59fc4f`. The acceptance source SHA256 is
`3c7868e5b258dad8a14af8d8b864e4f75c85ef66eb5644ba479a8b81639e2ebd`.
`combined-complete-7f4055305.log` records 9/9 tests in two files passing,
including the entire real responsive/application journey and five owner controls.
The log embeds branch, head, test hash, runtime, route and renderer boundaries.

| Case                                                                                  | Observed result                                                                                                                                     | Exact source / artifact / limit                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical ordinary composition at 320/390/1280                                       | PASS: one transcript and composer, exact history entry                                                                                              | `tests/integration/symposium-ordinary-acceptance.test.tsx`, first three cases; JSDOM selects actual responsive owners                                                              |
| Enabled ordinary source, unsent draft, fresh setup/review/join                        | PASS: exact textarea and draft retained; joining adds zero provider turns                                                                           | Same file, full journey; real preparation/admission and edited review                                                                                                              |
| Explicit reviewer prompt, reviewed joining context, attributed streaming/finalization | PASS: edited brief reaches external turn input, hidden marker excluded, exact recipient/source/command provenance, one final reply                  | Same journey; actual HTTP/router/store/reply owners with deterministic external RPC                                                                                                |
| Exact completed request retries                                                       | PASS: two retries add zero turns                                                                                                                    | Request parsed from actual client POST and repeated through actual API                                                                                                             |
| Responsive owner changes, focus and text selection                                    | PASS immediately and after qualification: same textarea/draft, focus/selection, one transcript                                                      | 390→1280→320→390; original transient failures retained in earlier checkpoint logs                                                                                                  |
| Concurrent original source and reviewer activity                                      | PASS: actual streamed source output appears, retained composer/draft and responder controls                                                         | Identify actual external thread IDs, rather than assuming dispatch order; native source SSE uses queue/message events, so legacy `messages.running` is not used as admission proof |
| Partial failure and selected failed-recipient retry                                   | PASS: one completed and one failed delivery; only failed thread receives the new explicit retry                                                     | Exact command deliveries retained; successful recipient is not dispatched again                                                                                                    |
| Long history                                                                          | PASS: 25 additional acknowledged turns, retained-page notice and one transcript/composer                                                            | 30 external turns before Stop scenario; no browser geometry claim                                                                                                                  |
| Committed send response lost, exact observation/retry                                 | PASS: original request/message identity, recipient and command retained; no extra dispatch                                                          | Failure injected only after real successful HTTP response                                                                                                                          |
| Stop response lost, original Stop retried                                             | PASS: one exact native interrupt; uncertain failure remains nonterminal                                                                             | External Stop ACK is not terminal proof; original uncertain operation retained                                                                                                     |
| SSE reconnect, frontend remount                                                       | PASS: new real welcome/connection, no provider replay, grouped list and Agents inspection                                                           | Loopback real SSE bytes; no fabricated connection or store running state                                                                                                           |
| Full application owner restart                                                        | PASS: owners released/reimported, same SQLite request/message/commands, zero new native requests, one Chats row, raw joined participant inspectable | This is application teardown/reimport, not an OS process kill or physical-phone restart                                                                                            |
| Required review/joining/messaging/admission/reply owner absent                        | PASS: all five controls prevent acceptance                                                                                                          | `tests/integration/symposium-required-owners.test.ts`; owner omission only in negative controls                                                                                    |
| Rendered light/dark 320/390/desktop, keyboard, large text, approved HTML comparison   | PENDING hosted browser execution                                                                                                                    | Local Chromium startup failed before rendering; no screenshot/visual pass claimed                                                                                                  |
| Original phone incident / physical phone / live runtime                               | OPEN / UNOBSERVED                                                                                                                                   | Exact chat/request, phone build and original operation/receipt still missing; separately authorized qualification required                                                         |

The source admission and qualification/routing repairs came from the implementation
owner. This slice changed tests/evidence, not their production surfaces. Harness
corrections retained exact thread targeting, waited for actual UI refresh after
joining, and waited for real idle teardown before reimport. Original red artifacts
remain available; corrected harness assumptions are not product-failure claims.
The green result establishes the bounded deterministic behavior above. Combined
CI, rendered comparison and final exact-head Centaur gates remain separate.

Final implementation selection additionally includes slice 1 `7482bcb67`,
`fe7bdcc34` and `eac6448fc`, combined as `5af455e1ffc0236d0ccb1ccde1bf62421b69b5da`.
The adjacent source-name/activities hook conflict retained both owners and all
raw activity/history wrapper behavior. `final-integrated-5af455e1f.log` records
20 passes in four files, including the full journey above and input regressions.
`final-focused-d80bd1d89.log` records 396 passes/1 existing skip in 17 owner/design
files. These selections overlap. The combined registry intentionally advances to
`v1.0.1151-symposium-integrated-acceptance`, retaining its 2457 existing entries
and adding 14 new owner/test artifacts; `check:source-artifacts` passes.

Draft [#1355](https://github.com/dimakis/mitzo/pull/1355) is the integration/evidence
candidate; slice 1 is separately published as [#1356](https://github.com/dimakis/mitzo/pull/1356)
and slice 2 as [#1354](https://github.com/dimakis/mitzo/pull/1354). Main was reread
14 November at 11:22 UTC and remains the original accepted `9af764899`.
The initial combined CI run at `0b8393e34` failed source registrations and
TypeScript rootDir/nullability/timer issues; implementation owners supplied the
fixes above. The original failed run remains inspectable as
[43587939228](https://github.com/dimakis/mitzo/actions/runs/43587939228).
Subsequent CI is qualification evidence only for its exact head.

`tests/offline/symposium-ordinary-responsive.spec.ts` renders the real
`ResponsiveChatView` with ordinary `sessionType: chat`, independently of the
special Symposium preview. It retains paired ordinary/approved-HTML screenshots,
build hashes, branch/head, route and viewport metadata for 320/390/1280, both
themes, 60 history entries, keyboard/focus and 200% text. The narrower
`symposium-ordinary-surface.spec.ts` additionally observes shared-host joining and
input retention. Both use deterministic presentation HTTP fixtures; their results
must stay separate from the real authenticated application journey. CI retains
these screenshots/manifests on success or failure. The paired approved reference
requires visual inspection; geometry assertions alone cannot claim pixel parity.

The bounded diagnostic contract is in `observability-followup.md`. It preserves
original operation correlation and sanitized code/stage/error through owners and
consumers without collecting private prompts or inventing a phone root cause.
Originating-chat delivery became unavailable at authorization/delivery; lookup of
the original message receipt was also unavailable. Slice 1 and 2 received the
verified checkpoint and remaining boundaries through supported peer messaging.

## Recovery consumer and hosted baseline

The stronger actual-screen check found a missing recovery consumer after the
earlier API recovery passed. `baseline-missing-status-view.log` retains the red
assertion: the draft and original 31st turn survived, but neither status details
nor Check original request was reachable. Slice 1 confirmed the portal forwarded
the status sink/active state without its view context. Original `aed7a34a2`
(combined `ee2b8440e`) repairs that owner/consumer boundary; `a778c1d51` also fixes
status ownership and the two CI test types. `final-visible-recovery-ee2b8440e.log`
records 21 passes in four files, including opening real Conversation status
details, checking the exact original request, and completing the full Stop and
restart continuation without another dispatch. The original red assertion stays
in the final harness. Recovery actions may be grouped in status details when
several notices exist; the test follows that actual user path.

Hosted focused run [43590207422](https://github.com/dimakis/mitzo/actions/runs/43590207422),
PR head `c0a8e7aaf69373b87f68b0d1e9d56e787a52542a`, executed merge ref
`8bf86176098f5ae165cbaf6a6f234db45717071e` with Node `24.22.1`:

| Job                                       | Observed outcome                                               | Exact evidence                                                             |
| ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Ordinary authenticated application owners | PASS, 9 tests, full 31-turn journey and five omission controls | `hosted-application-c0a8e7aaf.log`, job `132433141922`                     |
| Browser host preparation                  | PASS, pinned Linux Chromium/WebKit container                   | Job `132433141743`                                                         |
| Ordinary responsive render evidence       | FAIL, all 12 presentation cases; 2 startup probes passed       | `hosted-render-c0a8e7aaf-original.log`, retained screenshots/traces/report |

The render failures were fixture prerequisites. The narrow fixture's socket
throws during automatic store connection. The full responsive fixture renders
ordinary history but supplies no startup-verified auth session ID, so the actual
ordinary shared host correctly remains unqualified. The fixture corrections add
an inert external socket and exercise real `restoreCookieAuthentication` against
the intercepted verified login before mounting the route. They do not bypass
production authentication or establish an application/device pass. Original
downloaded artifacts remain under `.cache/symposium-ci-c0/` in this verification
checkout; the complete hosted logs and exact commits are retained here.

The focused `symposium-acceptance.yml` workflow uses the repository's existing
pinned Node/browser-container actions with read-only GitHub permissions and
bounded jobs. It supplements full CI and removes no required gate. It retains
the complete report/screenshots/traces on success or failure; bounded fixture
failure annotations make diagnostics available even when the separate tool's
authenticated REST log quota is exhausted. The existing signed-in native GitHub
route remained usable and supplied these original logs/artifacts. Origin
communication later recovered and received the confirmed blocker/fix evidence.

## Rendered structural pass and visual comparison gap

Focused run [43591105649](https://github.com/dimakis/mitzo/actions/runs/43591105649),
PR head `06ad8abd70366417440ba4b0c0be40d3d199c4c3`, merge ref
`b6f1730bb7d7b05d83a280bf096574961c98c719`, passed all 12 render cases and both
browser startup probes. The pinned Linux browsers are WebKit and Chromium;
projects are `mobile-webkit`, `mobile-chromium` and `desktop-chromium`.
Each responsive case renders 320/390/1280×844 in light or dark, 60 ordinary
history entries, actual keyboard focus and 200% text. Manifest observations show
one actual scroll region with `overflow-y:auto`; for example mobile WebKit light
has 511/559/566px transcript view heights at those widths. These are hosted
browser observations, not physical-device acceptance.

`hosted-render-06ad8abd7.log` and `render-06ad8abd7/artifact-index.json` retain
exact source/build/route/viewport/render identities. Artifact `14112416946`,
SHA256 `b70786760eab52026e49f5c5cb4d94409b10f9aabf8920a7e86969d2bb4cefe8`,
contains the complete report and screenshots. Six engine/theme manifests and
representative original mobile/desktop screenshots are retained in this folder.

Visual comparison is **not accepted yet**. The actual ordinary header passes
`compact` to `ConversationAgents`, which hides all participant names. The
approved HTML's header agent bar displays names; the existing special-preview
test even requires visible mobile participant-name width. This discrepancy is
visible in the retained actual ordinary screenshots and was sent to slice 1.
The ordinary render test now asserts that name container is visible, so it
cannot silently accept an icon-only ordinary composition. The approved artifact
opens Add agent initially; later comparison captures retain that state and use
its own Close dialog control before capturing its conversation. The reference
bytes and product CSS remain unchanged. Initial reference screenshots here show
the setup overlay and cannot establish same-state conversation pixel parity.

The same run's application job stopped at a one-second wait while the original
31st delivery was durably **queued**, before native dispatch. The original
request/recipient/command remained inspectable; no replacement request was made.
`hosted-application-06ad8abd7-queued-wait.log` preserves that failure. The bounded
external-ack wait is now ten seconds. A background exact observation may consume
already accepted submitted text, so the stronger invariant is that an independent
new edit survives Check/Stop/remount/restart. That full journey, including real
SessionList navigation after the first reply and after restart (one source row,
zero joined-peer rows), passes locally in `final-draft-chats-06ad8abd7.log`.

Full CI at `06ad8abd7` still rejects one test-only unsupported RTL `exact` option;
the exact one-line correction from owner `bb219f4218b73ce5946b04d63649480d48040b2f`
is integrated separately from that owner's standalone registry. The earlier
server/pin checks pass. Full combined CI and the new visible-name assertion must
be observed on the later head before extending this acceptance claim.

## Fresh accepted-main integration and named-header checkpoint

Accepted main advanced to `19aa8a19b274ae1fee416f0f187c772111251366`
(Claude queue continuation). Local merge `13926ac13` retains those owner changes
and both repair slices; the only conflict was reviewed source registration.
Its registered keys were preserved and hashes regenerated from the combined
bytes as runtime revision `v1.0.1158-symposium-integrated-acceptance`.
This local verification-branch merge does not merge a GitHub PR or deploy.

Slice 1 header fix `f6b7119e1` is integrated as `f9d752fe6344c0e5b5e44333c4d6af0239898021`.
It enables names on the existing compact Agents action after sharing; the
slice 2 history/activity wrapper remains intact. At that exact combined source,
`accepted-main-19aa-header-f9d752f.log` records **131 passes and one existing skip
across 11 files**, including the actual authenticated application journey,
five required-owner omission controls, retained composer/status consumers and
109 design checks. The route is `/chat/:sessionId`, widths 320/390/1280, Node
24.10.0, Vitest source transpilation/JSDOM. This establishes no visual pass.

The pending hosted render check preserves fresh-setup and closed-dialog
conversation reference screenshots, asserts visible participant names and at
least 64px of name width at 200% text, and records their actual bounds. Full CI,
hosted geometry/visual comparison and exact-head independent review remain
required on this successor. The retained icon-only render failure evidence,
original phone-incident identifier gap and physical-phone/live-runtime limits
remain unchanged.
