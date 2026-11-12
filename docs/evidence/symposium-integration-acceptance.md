# Symposium integration acceptance evidence

Living map owner: workstream C, `01a14bdc-d152-7912-84d4-c0012e9d5206`.

## 12 November 2026 Add-agent settings regression

A user report showed an absent Agent picker and empty Account & model and
repository controls. Inspection used accepted source `9c087d0da76c`; this is a
source reproduction, not a production account or device qualification. The real
`WorkspaceControls` provides quick-settings navigation around its actions.
`ConversationAgents` portals its dialog while retaining that React context, so
the participant pickers project into the source chat's hidden settings slots.
The standalone dialog fixtures did not exercise that composition.

The candidate isolates participant controls from the source chat's navigation,
preserving the approved fields, existing editors and joining owners. The new
`ConversationAgents.settings-scope.test.tsx` failed on the missing Agent combobox
before the fix. It now exercises the real profile, account/model/thinking and
repository controls inside `WorkspaceControls`, retained setup, unchanged source
settings, and no joining or write effects. The existing composer browser fixture
now includes the same settings/action composition; the additional
`symposium-dialog-controls.spec.ts` covers both themes and the three browser
projects, including repository controls and focus restoration.

Local validation: 26 focused component checks, three actual application recovery
checks, and 109 design checks pass (one pre-existing design skip); targeted ESLint,
formatting and the browser fixture bundle also pass. Browser discovery succeeds.
Rendering remains **unverified locally**: the bounded executor initially lacked
its browser-cache path; after selecting the installed cache, WebKit startup timed
out and Chromium reported macOS Mach-port registration permission denial. The
separately requested native host route still reported Seatbelt and stopped at
the repository guard. No guard, browser binary or permission boundary was changed.
Hosted browser execution and visual inspection remain required; this candidate
does not establish source acceptance, production activation or feature completion.

## 12 November 2026 source-acceptance checkpoint

This checkpoint contributes landing evidence to the existing map without changing
its ownership. GitHub merge receipts were checked on 12 November. Older sections
retain their original dates, failure evidence and candidate-stage limitations;
their preparation wording is not the current source-acceptance state.

| Requirement and owner                                                                                                   | Exact source/PR                                                                                                                                                | Evidence and remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh join-to-answer and retained history: production UI, collaboration application and ordinary prompt/reply owners    | Accepted #1261 `878317bd3d994e6b9d9a153579db09f0bf868dc3`, #1276 `8978f4a1061ef2073967d7691b880af867d85d5e`, #1279 `048b3e05d1509074531f2d43ae165ad2c0de4f27`. | Integrated silent joining, explicit attributed turns, independent reply recovery and delivery beyond the visible page. The original dated application and owner-omission evidence is retained below.                                                                                                                                                                                                                                                                                                          |
| Defaults/explicit recipients, Stop and streaming: messaging, ordinary command/effects and attributed progress owners    | Accepted #1280 `14fb28b0d03a0d780b663f1ef0697699ec546b88`.                                                                                                     | Independent same-account outcomes, partial failures, exact Stop identities and visible-to-final reply recovery. Joining, reading and observation invoke no inference.                                                                                                                                                                                                                                                                                                                                         |
| Per-prompt context and saved bytes: authenticated review/compiler, snapshot authority and ordinary input adapter        | Accepted #1281 `0b8b94f1dd6519f7fcfb5b9eafdb352f03dc475e`; #1282 `d61ae5b25677df50a8b00470f9c01e4a15aaa661`.                                                   | #1282 CI 43208651729 and final Centaur review 5874486159 qualify head `9acb69fe`. Its accepted-base selection passed 114 focused account/application/context/native checks and compilation. Current desktop/mobile light/dark context-review PNGs were inspected; these visual fixtures are separate from backend integration.                                                                                                                                                                                |
| Context-only forwarding: public UI/client, authenticated forwarding application, durable journal and ordinary consumers | Accepted #1284 `33bed3962a26d7ce21208610d11b0e85e1aa106d`.                                                                                                     | 114 tests pass across nine forwarding/application/context/API/notification files, including 20 forwarding-hook cases, production UI confirmation recovery and an older-artifact ordinary-consumer journey. CI 43231140948 and final Centaur review 5876732894 qualify head `9eed8f803`; required App status and guarded merge passed. Current desktop/mobile light/dark forwarding captures were inspected. Unsent cancellation restores only the exact journal, preserving prior ambiguity and replacements. |
| Personal Claude: ordinary SDK preparation/queue/input/reply owners                                                      | #1289, source in this change.                                                                                                                                  | 155 focused tests pass across nine actual application, SDK owner/query, dispatch, API-account, native-executable and notification files on the integrated source. They cover silent preparation, attributed turns, exact Stop/restart, cold continuation and refusal of recovered shared commands lacking their original source observer. Current-head hosted CI, independent final security review and source acceptance remain required; no live provider/device qualification follows from these fixtures. |
| Approved UX and qualification closure                                                                                   | Existing protected design ledger and dated renders; current #1282 CI artifacts.                                                                                | Saved-version, unavailable-selection, edited-brief and footer controls were inspected on desktop/mobile in both themes. Reconcile each milestone criterion and unfinished descendant against accepted evidence before closure. Other-conversation/Telos-artifact picker UI, full live account/runtime/OpenShell qualification, physical iOS and production activation remain outside these receipts.                                                                                                          |

The native-executable fixture correction inherited from #1282 preserves the full
buffer, length/hash, forced short reads, launch checks and 5000 ms deadline. Hosted
job 131154015735 records all 13 tests passing in 56 ms. The earlier downstream timeout
attempts remain retained; replacing the expensive generic property comparison
with a native strict byte comparison does not establish a new runtime capability.

The final candidate also integrates accepted #1319
`8175174b0d9c1076e266c0d864fc83917585903b`. Its read-only connection discovery
uses the same ordinary Claude SDK surface. The combined source passes 129 tests
across eight application, SDK owner/query/effects, dispatch, connection-discovery,
tool-catalog and joined ordinary-chat files, including queued and cold queries,
profile restrictions, cancellation and revoked authority. Server compilation and
all 2318 source fingerprints pass; the merge preserves every key from both
parents. The earlier 155-test selection remains evidence for its preceding source,
not an additional current-head total. Combined hosted CI and trusted current-head
security verification remain required.

Focused selections overlap and must not be added into a single test total. The
source PRs and their exact-head CI/review receipts establish bounded acceptance;
they do not independently prove the full feature or authorize production activation.

## 10 November 2026 one-prompt context source candidate

This slice follows #1280 and composes the actual retained review/compiler,
ordinary settings, shared composer, application messaging and native dispatch
owners. The browser submits selectors; it cannot supply source bytes, settings,
capacity authority or an execution binding. Review creates no session or command.
Only an explicit send starts the selected ordinary turns. New prompt-audience
metadata is additive; historical joining/snapshot capacity contracts remain intact.

The actual Add-agent application journey selects source text, reviews and edits
its brief, refreezes and attaches it before the first turn. No external native
request occurs during these reviews. The first native packet contains the exact
new brief and source, excludes the discarded brief and private fixture marker,
and the later reader receives that first message's retained shared context before
its own requested turn. The attachment disappears automatically after its exact
accepted receipt; the next message sends snapshot null without manual removal.
The seven-turn multi-responder, streaming, Stop and uncertain-recovery journey
continues unchanged in the same real application composition.

128 checks pass across application review (33), messaging recovery (68), send
consumer (18), context hook (8) and actual application UI (1). Failure cases cover
changed source/settings/audience/policy, source removal/rejoin, renewed verified
primary login versus an unverified foreign realm, exact retries, queued reader
delivery, packet overflow, eight distinct 100,000-character pending snapshots
refused before source compilation, lost review/send responses, remount, ignored
abort, newer auth loss winning queued restoration, response mismatch and failed
browser persistence. A consumed attachment cannot erase a newer edit or alter
the original send journal. If consumption persistence fails, automatic reuse blocks.
An additional 23 router checks pass, including both review routes' operator and
same-origin boundaries and refusal of caller-injected settings/capacity/identity.
Protected design checks pass (109 passed, one existing skip); 14 offline browser
cases are listed across the selected composer fixture and its safe prerequisites.

Focused read-only reviews identified and verified fixes for aggregate source
preparation, creating-login ACLs and one-shot attachment retirement. Protocol,
harness and client builds pass. Local runs use one worker and a 1 GiB heap; full
compilation is delegated to hosted CI after the retained local heap failure.
The context dialog reuses HomeDialog, ConversationAgents controls/styles, shared
motion and UiIcon. Offline browser fixtures retain approved references and add
review/edit/refreeze, Escape focus restoration, narrow overflow/touch checks and
light/dark captures. They are listed, not locally executed; hosted rendered
evidence and independent approved-reference comparison remain required.

Explicit saved-artifact version selection and exact forwarding remain open,
alongside broader milestone qualification. Conversation-so-far review retains
referenced artifact versions through the existing compiler. This candidate,
#1280 and #1279 do not constitute deployment or live user acceptance. The earlier
uncertain live Telos update remains preserved without replay or a completion claim.

## 10 November 2026 multiple-responder source candidate

The replacement owner integrated accepted recovery main `048b3e05` after #1279
landed, preserving the original full/source reviews and all responder additions.
The combined head passed 661 offline application/native recovery checks. A later
trusted-ledger reconciliation identified the remaining singleton observer defect:
removing the last other participant disabled polling, hiding a subsequent remote
join and answer. A component regression reproduced that exact missed answer.
Observation now retains the existing authorized collaboration view independently
of whether the shared composer is active. Auth epochs, audience renewal, abort and
owner checks remain unchanged. The repair and existing real HTTP observer journey
pass with 122 focused/design checks (one existing skip); hosted singleton rejoin
browser cases retain an unsent draft in light/dark desktop/mobile layouts. Current
hosted evidence and trusted verification of both historical findings remain gates.

This separate candidate builds on the long-discussion slice in #1279. It reuses
the approved Defaults, All and multi-selection composer controls. The sending
owner resolves every recipient, verifies every readiness receipt, and retains the
original default/all/selected intent, membership/policy and request identity.
Changing the picker or policy cannot retarget an outstanding request.

The ordinary prompt adapter observes the exact command's durable provider terminal
and native store settlement. Missing custody, pending thread dispatch, ownership
conflicts or unsettled effects yield uncertainty. Observation cannot dispatch,
acknowledge recovery or release a queue. Settlement is renewed on every observation;
loss of previously completed proof becomes uncertain and can later settle again.
Unexpected storage/programming errors remain observable. Shared answer text and
provider context ACK are independent of this outcome observation.

The actual Add-agent/application journey now uses two independent same-account
native threads through seven external-only synthetic native turns: Defaults partial
success, a definitive context-capacity failure, explicit selected retry of only the
failed agent, and an ambiguous later failure. Successful answers remain visible.
The exact ambiguous request remains retained through unmount/remount, observation
and retry with no eighth turn. Conservative conversation-wide effects qualification
may also mark earlier receipts uncertain; it never deletes their accepted answers.

Local evidence uses one worker and a 1 GiB Node heap:

- 67 cases pass across sending-hook, recovery owner and actual fresh-agent UI.
  New regressions forbid clearing the original request because finalized text is
  visible or because settlement proof is lost during the refresh await.
- 21 integration/consumer cases pass, including the separate 27-turn real composer
  journey, ordinary prompt dispatch and transcript presentation.
- Six selected native-store settlement cases pass; the other 72 cases in that
  file were filtered, not executed. Earlier adapter checks passed 56 cases.
- Protocol, harness and client builds passed. Full frontend compilation exceeded
  the local 1 GiB heap; its uncertain run/log are preserved and hosted compilation
  remains required. No full local compile success is claimed.
- Two focused read-only reviews verified the repaired journal/settlement defects
  and current permission/effects fences without remaining concrete blockers.

Offline browser cases cover partial results, uncertainty, reload, selection,
keyboard focus, minimum touch controls and mobile overflow in light/dark themes.
They are listed but not locally executed: the host sandbox blocks browser launch.
Hosted execution, actual rendered artifacts and approved-reference comparison are
required. No protected reference, design token or check is changed.

The shared Stop control now uses the exact retained reply command and a deterministic
delivery-scoped interruption ID through `OrdinarySessionPromptPort.stopOrdinary`.
Current auth, contributor control, account/runtime binding and registry custody
are renewed after an asynchronous import and immediately before the native owner's
atomic compare/claim/interrupt. A claimed native request never reissues an RPC;
requested cancellation remains separate from provider terminal/effects evidence.
An old control response cannot label or block Stop on a new same-owner request.

The actual seven-turn application journey requests Stop while the fourth native
turn is held. Exactly one `turn/interrupt` targets that original thread/turn;
repeating Stop emits none, and cancellation ACK does not make the original terminal.
A concurrent definite provider failure then settles normally, and the explicit
selected retry retains the same native thread. The hook's 17 cases include lost
Stop response/remount and same-owner completed/late-success/late-failure control
races. The prompt port's 23 cases include successor, durable claim, settled,
foreign and revoked owner, plus contributor/account custody changing during a yield.
The permission and response-race findings from focused review were repaired.
Browser cases now render the existing Stop control and retain its intent on reload;
hosted execution and visual evidence remain pending.

Live replies now use a separate authenticated progress projection, independent
of finalized answer persistence. Every source requires the accepted version-2
native mapping, exact command and pinned historical admission. The dedicated
in-progress reader reuses the bounded ordinary visible-block decoder; frozen
prefixes and finalized replies still require their original complete-message
qualification. Reasoning, tool deltas and provider thread/turn identifiers never
enter the public progress response. Current auth, continuous membership, source
availability and exact settings are renewed before return. Per-source refusals
do not prevent later eligible sources; unexpected storage errors still propagate.

The actual application test emits a held external native turn's text delta, waits
for that attributed streaming bubble, remounts and reads it again without another
native turn. It then performs the exact Stop journey. Verified partial text from
the failed turn persists once as a finalized answer beside its separate failure
outcome. The seven-turn count and original failure/retry assertions remain.
The expanded recovery suite passes 59 cases; 15 reply-source cases pass, including
in-progress text, private reasoning exclusion, strict frozen/finalized readers,
wrong command, hidden source, duplicate start, legacy mapping and oversized text.
Five progress-hook cases cover auth-loss publication ordering, verified same-login
restoration, late responses, stale audience and failed reads. Transcript checks
verify attributed live text, visible refusal and exact-source finalization without
hiding another live source for the same delivery. Focused read-only reviews found
and verified fixes for auth epoch/restoration and live/final handoff races.

Protocol/harness/client builds and scoped lint pass. Local full frontend checking
remains limited by the previously retained 1 GiB heap failure. Browser fixtures
include desktop/mobile light/dark captures with live text and Stop, but have only
been listed locally under the host browser guard. Hosted renders and independent
approved-reference comparison remain required. The accepted Claude integration
was preserved when these later source changes were reapplied; none implicitly
enrolls a Claude participant in the Local Codex adapter.

This is unmerged candidate evidence, not full feature completion. Per-prompt
reviewed context, forwarding and remaining combined
qualification remain open. All original 16 criteria and the uncertain live Telos
edit remain retained. No live models, deployment or runtime/device acceptance occur.

## 10 November 2026 long-discussion delivery candidate

The published candidate is [PR #1279](https://github.com/dimakis/mitzo/pull/1279).
It now integrates accepted Claude #1232/main `f7fd876a3dbb44ec252e90fc8ba37e27ea19d968`
after a real conflict. The only conflict was the runtime source-registry revision;
all accepted Claude source and incoming pins are retained. Its ordinary account,
repository preparation, SDK custody and native history paths were checked against
the combined tree. Symposium continues to require its explicit Local Codex adapter;
accepting Personal Claude does not implicitly enroll another collaboration runtime.
Fresh combined CI and trusted review remain required; earlier green jobs are not
approval of this integrated head. The later multiple-responder/Stop commits and
uncommitted streaming work are separately retained and excluded from this PR.
The combined tree passes 66 focused checks across the 27-turn actual composer,
all 52 recovery cases, Personal Claude account/policy/custody and ordinary SDK
owned-runtime consumers. These tests substitute external account/native execution
and make no live subscription/model calls. The source-artifact check passes;
full hosted compilation and CI are still required for the published integration.

Replacement owner `0906bac2-29eb-8ccf-a77c-29783118c415` continues the original
16 milestone criteria on accepted #1276/main `8978f4a1061ef2073967d7691b880af867d85d5e`.
This slice separates the latest-50 display projection from delivery inventory.
`CollaborationConversationStore.pendingDeliveryPage` reads current revisions with
an exact recipient's pending/unclaimed receipt, bounded to 50 records per page
and a fixed upper sequence. `ApplicationCollaborationMessaging` compiles the
complete authorized packet incrementally with a 512 KiB encoded UTF-8 limit.
Ordinary admission, final lifecycle checks and provider ACK remain the owners of
execution and delivery. No schema, runtime, scheduler or automatic turn is added.

`NODE_OPTIONS=--max-old-space-size=1024 npx vitest run
server/__tests__/collaboration-application-ui.test.tsx
server/__tests__/collaboration-application-messaging-recovery.test.ts --maxWorkers=1`
passes **53 tests** locally. Nine added owner cases cover continued sending after
display overflow, 105 pending context records across three pages, owner restart,
exact retry, an old unclaimed reply, plain/JSON-escaped byte overflow before any
acceptance or claim, unlink/rejoin, an old attributed reply with renewed source
visibility, and observable unexpected storage failure. Counts overlap existing
recovery evidence and are not summed as feature acceptance totals.

The existing real application UI journey now executes 26 acknowledged exchanges
through authenticated routes, Git/SQLite, ordinary admission and the native driver,
then sends a 27th turn from the production composer. It waits for that prompt's
exact delivery/command and finalized reply `projectionId` in the actual UI. Its
25-reply display bound cannot substitute for that identity assertion. Only external
account/runtime metadata and native RPC are synthetic; no paid model calls occur.
The original test deadline, approved UI/reference bytes and display limit remain.
Read-only correctness and consumer reviews found no implementation blockers; the
consumer review's final-reply identity fence was incorporated and verified.

This is candidate evidence pending publication, combined CI and exact-head Centaur
approval. The rest of the milestone remains active: Defaults/multiple responders,
per-prompt reviewed context, exact forwarding, streaming, broader recovery and
combined qualification. The live Telos evidence edit remains unavailable/uncertain
under its retained original request; no replay or completion claim is made. Source
landing, offline acceptance, deployment and live user acceptance stay separate.

Initial hosted run `42773240655` failed two checks. The 105-item owner regression
exceeded its unchanged five-second deadline while repeatedly dispatching setup
turns; setup now seeds acknowledged history through the real durable store and
keeps the pending-reader dispatch, page/order/ACK, restart and retry assertions.
The separate real application journey still executes its 27 native turns.
The desktop browser check caught an existing session-launch race: automatic
capability review published a new configuration with identical runtime choices,
making the next explicit host edit look stale before React rerendered. Three
deterministic regression variants failed, then passed after semantic no-op reviews
stopped rewriting configuration. Existing stale-callback checks remain. The browser
now also checks that the selected host stays selected before approval. No deadline,
coverage, design reference or assertion was weakened; fresh combined CI is required.

Accepted main then advanced to #1256 `5886a67d754aa2fd0eba1e018115cb9f78046357`,
which independently repaired the same launch-editor race. Integration adopts its
accepted component and unit tests unchanged, preserves its stronger account/model/
permission browser assertions and adds the two selected-host checks above. The
shared source manifest retains incoming Telos workflow/CLI-policy pins alongside
the unique Symposium history changes. Conflicts and this combined result require
fresh CI and targeted trusted review; stale PR base metadata is not merge evidence.

## 10 November 2026 finalized-reply recovery and complete joining controls

Accepted main `279e6703dedebaeb130993fd6e2657b2aed73c0a` contains #1252's
ordinary directed dispatch and #1261's shared composer, readiness and replies.
The dispatch/UI implementation in draft #1244 (`f8bd8ae`) is superseded by those
accepted owners. Its independent finalized-reply recovery remains unique and is
ported here through `ApplicationCollaborationMessaging`; the obsolete dispatcher,
application routes and UI are not reinstated. Retire #1244 after this replacement
lands, preserving its review and source history rather than merging duplicate code.

The current-main regressions produced eight assertion failures: queued
interleaving, 501 prior messages, over 512 KiB of history, oversized reply text,
over 100 text blocks and a prompt outside the recent shared view. Recovery now
enumerates retained prompts and exact ordinary source mappings in bounded keyset
pages, checks finalized visible text independently, and uses the existing reply
owner to verify pinned native execution and attribution. Ordinary full-prefix
snapshot qualification is unchanged. No read requests inference or redispatch.

Malformed mapping fields, oversized mapping payloads and empty answers have typed
per-source refusals; structured diagnostics omit source text. Later eligible
answers still project. Unexpected storage/programming failures propagate.
Local read-only review identified these additional cases and an unpinned
historical-execution lookup; all were repaired with failing-then-passing tests.
The mapping reader bounds payload bytes before hydration, and reply projection
uses its retained execution fingerprint before promoting a delivery receipt.

Offline checks on this replacement:

- 84 recovery, ordinary-reply and visible-source tests pass, including source
  pagination across malformed/oversized IDs and exact repeated reads.
- 81 application/UI/provenance/transcript checks pass through real authentication,
  HTTP, Git/SQLite, preparation, admission and the native driver. External runtime,
  account declarations and native RPC alone are synthetic. Counts include shared
  fixture tests and are not unique feature-acceptance totals.
- The production composer journey additionally sends a later explicit prompt after
  remount, proving distinct command/delivery attribution and exactly two native
  turns. The recording transport now emits unique turn/item IDs and the ordinary
  `turn/started` event; its earlier incomplete stream explained a missing second
  answer in the fixture. No production transport relaxation was needed.
- Protocol/harness/client builds, scoped lint, formatting, source fingerprints and
  diff checks pass. Approved references and protected checks are unchanged.

Hosted mobile WebKit screenshots at `93ccabec` exposed a remaining Add-agent
footer defect at 390px in the light theme: the explanatory note collapsed into
one-word lines beside the buttons. Independent visual review confirmed the
approved HTML specifies a 72px minimum note track, while component CSS used zero.
The footer now restores that minimum through three shared spacing tokens and
keeps wrapping. A separate, additional `symposium-footer.spec.ts` checks the actual
production preview's note width, footer reachability and overflow at 320/390px and
desktop in light/dark themes; the protected approval tests and ledger are intact.
The design contract (109 passes, one existing skip), 13 protected component checks
and browser discovery pass locally. Corrected renders at `9d3f0cae` passed root
and independent visual comparison: 320/390px dark/light Add-agent footers remain
readable, desktop Add-agent controls align, and Before-joining retains the approved
hierarchy. The current candidate preserves those UI bytes. Retained artifacts:
[mobile WebKit](https://github.com/dimakis/mitzo/actions/runs/42734183215/artifacts/13726154193)
and [desktop Chromium](https://github.com/dimakis/mitzo/actions/runs/42734183215/artifacts/13726961053).
The additional footer browser cases passed in hosted CI. No local browser pass is
claimed; the superseded run's asynchronous Thinking-control assertion failed in
the application unit test and was corrected by awaiting the loaded control.
Current-head CI and trusted review remain separate landing gates.

The complete production Add-agent UI journey exposed two further gaps: retaining
the pending repository ID in the parent aborted the original preparation POST,
and the first application review omitted its required initial joining brief.
The picker now distinguishes its own ID echo from restored requests, retaining
normal external-clear cancellation and changed-model recovery. The joining hook
captures the initial brief before journaling and preserves exact edited/retry bytes.
The application adapter still refuses missing briefs before reading sources.

`collaboration-application-fresh-agent-ui.test.tsx` crosses the real Agents,
runtime/repository picker, local Git preparation, initial review, edited refreeze,
silent join, explicit stale-readiness refresh, shared composer and attributed
native reply. It asserts no initial ordinary command or native turn at joining,
and the exact edited brief in the requested turn. A second independently joined
agent on the same account then receives the prior prompt and attributed finalized
answer before its own explicit composer turn. The two sessions use distinct native
threads and distinct reply commands/deliveries; the pending context receipt belongs
to the second command. Passive reading requests no turn. The fixture mounts the
production listener transport composition; synthetic discovery implements only
external metadata RPC. Native inference is synthetic. No inner owner is replaced.
The combined UI/hook/application checks pass (120 cases including shared fixture
prerequisites); protected design checks pass (109 cases, one existing skip).
The final closure run passes 85 application, delivery, recovery and sending-hook
cases, including durable partial provider outcomes, Stop/terminal observation,
concurrent exact retries and retained uncertainty without replay.

The schema-valid unknown-fingerprint regression also failed before repair and
passes with a typed missing-execution-reference refusal. The ordinary execution
owner retains its original error text/class ancestry; only historical reply
observation translates that specific error. Runtime identity/storage failures
remain observable. CI exposed a private-database access in the corruption fixture;
injection at the append boundary corrects its type safety without relaxing the
validated source writer. Local browser attempts remain blocked by macOS process
registration and the explicit host guard; rendered evidence comes from the
hosted artifacts above.

#1242 is not a remaining dependency: accepted #1266/#1272 supply its retained
operator and callback settlement behavior. The active owner independently
verified those paths (176 checks, 11 existing skips) and retained the stronger
callback-consumer regression in #1257. That evidence is separate from this PR's
current-head CI/review, which remain mandatory before merge.

This qualifies bounded source/offline application behavior and reviewed
presentation only. Physical iOS, live runtime/account routes and the broader
multi-recipient/Defaults milestone remain separate acceptance work. No staging,
deployment or live inference was performed.

## 7 November 2026 interrupted landing and review corrections

PR #1261 was recovered after an interrupted main integration. Accepted base
`c38e253855552edc81711ec02366218d08469d73` and reviewed candidate `2615046`
are retained in its history. Centaur review `5813506337` reported five blockers;
this follow-up corrects their shared-draft, scrolling, source Stop, terminal
recovery and input-validation paths. It remains candidate self-verification
until current-head CI and Centaur verify the changes.

Shared drafts are excluded from ordinary draft discovery, and unresolved send
receipts resist generic discard. The ordinary screen remains mounted as its
first session identity is assigned, while shared state is fenced by source,
client and verified login. The host observes the existing startup/login owner
instead of starting another authentication operation. Ordinary and shared
transcripts keep separate scroll refs, and an active source turn retains its
original composer and Stop callback. Oversized input settles with a visible
refusal and retained draft instead of an unhandled promise rejection.

The native Codex owner now retains its exact provider terminal notification in
the existing event store. Observation reads only the original command's terminal
record; queue consumption, generic cleanup, restart and abandonment cannot prove
completion. Completed, failed and interrupted turns can release the original
send fence without an assistant body. Six owner cases cover definite and
ambiguous outcomes, and the actual authenticated application test verifies the
native notification through the typed observation client. The application and
router rerun passes all 25 cases, including the production composer/remount path.
The focused UI/design/owner run passes 315 tests with one existing skip; its route
subset initially hit the sandbox listener restriction before the permitted rerun.

The two older responsive-screen fixtures now preserve authentication exports and
apply store selectors accurately; their 16 continuity cases pass unchanged.
The new offline composer fixture clicks its auto-closing single-recipient picker
and verifies the selected name explicitly. Protected design tests, ledgers and
references remain unchanged. Browser CI on the reviewed candidate exposed
navigation/remount and authentication-state failures; their rendered follow-up
is still required. Its native repository workflow also failed with diagnostic
`2a6e1e7a-b688-4b8a-92bd-e1c478f1a154` during materialization. The retained log
establishes a roughly 50-second failing phase under host load, but does not
establish the underlying cause; the next candidate must pass that gate too.

The full fresh-agent edited review/refreeze/join UI journey, independent visual
acceptance, runtime/device qualification and parent milestone remain open.
No staging or deployment is authorized by this source landing.

Follow-up CI run `42392570863` passed both formerly failing unit shards and the
mobile Chromium shard containing the approved-design/composer journeys. Its
supplemental coordinator journey exposed an older cancelled-body observation
marker: `<stream>` was parsed as JSON even when a later complete response was
present. The readiness helper now ignores only that exact retained marker.
All four focused observer tests pass, including actual malformed-JSON refusal;
the original complete-response requirements and ten-second deadline are intact.
Current-head CI and independent review are still required after this correction.

Centaur follow-up `5813858175` verified four findings on `2fe0c18` and retained
one terminal-recovery blocker (`CEN-8BC16F8431AD`). Observation now reads the
original receipt's exact durable command outcome even after its recipient is
hidden or unlinked. It retains the command/session identity check, does not
reopen that recipient's transcript, and grants no new dispatch authority. All
28 focused recovery tests pass, including unavailable recipients and uncertain
non-provider outcomes that must remain fenced.

That CI run also passed all four unit shards, native repository/authorization
workflows and composed/joined consumer coverage. Three browser shards exposed
the same initial-history source-release scroll defect: mounting restored history
measured its initial top position as a reader scroll-away. The transcript now
retains initial follow intent until a scroll or source jump changes it. A new
regression test failed before the correction; all 48 focused scroll/source tests
pass afterward, retaining reader scroll-away and source-anchor protections.
Browser verification and final Centaur approval must cover the next published
head; these local checks do not establish either gate.

## 7 November 2026 shared composer implementation checkpoint

Candidate `feat/symposium-shared-composer`, baseline accepted main
`44e872c8a615e30bd75ac9738101dfbfaa1d6aa7`, follows merged #1237 and #1252.
This is implementation self-verification for child `c3ac6bfcc3b29e20`, not
independent acceptance or installed-runtime qualification. Earlier entries keep
their original verification dates.

The production responsive host supplies the existing verified auth and transport
identity to the ordinary collaboration owner. Agents uses the existing review
and repository preparation surfaces. One explicit selected responder is enabled
only after read-only server readiness. Compact linked names survive projection
without treating a linked participant as a pending join. A retained request fence
survives text clearing and remount; observational recovery cannot initiate work.

`server/__tests__/collaboration-application-ui.test.tsx` runs the real authenticated
HTTP/application/Git/SQLite/ordinary dispatch and reply owners, using the existing
review/join/restart prerequisites. The production composer submits exactly one
turn containing the edited brief and selected source, excluding hidden content.
The finalized reply is attributed to the joined participant and survives remount
without duplication. External source/account/runtime declarations and native RPC
are synthetic; DOM scrolling is a JSDOM seam. This test starts after the API join:
the combined fresh-agent UI review/refreeze/join acceptance journey remains open.

The final application/recovery run passes 17 tests across three files with one
worker and a 1 GiB Node heap. Admission can precede the first durable transcript
record; reconciliation now waits for that record instead of rejecting a valid
queued command as a changed snapshot. Its focused regression preserves errors for
unrelated inconsistent histories. Earlier local runs failed the ordinary disk
admission guard when space dropped below its required margin; after the operator
freed space, the unchanged guard and positive assertions pass. No resource guard
was bypassed. The interrupted cleanup/test command had no completion receipt and
is not counted as successful verification.

The messaging-owner omission control fails the unchanged positive composer
assertion while its three API prerequisites pass. Exact app source was restored.
A reply-owner omission attempt coincided with the disk refusal and is inconclusive;
it is not evidence for that owner. Hook tests cover server refusal and exact-request
recovery across remount without resending changed text. Draft tests cover acceptance
without deleting shared recipient/recovery state.

The focused regression command passes another 333 tests across 20 files, with one
skip: the affected composer/joining/presentation/draft components and hooks,
protocol/client projection, ordinary dispatcher/router and existing design
contracts. Protocol/harness/client TypeScript builds, targeted semantic diagnostics
for changed frontend/server sources, ESLint and registered source fingerprint
checks pass. Attempting whole-graph frontend diagnostics exceeded the mandated
1 GiB heap; full builds remain for CI. The final UI application rerun passes all
four prerequisites/composer cases after cleanup of its temporary scrolling seam.

`tests/offline/symposium-composer.spec.ts` adds six cases across existing desktop,
mobile and narrow-mobile projects in both themes. It uses production UI with
intercepted HTTP, no backend/model, and retains screenshot artifacts in CI. Test
discovery passes. Local execution stopped at the repository's sandbox guard before
browser launch, including through the approved escalation route. No browser result
or rendered comparison is claimed; CI or a permitted normal host must supply it.
The approved ledger, reference images and protected design checks are unchanged.

Outstanding acceptance includes the combined fresh-agent UI journey, rendered
comparison, exact-head CI/Centaur review, broad build checks and runtime/device
qualification. The child, milestone and parent remain active. No staging,
deployment or live inference is authorized by this checkpoint.

## 7 November 2026 directed prompt/reply implementation checkpoint

Implementation evidence on `feat/symposium-directed-replies`, based on accepted
main `3079701d8f714945f8478508382e17ff20c61299`. This contributes to the existing
map and does not replace independent acceptance, the approved design, or the
milestone's 16 criteria. Earlier baselines below retain their original dates.

| Milestone criteria                                      | Candidate evidence                                                                                                                                                                                                                                                                | Remaining boundary                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1, 8, 10, 12: ordinary application journey and contract | `collaboration-application-messaging.test.ts` reuses the real authenticated review/join/restart fixture and consumes its original silent preparation through the shared ordinary dispatcher. Exact joining content, explicit prompt and finalized attributed reply pass.          | API/backend journey only; existing shared composer remains disabled. No installed runtime is qualified.                      |
| 2, 3, 11: identity and recovery                         | Original allocation stays intact. Exact concurrent message retries share the same message/command and create only one native turn. Changed requests conflict. Finalized reply projection can reconcile from durable source records; ambiguous command effects are never replayed. | Full crash/restart/Stop/partial-recipient matrix remains open. Existing joining recovery evidence is preserved.              |
| 6, 7, 13: readers, responders and independent execution | Only explicit responders dispatch; pending authorized context is delivered through an ordinary turn. Context delivery waits for its exact native acknowledgement. Reply projection never triggers a response loop.                                                                | Full Defaults/@ fan-out, failed-recipient retries, long discussion paging and independent-account qualification remain open. |
| 8, 10, 12, 15: authority and actual composition         | Unknown recipients and unsupported snapshots refuse before command effects. Revoking reviewed source access during real ordinary preparation prevents another provider turn. Omitting the production messaging owner must fail the unchanged positive API assertion.              | Broader combined Telos regression and native/runtime qualification remain open.                                              |
| 4, 5, 14: approved UX                                   | No UI, reference or protected design-check changes in this increment.                                                                                                                                                                                                             | Recipient readiness, composer enablement, rendered comparison and physical device evidence remain outstanding.               |
| 9, 16: evidence and qualification                       | Focused offline tests use one worker and a 1 GiB Node heap. Real Git/SQLite/app/ordinary owners remain; only external source/account/runtime declarations and native RPC are synthetic. Local dependencies reuse the accepted release, including its native SQLite owner.         | Exact-head review/CI, source acceptance, live account/runtime qualification and production activation are separate.          |

Core test command: `NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run server/__tests__/collaboration-application-messaging.test.ts --maxWorkers=1 --no-cache`.
The three inherited review/durable-read/join cases and new prompt/reply case pass.
Final focused regression run: 190 tests pass across 14 files, one worker/1 GiB.
Protocol/harness/client TypeScript builds, focused semantic checks of five server
modules, ESLint and registered source fingerprint checks pass. Full server builds
and broader tests remain CI responsibilities under the local memory limit.
The first integration attempt stopped at the sandbox's loopback listener fence;
network permission was then granted for the offline HTTP fixture. Broader existing
owned-chat regressions initially hit protected host defaults; rerunning with
temporary `MITZO_CODEX_PRIVATE_DIR` and `MITZO_INTERNAL_TOKEN_PATH` passed.
No permission guard or assertion was weakened to access host configuration.

Landing fixes for Centaur review `5811819783` preserve one command owner for every
queued context packet and refuse overlapping unclaimed reply intent before accepting
a new message. Delayed ACKs in either order and concurrent partial fan-out are covered.
Follow-up review `5811912577` verified those three fixes and identified
`CEN-CC5FB78CE31F`: concurrent identical fan-out requests could race the new guard.
The dispatcher now renews the exact request receipt after context preparation,
before applying that guard. A delayed-first-recipient regression preserves one
message and one command per recipient for both concurrent callers.
Reconciliation skips hidden/unlinked responders and defers oversized ordinary history
without suppressing unrelated integrity errors. Existing timer/peer dispatch retains
tool-failure continuation. The actual-app case also preserves the shared transcript
after hiding its already projected responder. The non-blocking lifecycle cleanup
follow-up `CEN-864F4410A950` remains open: definitive preparation failure and owner
teardown need bounded callback cleanup while uncertain queued commands retain fences.

Broader CI run `42368546667` exposed a test-observer failure in the unchanged
Telos advisor-refine journey: a failed browser response-body read was represented
as the string `<unavailable>`, which permanently poisoned JSON readiness parsing.
The observer now retains a null body; complete real metadata/messages, destination
selection, loading-state assertions and the ten-second deadline remain required.
Actual malformed JSON remains a failure. Twenty-five focused readiness/setup tests
pass, including failed-read recovery and both negative controls. Restoring only
the original marker makes the positive regression fail; the corrected source is
restored exactly afterward. A local attempt at the actual browser journey stopped
at Chromium's macOS Mach-port sandbox permission fence before its assertions, so
it is not positive application evidence. The retained browser journey remains a CI
gate. Body-read failure is observed; its underlying cause was not retained.

The omission control temporarily removes only `messaging: collaborationMessaging`
from the real app mount and restores the exact source in a finally block. Its raw
receipt is retained in the task checkout's `.scratch/messaging-owner-omission.txt`.
An earlier control failed before app initialization because the local native SQLite
dependency was absent; that invalid control is retained separately, not counted as
owner-omission evidence. The release's existing native dependency was reused before
the valid control. This is implementation self-verification, not independent review.

### Landing integration with accepted main 0ea37beb

The prior candidate `736993dbe87368291ada8436389e84ebf828748d` passed all 33
CI jobs in run `42369675317`, including the actual advisor-refine browser journey,
and received trusted Centaur final LGTM/merge review `5812085243`. Main then
advanced to accepted `0ea37bebba1528025f14b0d2ae099f0eefa69067` (PR #1254),
which retains ordinary-session tool authentication across browser disconnects.
The application code merged automatically. The sole registry conflict preserves
both sets of registered sources, adds the accepted session-library operator test,
and renews all fingerprints with runtime revision
`v1.0.942-symposium-directed-prompts-integration`.

Read-only correctness/security integration reviews found no blocker in the
combined session ownership, revocation, queue and dispatch fences. Focused semantic
checks report zero diagnostics across six affected production modules. Combined
local regressions record 287 passes, 11 skips and 19 failures across 19 files;
all failures occur in the native AgentCommunication fixture during owned-runtime
admission (`Owned local Codex runtime unavailable`), before those assertions.
The other 18 files pass. This is not counted as a green local suite or evidence
that the failed native cases work. Fresh combined-result CI and targeted Centaur
integration verification remain required on the published merge candidate; the
prior head's approval does not satisfy those gates.

## Executed application baseline

Accepted main `dcbad645a3179731de96957299bb775eb094bff8`, tree
`79964ceb666ddc2e23f0e7f2a02520fcdad31296`, is the baseline for this recheck.
Accepted main subsequently advanced to `1accf01a89c42460163f43b0a95f71f4534f19a7`,
tree `dbe5a3db1a2a804eb4df6c4dcd16b05cdf77f987`; the executed application results
below remain bound to `dcbad645`, with no blanket rerun for that base change.
All632 reviewed source fingerprints on `dcbad645` match `v1.0.333-prompt-startup`. Before this
map edit, all248 paths from accepted C#1022 were byte-identical; prior source,
failed diagnostics and captures are retained. The five Symposium source PRs are
merged, including app#1023 at3882cd21, UI#1021 atc3f0d874 and C#1022 atd4660966.
Source acceptance remains separate from a complete positive application journey.

**Two existing actual-app read-only cases pass** on the clean accepted source:
real authentication/cookie and transport ownership, committed begin response loss,
concurrent exact retry, same-root restart, actual unused workspace preparation,
observational review200 with exact brief/settings and **unverified capacity**;
then exact durable visible bytes/digests, private-history exclusion, typed HTTP,
restart and hidden-source refusal. The known-unavailable joining/reply case was
explicitly filtered, never counted as passed. Prior6dd import timeouts remain
historical and are not the current baseline failure.

**Both required-owner omission controls fail as intended** with original assertions:
omitting only the real app review factory returns503 instead of200; omitting only
the durable-reader injection makes the original exact-read assertion reject with
API500 while the observational case still passes. Exact app bytes are restored
in both controls. An initial receipt-wrapper expectation of503 for the durable
control was incorrect; its actual500/failure was retained without a test rerun or
assertion change. [Source/results/controls and raw hashes](symposium-acceptance/current-app-dcbad-baseline/verification.json).
Bulky raw Vitest JSON/logs stay in C's task artifacts at the named path in that receipt.
All runs use one worker/1024MiB, synthetic data/configuration and recording external
boundaries; no model/provider calls, browser/Rust campaign, runtime installation,
staging or deployment occurred.

The parent and milestone remain ACTIVE; all16criteria are unchanged. Root handover
`87d62d149bdec6bed5b826884d4aa29d@r3` binds current source and ownership. Core owns
native/account/session/runtime/preparation/app composition; C remains the sole
independent acceptance/map owner under the current feature owner. No new harness,
worker, phase tree or second product path is introduced.

## Independent preparatory source checkpoints

These candidates do not replace the accepted application baseline above.
S6 `3079e3bb25c467f487719b6eeba5a40b1e835a11`, tree
`5621c21dfa8beaedd4e55e2cf0c59ed41c59ef7f`, consumes the exact core type contract
from `36423f8a`; C independently checked byte equality, all639 source pins and
six producer log hashes. The optional read-only router preflight checks signed
request lifetime/currentness, but even a successful result and final fence still
return503 before staging or admission. Producer34passes/4suites and7meaningful
red failures are component evidence with stubbed resolver results. Earlier
unexplained501 diagnostics are retained; no cause or product fix is inferred.
No production resolver or prepared-command consumer is supplied by this candidate.
[Bounded S6 source/assertion/provenance inspection](symposium-acceptance/source-preflight-checkpoints/s6-preflight-3079-inspection.json).

Published stacked [#1060](https://github.com/dimakis/mitzo/pull/1060) at
`07014d87b97a1faf012817d6ffcc6a94a383fe96`, tree
`ec77d838d55fa28506cd17762d1d8638c527a487`, carries native60
`bb5bedc2e334700b930352c58e6c50660c173e2e`, tree
`b28e456e2791162cd7cbb6b4443e339e5e4aad03`. All60 published patch hashes match;
the prior54 entries/order are unchanged. The two new partitions share source-owned
config selection with actual startup/config-change and ordinary/per-step tool
filtering. Enabled memory/web tools remain unresolved. Config-aware capture and
renewal currently have helper/test callers only; these declarations do not settle
context instructions or complete production request preparation/count/consume.
Ordinary contributor callbacks still execute before tool filtering; callback-free
claims apply only to pre-session capture/renewal. C inspected source, assertions,
callers and workflow without running Rust or duplicating the producer campaign.
[Bounded native59/60 inspection](symposium-acceptance/source-preflight-checkpoints/native60-source-inspection.json).

At the preparatory source checkpoint, existing native CI39339195266 and
CI39345244430 were still unqualified. Native54 has since completed independent
qualification below; native60 has since also qualified on both OS, as recorded below. No source inspection, producer
component result or pending CI closes a complete application criterion. Core has
consumed C's prior exact baseline commit `4a875f7c` as `6af8b2bd`; this subsequent
checkpoint keeps that handed-off commit immutable. Parent and milestone stay ACTIVE.

## Initial brief and retained-version correction checkpoints

A's `337be9b17e458a227b122ed2893b1d0bf8f19afe`, tree
`a720065cc307092b299dde3f555a9eed71c7bd68`, fixes the missing initial brief
at the application-adapter boundary. Explicit Review now supplies approved editable
copy; same-setup Back/retry/reload retains exact saved brief/request bytes, including
existing empty/whitespace behavior. A changed setup remains a new intent and may
seed new copy. Protected approved references, setup/browser tests and ledger bytes
are unchanged. C found no additional concrete blocker within this fix. Producer
89focused passes and108design passes/1existing skip overlap and are not summed.
The mounted fixture stops at capture refusal; the typed adapter uses fixture HTTP
responses. No production joining owner/catalog/bootstrap or successful application
journey is installed. [Independent source/assertion/provenance review](symposium-acceptance/a-initial-brief-337be9-inspection/inspection.json).

B's retained-version seam `d2e547ca1082b544042552096d66919829ce6c34`, tree
`47512694447fb25170b6eec4672df09aa3e8c545`, reads exact real retained-owner
metadata/bytes and metadata-only revision pages, with injected association/access
ports still owned by core. C found two final-callback holes: equal-length bytes
could change after the last hash, and a last page callback could change an earlier
entry after its metadata check. The original findings and initialization-only red
log remain preserved. [Original independent review](symposium-acceptance/b-joining-retained-d2e547-inspection/inspection.json).

Correction `8bd7c1bf6969a2f82a1df5af4d0bf8c769f5bc27`, tree
`4e10c63ae0c6026d789ca6d49eb06c5e4a33e9f1`, closes both findings at
**source/assertion level**. The final read fence ends with the existing owner's
callback-free bounded bytes/hash/privacy renewal. The final page pass compares
all actual metadata/privacy after all authority callbacks, without content hydration.
Two new counterexamples fail behaviorally against the original source in retained
producer logs; corrected producer coverage is31passes/0skips. C verified immutable
source, assertions and log/hash provenance, with no test execution. This does not
qualify core's actual canonical association/access/save composition, cross-owner
ABA, transcript removal, compiler/refreeze/recovery or application joining.
[Independent correction review](symposium-acceptance/b-late-callback-8bd7-inspection/inspection.json).

A's later `a6173f46c693a3c7e35b696cbe801e6ce3093f20`, tree
`7e82e91c8fb935518fe848ca52b94d7ffe5c6b6d`, mounts the genuine typed
observational source-setup GET in both chat pages for the active ordinary source,
verified login and live client. Referential owner, auth epoch, actual auth/base
getters and abort checks fence late auth/source/client/base results. Read retry
preserves the editable draft/footer, with Review still disabled without a genuine
joining owner. All11backend dependency paths match45ff; prior337brief/review
helpers and approved references are unchanged. Producer54focused passes and
108design passes/1existing skip overlap prior totals and are not added. No catalog,
target journal, source preparation or joining owner is mounted. The eventual strict
combined harness must bridge the actual authenticated GET, without ignoring an
unexpected request or fabricating canonical/capacity state. [Independent frontend read review](symposium-acceptance/a-source-setup-a617-inspection/inspection.json).

## Canonical source setup and correlated preview

Core source-setup `45ffb126526e7b944970805b78ba4a4789304415`, tree
`66a0140252e0d12f4370a383c67bca63ad20bb4d`, parent7195, supplies an
observational canonical lookup through the existing store, typed client and real
application router. It verifies the original first durable begin receipt's strict
result and canonical fingerprint, original source, and current membership. Legacy,
missing/corrupt proof, foreign origin and multiple associations fail closed; absent,
hidden, Symposium and imported sources are unavailable. Current cookie/operator
and live-transport identities are checked before and after the synchronous read.
Strict public schemas and typed responses bind the requested source; this selects
relationship metadata without a source-content or execution grant. C found no
additional concrete blocker in this bounded seam and rehashed all635reviewed
source pins with zero mismatches. Producer49passes/4files and19pin passes remain
component evidence: the actual-router fixture uses synthetic auth middleware,
and the typed client uses fake HTTP. [Independent source-setup review](symposium-acceptance/core-source-setup-45ff-inspection/inspection.json).

The child preview extension `d94ddfbda4d0a0b418f444b05769da830fc72bbd`, tree
`d3adac32899255c1e9e36cef9e73c5d380075b9c`, adds an optional caller-known UUID
and private server-derived exact-intent fingerprint in the existing workspace row.
Original-intent retry reads that row without new metadata inspection or runtime
capture; changed intent conflicts. Concurrent capture uses INSERT DO NOTHING,
then checks and reauthorizes the actual winner and compares the full persisted row
before returning it. The first committed pin/proof/lifecycle cannot be overwritten
by a losing capture. No checkout, Session, grant or second store is introduced.
C found no additional blocker; all635source pins and protected approved references
match. Seven meaningful producer red failures precede green51passes/5suites;
final28passes overlap and are not added. Earlier mapped-type logs contain actual
literal-widening and mixed-spread errors, corrected by final literal types and an
explicit request-ID branch; retain them separately from package-resolution setup
diagnostics and producer-reported successful final tsc. The race fixtures use two
SQLite owners in one process; they are not process-crash proof. Changed later
binding may conservatively conflict with original preview intent. No browser
lost-response/reload or successful application joining is qualified by this review.
[Independent preview-correlation review](symposium-acceptance/core-preview-correlation-d94d-inspection/inspection.json).

Published [#1064](https://github.com/dimakis/mitzo/pull/1064) is
`9745d7c21f949c4d2fbbf32fc1163632a9b03f42`, tree
`51ef72c1179fdeebd149c00bf62ecd2656d03a9b`, with parents d94d and accepted
`a51e2d102f448dec77e1272700583d44da500629`. C verified exactly eight incoming
accepted paths: five nonshared paths are byte-identical to accepted S5b; all
nonshared API paths match reviewed d94d. The combined workspace file preserves
accepted lazy custody methods and all reviewed preview logic exactly; removing
only the accepted27line additions restores the entire d94d file. The protocol
barrel adds only the accepted ordinary-workspace export. All637actual merged
source pins match the exact parent-key union, including combined workspace/index
bytes; protected references are unchanged. No additional merge-preservation blocker
was found. Producer119focused passes overlap prior51/28; normal exact-head
CI, trusted review, App, current base and actual merge slot remain required.
This publication does not supply production joining or native admission.
[Independent publication/merge proof](symposium-acceptance/source-api-1064-publication/verification.json).

## Native60 independent execution qualification

Existing [CI39345244430](https://github.com/dimakis/mitzo/actions/runs/39345244430),
attempt1, independently qualifies native60 on both OS against the exact published
`07014d87b97a1faf012817d6ffcc6a94a383fe96` source above. Both actual checkouts
are `860744dd44adbb569cfd81bf7cd1b6a742431f04`, with published tree
`ec77d838d55fa28506cd17762d1d8638c527a487`. Both reconstructed native trees
and retained source-evidence bytes match the published60patch proof; downloaded
artifact ZIP digests match Actions. Reconstruction and formatting pass.

| Platform    | Executed passes | Nextest skipped | Fixture duration |
| ----------- | --------------: | --------------: | ---------------: |
| Ubuntu24.04 |           6,142 |              11 |       2,584.389s |
| macOS26     |           5,921 |              27 |       2,211.962s |

Zero failures; all12new named55–60cases pass on each OS. **Platform and source
totals overlap and are not summed.** Nextest11/27exclusions remain explicit despite
executed-only JUnit reporting zero skips. The single-attempt factory driver is one
case, without inflating internal subprocess scenarios. [Both-OS qualification](symposium-acceptance/native60-source-inspection/qualification.json),
[Linux detail](symposium-acceptance/native60-source-inspection/linux-qualification.json),
[macOS detail](symposium-acceptance/native60-source-inspection/mac-qualification.json).
Raw logs, ZIPs, JUnit and hash seals remain in C's task artifacts under
`implementation-evidence/native60-source-inspection/`. C only downloaded/read
existing terminal evidence; no local Rust, test, retry, dispatch or model call ran.
This qualifies bounded native input/closed-source/config-selection/ordinary
single-attempt factory fixtures. Complete inventory, source/instructions,
account/route/model limits, genuine request/count/consume, host revision/release,
installed runtime and full application joining/delivery/replies remain open.
Native70 has since qualified separately below. Native73/76 terminal failures and
current77 execution remain distinct from this60 fixture qualification.

## Native60 trusted finding and exact isolation correction

Existing trusted review on published07014 reports blocking `CEN-487055AFEF4D`:
fresh MCP capture checked the manager registry even when ordinary isolated startup
would select a separate `IsolatedSessionExtensions<Config>` registry. Native60's
green fixtures remain valid source-bound results; they do not resolve this missing
case or qualify complete inventory. [Retained trusted finding](symposium-acceptance/native60-isolated-registry-review/inspection.json).

Core correction `ea6416336b5275e8a3c13e508f1c68df289f75a3`, tree
`203e5ac78c2f6653251ee6828163d1234897216f`, has sole parent native60
`bb5bedc2e334700b930352c58e6c50660c173e2e`. It shares the actual ordinary
isolation helper: explicit policy wins, otherwise explicit or manager-default
source uses the same Guardian classification. Effective isolation refuses before
manager registry/environment/plans. Supported inherited capture retains resolved
source and explicit inherited policy in original options, preventing default
substitution on release. C verified the entire ordinary ThreadManager file is
otherwise byte-identical after helper extraction; startup behavior is preserved.
Two authored, unexecuted actual-owner regressions cover the real unresolved
isolated registry, no inherited-plan/runtime/thread/event callback, explicit and
default Guardian choices, retained default changes and explicit precedence.
The finding's mechanism is **closed at source/assertion level only**; exact changed
source CI and trusted review remain required. This correction's lineage is native60;
it is neither historical native61 metadata nor a global ordinal. The same change
on later77 lineage is separately recorded as865e2f6. [Independent correction review](symposium-acceptance/native60-isolation-fix-ea641-inspection/inspection.json).

The correction is published on#1060 at
`09899212aa36458449c66b0f90be4e66e0ec1bbe`, tree
`739bdbf94603ac487e986960b1557e63a73c0921`. C verified all61patches, unchanged
prior60order/bytes, actual ea641 native tree, unchanged both-OS workflow and all641
actual host source pins. At the recorded GitHub snapshot only the automatic stacked
writer was skipped; no exact-head host/native execution run was observable, so no
run ID or execution was inferred. The feature owner subsequently identified a real
advanced-feature-dependency conflict suppressing pull-request CI; core owns that
normal dependency merge and its new exact head. This is source/publication evidence
only, with no old-head retry, workflow change or higher-campaign reset.
[Independent correction publication](symposium-acceptance/native60-registry-fix-publication/verification.json).

## Native54 execution and separate native70 publication

C independently qualified existing [native CI39339195266](https://github.com/dimakis/mitzo/actions/runs/39339195266),
attempt1, against published head `0fd922430b1452d706f361bfde72a47eea584bda`,
tree `1fd6f34a9ce78096cfa4815e3fd121f34e461e68`. Both actual CI checkouts are
`024b4e044035ac6acb5465864788cd58fd0191f7`, with that same tree. Each platform
reconstructed native `557ce440b823868ea853e583c2277d16ec0af726`, exact tree
`77a800c70646406a5165ea56237219e56518c36b`, from the pinned upstream and54patches.
Retained source-evidence bytes match the published proof; downloaded artifact ZIP
digests match the Actions uploads. Reconstruction and formatting pass on both OS.

| Platform    | Executed passes | Nextest skipped | Fixture duration |
| ----------- | --------------: | --------------: | ---------------: |
| Ubuntu24.04 |           5,839 |              11 |       2,300.109s |
| macOS26     |           5,618 |              27 |       1,983.451s |

Zero failures. **Platform totals overlap and are not summed.** Nextest's overall
summaries retain the skipped counts above; JUnit contains the executed cases and
reports zero skips, so it must not be used to erase those exclusions. All four
named extension-inventory cases pass on each OS: unresolved contributors refuse
without discovery, fixed metadata shares the original executor, exact registry
renewal rejects rebuild/addition/ABA, and an empty registry differs from an empty
state-bound contributor. [Independent qualification](symposium-acceptance/native54-independent-ci/qualification.json),
[Linux detail](symposium-acceptance/native54-independent-ci/linux-qualification.json),
[macOS detail](symposium-acceptance/native54-independent-ci/mac-qualification.json).
Raw logs, JUnit, original ZIPs and hash seals are retained in C's task artifacts
under `implementation-evidence/native54-independent-ci/` and in the linked CI run.
C downloaded/read existing evidence only; no local Rust, model call or CI retry ran.

This qualifies the **extension-only inventory protocol**, not complete Core/MCP/
production tool inventory, native capacity, account/model limits, exact request
count/consume, installed runtime or positive application joining/delivery/replies.
The separate local host integration `26bc6702` preserves all16HA and all5native54
nonmanifest paths byte-for-byte, plus the exact union of both parents'634valid
source pins; its changed host still requires normal exact-head CI/review/base gates.

The later [stacked#1061](https://github.com/dimakis/mitzo/pull/1061) is published at
`691af045d5dfd8ac99904f85a5f530ef8721f892`, tree
`72e885406ea11c940295fa5f7d1f18857bfa88b5`, over unchanged#1060. Its native70
source is `d615a63d687555242ede9cb3874d2699f99520c3`, tree
`9ce8eecf782809ae5d33f63715000e8396ab2e55`. C verified all70published patch hashes,
unchanged prior60entries/order, the actual native Git tree and unchanged both-OS
workflow coverage. The three paths from exact C commit `bd3425f7` are byte-identical
in the publication, consumed as `f5fdf008`.
[Independent publication/source proof](symposium-acceptance/native70-publication/verification.json).

C's bounded61–70 source inspections cover private native metadata projection,
its committed None/User source restriction, actual utility/shell/resource/
collaboration/tool-mode/exposure/code-mode planner extractions, native credential
custody and the actual ModelClient body seam. The thread-source finding and stale
parent imports have exact committed corrections; original diagnostics remain
retained. Extracted registration/policy bodies match after named typed-input
substitutions, and effectful wrapper ordering is preserved. Runtime metadata
getters still require their real binding owner; a typed flag is not source or
execution authority. These are source/assertion receipts, with no C Rust execution.

Existing [native70 CI39348949832](https://github.com/dimakis/mitzo/actions/runs/39348949832),
attempt1, now independently qualifies both OS at the exact691af045 publication.
Actual CI checkout `b560a7ee0d7ee9c0b9d85d74ae186017dd174b96` has the published
`72e885406ea11c940295fa5f7d1f18857bfa88b5` tree. Both retained source proofs
match publication; artifact ZIP digests match Actions; reconstruction and formatting pass.

| Platform    | Executed passes | Nextest skipped | Fixture duration |
| ----------- | --------------: | --------------: | ---------------: |
| Ubuntu24.04 |           6,148 |              11 |       2,377.782s |
| macOS26     |           5,927 |              27 |       2,004.885s |

Zero failures; all six new61–70named fixtures pass on each OS. **Overlapping
platform/source totals are not added.** Overall nextest11/27skip exclusions remain
despite executed-only JUnit zero skips. [Both-OS qualification](symposium-acceptance/native70-published-ci/qualification.json),
[Linux detail](symposium-acceptance/native70-published-ci/linux-qualification.json),
[macOS detail](symposium-acceptance/native70-published-ci/mac-qualification.json).
These qualify bounded public-body/metadata, credential-custody and ModelClient
fixtures plus planner source compilation. They do not resolve the native60 trusted
registry finding or qualify changed isolation source. Host CI39348949899 and final
normal base/review gates remain separate. Stacked
status-writer skips do not confer final review approval. No production prepare RPC,
complete native request/account/currentness/limit/count/consume or actual full
application journey is established. All16criteria and ACTIVE statuses remain.

## Native73 publication and later guarded-CAS source

The next stacked [#1062](https://github.com/dimakis/mitzo/pull/1062) publication is
`5bdbce1b02266e92967441f0ef57d323ed992650`, tree
`64f41d948d23a4ef1fff1f18c47e91bd236b992c`, over unchanged#1061. Its native73
is `311b9ae9c07874d9ff5964e95629e057f337dd9d`, tree
`9e17d7d58b5a2e264520c9b923567c8789a1c123`. C independently verified all73patch
hashes, unchanged prior70entries/order/bytes, actual native Git tree and all five
published paths from exact C `264ec3ff`, consumed as `50de568b`. Both notes and
goal extension packages are added to both-OS fixture and formatting scope, with
all prior packages retained; the real goal backend integration target remains
auto-discovered. [Publication/source proof](symposium-acceptance/native73-published-ci/verification.json).
Existing native CI39351558521 must supply exact-source execution evidence for
the seven new notes/goals/pending-gate fixtures. A successful compile-only status
or stacked status-writer skip does not establish fixture/final-review approval.

Native71's registered notes/goals plans share actual configuration owners and
keep enabled sources unresolved, including runtime-unavailable cases. Capture
precedes ExtensionData session/thread stores; goal's native StateRuntime already
exists for installation. Neither this partition nor selection renewal proves
whole-request config ABA, instructions or source authority.
[Independent notes/goals inspection](symposium-acceptance/native71-notes-goals-inspection/inspection.json).

Native72 adds an effect state to the **existing** StateRuntime prepared-request
ledger. Move-only, pool/record/nonce-bound pending claims withhold the executable
attempt. Transactional release and permanent refusal serialize on the same row;
refusal retains consumed/committed state, and API/SQL fences cover receipts and
continuation. Ordinary and legacy rows retain uncertainty. This primitive does
not implement the host's original canonical revision/ABA proof or actual release
authority. C found two fixture gaps: release success was not forced, and sampling
aliases were unexercised. Native73 corrects both with actual-owner forced
release-first/restart coverage and pending/refused continuation refusal plus a
released predecessor positive. Those findings are **closed at assertion level**;
original72 diagnostics are retained.
[Initial pending-gate inspection](symposium-acceptance/native72-pending-gate-inspection/inspection.json),
[exact73 fixture correction](symposium-acceptance/native73-gate-fixture-correction/inspection.json).

Later local native74 `71295552`, tree
`81af76eec430a61430dfc112073ef67128e6dc99`, adds a lifetime-bound synchronous
commit operation over the actual SQLx locked handle. C checked SQLx0.9 dependency
source against locked crate archive hashes: worker FFI exclusion, private
parameterized SQL, transient copies, RAII statement finalization, row counts,
raw transaction bookkeeping, FULL/WAL selection and nonpooled cleanup. No
concrete unsafe ownership defect was found within this source scope. Cleanup
rollback may complete asynchronously; no unfinished connection is returned to
the pool. This is not compilation or physical crash/power-loss qualification.
[Guarded-CAS source inspection](symposium-acceptance/native74-sync-cas-inspection/inspection.json).

Native75 `68d9e80a`, tree `2487593b071f2ed84a6e134c7222d439c35a6645`, connects
that synchronous commit to the actual ordinary ModelClient's AuthManager. C
verified the original session/provider/origin gate and body-format tokens are
unchanged. Database acquisition/validation awaits precede auth locking; the
concrete callback executes both updates and COMMIT inside the real credential
read guards. It returns no future/epoch and crosses no host RPC under those locks.
Synthetic actual-owner fixtures cover positive, foreign-owner, logout and race
outcomes; their numeric/request/account data is not authority. The bridge closes
only the credential partition at source level, not request/account provenance,
other source guards or effect release.
[Ordinary credential bridge inspection](symposium-acceptance/native75-ordinary-credential-cas-inspection/inspection.json).

C also found that74's original “durable before return” fixture checked only
in-memory flags inside its guard. Native76 `f75d65a1`, tree
`bd05b3b6597fe5640b41363e4b2d351dff060d53`, adds an independent preopened read-only
connection/thread that must observe actual consumed/committed/pending row values
**before the synchronous callback exits**. COMMIT deferred beyond the guard would
fail that assertion. Only35test lines changed; the finding is closed at exact
assertion source. [In-guard persisted-observation correction](symposium-acceptance/native76-in-guard-observation-correction/inspection.json).
These74–76 inspection receipts contain no Rust execution; earlier CI cannot
qualify them. The later [#1063](https://github.com/dimakis/mitzo/pull/1063)
publication at `390d259c978e2de80e641ea7c9265e2cd3ca7a48`, tree
`7882ba764e44fd879d2bddade4601c033dfae265`, carries native76
`f75d65a1a6133ed3eecc42b92c9f74e84741e835`, tree
`bd05b3b6597fe5640b41363e4b2d351dff060d53`. C verified all76patch hashes,
unchanged prior73entries/order/bytes and workflow, actual native tree, and
coverage of the five new guarded-claim/bridge fixtures. Existing native
CI39353493313 must supply its own execution evidence; no earlier result qualifies
this source. C's preceding `0d1de9a4` docs were not consumed in this publication.
[Independent native76 publication proof](symposium-acceptance/native76-published-ci/verification.json). C ran no Rust, SQL experiment, model/provider call or new
campaign while inspecting these boundaries.

The canonical retrospective original-revision proof R, private operation/sample/
request/witness/runtime binding, remaining native/source/account/route guards,
authoritative model limits, complete request/count/consume and production RPC/
admission/release remain required. No actual positive application join/delivery/
reply is established. Later accepted-main and#1058head advances remain separate
from the executed dcb application and old0fd native54 receipts. Cancelled26bc
follow-up CI is retained as supersession, with partial logs and no invented pass
or source-failure qualification. Existing60/70/73first-source observations remain
separate. All16criteria and ACTIVE statuses are preserved.

## Terminal73/76 campaigns and separate77 correction

Existing [native73 CI39351558521](https://github.com/dimakis/mitzo/actions/runs/39351558521),
attempt1, failed on both OS before fixture execution:22E0659 ambiguous `assert_eq!`
errors in `prepared_request_effects_tests.rs` per platform. `cargo test --no-run`
exited101 and formatting was skipped. Actual retained artifacts match published
source proof and Actions digests. Original assertion-level73 corrections and the first sealed Linux diagnostic remain
preserved unchanged, including core's adopted raw diagnostic; they never implied
compilation qualification. [Both-OS terminal evidence](symposium-acceptance/native73-published-ci/terminal-qualification.json).

Old [native76 CI39353493313](https://github.com/dimakis/mitzo/actions/runs/39353493313)
ended cancelled: Linux actually failed compilation with36E0659 errors,22in effects
and14in guarded-commit fixtures; macOS was cancelled during standalone helper
compilation, before fixture execution. The macOS cancellation confers neither a
pass nor a source failure. C did not cancel/retry either job. Artifacts retain exact
published source proofs and verified ZIP digests. [Separate76 terminal evidence](symposium-acceptance/native76-published-ci/terminal-qualification.json).

Native77 `1d8ea29eea323d0ebe2112e76ba49a7e152a8f14`, tree
`61df68bdcee6a1939367e2ed54e61082d4ef3241`, adds exactly two explicit
`pretty_assertions::assert_eq` imports to those child fixtures. Assertions, case
bodies and actual parent module are unchanged. The named resolution mechanism is
closed at source level; compilation and fixture execution need new-source evidence.
[Independent two-line correction](symposium-acceptance/native77-explicit-assertions-inspection/inspection.json).

Updated#1063 is `dd5edbd2799885760ae2df9e5eaaf62bff590c92`, tree
`e07d1ba85c086b31897a50d1331dce7131623e7e`, carrying this77source. C verified
all77patch hashes, unchanged prior76entries/order/bytes and both-OS workflow, exact
GitHub head, and C0d1/ee3adoptions asfcefcdc5/ea12f06f. Both adoption aliases preserve
their exact original paths; the final16unique paths take the later ee3version of
ONE map. Existing native CI39357179342 is pending independent qualification;
stacked status-writer skip confers no final review approval. No old failure, earlier
green result or source correction is transferred to this campaign.
[Independent77 publication proof](symposium-acceptance/native77-published-ci/verification.json).
All raw logs, ZIPs, JUnit, source copies and hash seals remain in C's task artifacts.
C read existing evidence and immutable source only; no Rust/test/build/model/provider
call, CI retry/dispatch, deployment or new review campaign ran.

## Exact retained-context and corrected native checkpoints

These later source reviews and existing CI results supplement the `dcbad645`
executed application baseline. They do not replace that baseline or complete any
of the16canonical criteria. Original failed logs, JUnit, ZIP digests, immutable
source copies and producer diagnostics remain in C's task `implementation-evidence`
directory; compact source-bound receipts are versioned here. No C test, browser,
Rust build, model/provider call, new review, workflow retry, dispatch, cancellation,
staging or deployment was performed for this update.

### Kind-aware selections, labels and private bootstrap

Core `9eb0f9d10344770b55bf209cf120f6715791413b`, tree
`80d7c5286daa689a25fa5bf149cb44f64c8ad542`, adds strict tagged retained-version
selectors, independent frozen metadata/provenance and kind-aware duplicate identity
in both compiler and actual snapshot store. Legacy bare selectors retain their
original inline meaning. [Independent source review](symposium-acceptance/shared-retained-kind-9eb0-inspection/inspection.json)
preserves initial schema/typing and save-regression failures; producer counts are
overlapping component evidence, not an application pass.

A `85749b7b4b375a0a439cf266d8e61e23aa71a90c` adds matching private selection,
labels and recovery. C found that the existing Selected subset check accepted
unrequested extra artifacts. [Original HOLD](symposium-acceptance/a-artifact-kinds-8574-inspection/inspection.json)
is retained. A `a2717e2e4703667fc2770e9bebfc45824e987583`, tree
`73c25e1b2592e21e4ce4b5aefcc33ff89d522fc0`, requires exact sorted kind/id/revision/
SHA sets and rejects duplicate pins on either side; So-far retains its subset rule.
The requested extra-pin and equal-count duplicate controls are meaningful original
REDs. [Exact Selected-set correction](symposium-acceptance/a-selected-set-a271-correction/inspection.json)
is closed at source/assertion level only.

C separately found that shared label trimming changed actual retained titles and
filenames, causing valid whitespace metadata to fail exact UI comparison. The
[supplemental finding](symposium-acceptance/retained-label-normalization-finding/finding.json)
corrects the earlier bounded no-additional-blocker conclusion without rewriting it.
Core `fe0257685b9111b49f56e7434c004a699d9f13c2`, tree
`90ac7408d8ba64c00ded291da458f37f411b310c`, preserves retained labels with bounded
nonblank refinements and leaves legacy inline trimming unchanged. Pure-schema RED
and real-store whitespace round trip are retained.
[Source/assertion closure](symposium-acceptance/retained-label-fe025-correction/inspection.json)
requires both this correction and A's exact-set guard in the composed candidate.

A's bounded [retry-focus correction6bf339f3](symposium-acceptance/a-retry-focus-6bf3-inspection/inspection.json)
moves focus to the existing loading status when Check setup is removed, with the
original focus-body RED retained. Its producer UI/design counts are fixture scope.
A `21130dac32ce76cd2d5628d3a79cf004a05a11ac`, tree
`9309817ba47102065bbdcb58dfa4b8159f516aa4`, supplies a private, unmounted typed
begin resolver. It journals original IDs before POST in a strict v3 wrapper at the
existing authenticated source key, rereads canonical state after loss/reload and
checks concurrent journal replacement. No fake draft/membership/capacity is stored.
[Bootstrap inspection](symposium-acceptance/a-bootstrap-2113-inspection/inspection.json)
keeps caller retirement/abort and eventual mounted acceptance open.

### Actual retained owners and observational catalog wiring

Core `427b3a2b2b3b9a3f338be3a53b4b3063c632de1b`, tree
`0f5c1ae1aec89ac192df9713717652b865cb29e1`, composes the actual opened visible
prefix with existing retained revision ownership, canonical source-origin relation,
current Work privacy and rendered exact-version links. So-far refuses unversioned
references; Selected may choose another exact version of an associated artifact.
Final callback-free fences check all retained metadata/association/raw bytes after
all authority callbacks. Real owner fixtures corrupt earlier bytes or delete its
only origin during later callbacks and require refusal.
[Independent owner review](symposium-acceptance/retained-source-427b-inspection/inspection.json)
keeps cross-owner admission and complete ABA authority unqualified.

Core `269f8b5be12e49136a45b08ece4c89cb2053e414`, tree
`6ce50d4565983543d89ae613ea9e09d3934fa305`, adds browser-safe catalog/version
selectors and actual application retained-review injection. Catalogs use existing
read-only Telos storage, origin pagination and exact visible references without
hydrating BLOBs. Missing storage is explicitly unavailable. Private full metadata
witnesses renew privacy/association after all callbacks; the late-title mutation
fixture proves final refusal. Repository intent comes only from the actual claimed
read-only ledger and conveys a repository name for fresh target authorization.
App-owned leases close in `finally`.

Actual ApplicationReview now returns exact kind-aware original labels and renews
current retained metadata/privacy/association during recovery. It verifies frozen
snapshot body size/SHA, without claiming a fresh live-BLOB read on recovery; fresh
compile/save retains the existing actual byte fence. C verified all645source pins,
protected refs and six unchanged compiler/parser/byte-owner dependencies.
[Catalog/application inspection](symposium-acceptance/catalog-269f-inspection/inspection.json)
found no additional concrete bounded blocker. Producer125passes/9files precede the
last frozen-body check; final affected30passes/2files overlap that campaign. Neither
is a C full-app/browser campaign. Capacity remains unverified and native joining,
delivery, replies and mounted combined UX remain open. Root separately reports an
actual Telos source-origin Added-date reset after file replacement, assigned to B;
this catalog review does not qualify or close that coexistence correction.

### Terminal preview correlation and subsequent publication preservation

Existing trusted review `CEN-D37507564B60` found that ordinary terminal preparations
still tried to lstat a source legitimately deleted on failure/discard. The
[original finding](symposium-acceptance/preview-terminal-CEN-D37507564B60/finding.json)
is preserved. Core `f479612ce7b77cc86f435be6f922e2a79add13f6`, tree
`27d0ee589c85ef7cf78776349fc7f63bb627bbc7`, exempts only durable failed/discarded
records from that physical check, preserving runtime/account/correlation authority
and ready missing/replaced-source refusal. Original real-owner REDs precede the
correction. [Bounded source/assertion closure](symposium-acceptance/preview-terminal-f479-correction/inspection.json)
is separate from final exact-head trusted review and CI.

C verified publication preservation at [77a9185c](symposium-acceptance/source-api-1064-base-77a9/verification.json),
[58e5cf46](symposium-acceptance/source-api-1064-base-58e5/verification.json) and finally
[#1064 head9478982c](symposium-acceptance/source-api-1064-base-9478/verification.json),
tree `c1ad64f23ef01bf3202ea86366917f52c4e7707a`, parents58e5/a1c792f.
All645actual pins match the parent key union; incoming19nonshared and original14
nonshared paths remain exact. Whole RepositoryWorkspaces and EventStore preserve
the reviewed terminal fix. The original incoming campaign records60passes and one
subprocess setup failure; an unchanged child-body rerun with explicit current-source
TSX mapping passes. This is not an all-green claim for the original campaign.
Later accepted main402dadf4 is accounting only; it does not relabel947's source,
base or CI. Final strict-base, CI and trusted-followup gates remain core-owned.

### Existing native campaigns and the new79source

[#1058 exact63f5 CI39351657252](https://github.com/dimakis/mitzo/actions/runs/39351657252)
is independently qualified on both OS at actual checkout0007d26a, tree91f66c42:
Linux5839passes/11skips/2298.169seconds; macOS5618passes/27skips/1808.303seconds.
The four named extension-inventory fixtures, reconstruction and formatting pass.
[Exact-head qualification](symposium-acceptance/native54-final-63f5-ci/qualification.json)
is distinct from the earlier0fd campaign, despite identical native54proof.

[#1060 corrected isolation CI39358899994](https://github.com/dimakis/mitzo/actions/runs/39358899994)
is independently qualified at811f058b/treeeb65d369 and actual checkout5c7c6990.
Linux6144passes/11skips/2596.896seconds; macOS5923passes/27skips/2009.484seconds.
Both new isolation fixtures and the original12named cases pass on both platforms,
with exact artifact/source proof, reconstruction and formatting. This qualifies
corrected native60+61lineage `ea641633`, not a historical ordinal61 or later79tree.
[Publication preservation](symposium-acceptance/native60-registry-dependency-811f/verification.json)
and [both-OS result](symposium-acceptance/native60-registry-dependency-811f/qualification.json)
close the source-specific execution gap for the trusted isolation correction;
complete native preparation/account/request/count/consume/release remains open.

Original [native77 CI39357179342](https://github.com/dimakis/mitzo/actions/runs/39357179342)
executed and **failed on both platforms**. Linux6204passes/1failure/11skips from6205
executed,2608.968seconds; macOS5983passes/1failure/27skips from5984executed,
2288.914seconds. Both hit SQLite2067 at effects fixture375 in
`pending_custody_is_pool_local_and_ordinary_attempts_remain_uncertain`.
The other11of12new cases, including all five guarded-claim/credential bridge cases,
pass on each platform; formatting is skipped. This is not the earlier73/76macro
compilation failure and does not qualify77overall.
[Both-platform terminal failure](symposium-acceptance/native77-published-ci/both-platform-terminal-failure.json)
retains separate platform receipts and original diagnostic bytes.

Immutable fixture/SQL inspection identifies one command ID reused for two consumed
root requests; the actual unique command-root index must remain. Native correction
`46df3041feb4fbf9bf6f47d41452abe341de61e9`, tree
`900c92af991875072ff94fe76c1df8fa76ca684d`, creates a request inside each loop arm
with distinct pending/ordinary command IDs. All other case assertions and actual
index bytes remain exact. [Source/assertion closure](symposium-acceptance/native-pending-command-46df-correction/inspection.json)
does not turn the original failure into a pass.

New [#1063 head8b42fb9d](symposium-acceptance/native79-published-ci/verification.json),
tree `3b7ec203aa8508f16d727ec5e4b0154705646e35`, publishes79ordered patches with
all prior77bytes/order unchanged, reviewed isolation patch78and fixture patch79.
C verified all659actual pins, unchanged workflow and exact15-path14ace evidence
adoption. Existing normal CI39366560285 is building; its execution needs its own
qualification. No source inspection or older green transfers to this new tree.

The separate [unwired provider descriptor](symposium-acceptance/provider-spec-limits-staged-inspection/inspection.json)
is staged at proposed tree1797b1ef with exactly one new file. Independent canonical
JSON/SHA verification reproduces285bytes and digest89ceab0f. The exact public
[gpt-6-luna specification](https://developers.openai.com/api/docs/models/gpt-6-luna)
was independently searched/fetched and confirms1050000context and128000maximum
output tokens. Three authored Rust fixtures are unexecuted; dependencies already
exist. The normal signing-key lock remains intact. This record provides no account,
route, current catalog epoch, exact input count, ready capacity or dispatch grant.
Platform/source counts throughout overlap and are never added together.

## Requirement-to-evidence map

Numbers match the exact [canonical16criteria](symposium-acceptance/current-app-dcbad-baseline/criteria.json); the canonical text/hash is retained unchanged. Partial evidence never completes an entire criterion.

| Criterion                                                                                        | Contract owner               | Exact evidence                                                                            | Current state and open gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Visual evidence                                                                                             |
| ------------------------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1. Ordinary chat → Add agent → edit/refreeze → silent join → explicit prompt → attributed answer | Core + A + C                 | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | OPEN. Current actual auth/begin/workspace/observational review passes, but capacity is unverified and production joining is absent. No positive complete journey has run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | No current full-app UI comparison; fixture evidence is separate.                                            |
| 2. Membership re-review retains the same allocation                                              | Core                         | [historical owner envelope](symposium-acceptance/420d-current-owner-envelope/result.json) | PARTIAL owner/client evidence only. Production joining/reconciliation is unmounted, so mounted same-allocation recovery remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Explicit re-review/reconciliation UX still requires actual joining.                                         |
| 3. Lost responses and close/remount/reload/restart preserve identities                           | Core + C                     | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | PARTIAL CURRENT GREEN for committed begin response loss, concurrent exact retry, same cookie/root restart, exact review/settings/brief/workspace recovery. Allocated-agent confirmation, routed remount and different-login lifecycle remain open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Intercepted UI reload receipts do not prove allocated-agent recovery.                                       |
| 4. Approved Add agent and Before joining copy/order/drafts                                       | Core + A + C                 | [approved mirror](../design/approved/symposium/VALIDATION.md)                             | Approved HTML/PNG and protected setup/browser test hashes verified unchanged. Accepted UI source/fixture conformance is historical source-specific evidence; actual successful review/refreeze/join flow remains open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Compare final mounted source against the pinned reference when runnable; no new approval.                   |
| 5. Approved ledger and combined theme/layout/focus/refusal checks                                | A + feature owner + C        | [historical C render](symposium-acceptance/c534-browser-independent/result.json)          | PARTIAL. Existing approved ledger is pinned at fresh-agent-review-2026-10-18-test-syntax; no reference rewrite. No new browser campaign in this baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Prior C and A fixture renders retain their exact sources; mounted combined UX and physical iOS remain open. |
| 6. Authorized prompt AND reply readers before next explicit turn                                 | Core + C                     | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | CURRENT GREEN for exact durable source bytes/digests, private-history exclusion, typed actual HTTP read, restart and hidden-source refusal. This is source retrieval, not production reader delivery: ordinaryCollaborationDelivery has no production assignment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No UI-to-native reader delivery claim.                                                                      |
| 7. Defaults/@, same-account isolation, partial failures and ordinary Stop                        | Core + S6 + A + C            | [historical owner envelope](symposium-acceptance/420d-current-owner-envelope/result.json) | PARTIAL owner/component evidence. Current public messages POST is503; native Defaults/@ fanout, ordinary queue/Stop and uncertain replay must be exercised through actual composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Existing shared conversation fixture outcomes are not backend recipient execution.                          |
| 8. Exact native request/count/consume, per-sampling permits and uncertainty                      | Core native                  | [native contract](../features/symposium-native-request-contract.md)                       | OPEN. Native54 extension-inventory fixtures/formatting pass on both OS with explicit exclusions. Complete Core/MCP/production inventory and late HTTP/account authority remain open. Native60 input/config/factory fixtures also pass on both OS with exclusions. Native70 body/auth fixtures also pass on both OS; these greens do not resolve the native60 trusted registry finding. Native73 failed both-OS compilation;76 Linux failed compilation/Mac cancelled;77 executed the same command-root fixture failure on both OS. Isolation correction ea641 now passes its own both-OS811f campaign; separate79publication carries isolation and distinct-command corrections with fresh execution pending. Public Luna limits are a source/hash-reviewed unwired descriptor only. Host revision proof, authoritative limits and production release remain open; no ready capacity or full application qualification. | No C native build, installed-runtime test or visual claim.                                                  |
| 9. Canonical checkpoint and normal CI/review gates                                               | Core + feature owner + C     | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | Parent and milestone are ACTIVE; exact16criteria preserved. Prior five source PRs are merged. This scoped map/evidence commit is for the next coherent delivery; local baseline success does not complete the milestone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Actual approved full-app comparison still required.                                                         |
| 10. Shared client/server identities, errors and native invalidation                              | Core protocol/native + C     | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | PARTIAL CURRENT GREEN for typed begin/list/view/review and actual auth/restart, plus durable source typed client. Native same-request count/dispatch, one-use sampling and invalidation/refreeze remain open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Client error fixtures alone cannot close native/application integration.                                    |
| 11. Real schema/migration/rollback/concurrency/crash recovery                                    | Core stores + C + B          | [historical owner envelope](symposium-acceptance/420d-current-owner-envelope/result.json) | Current actual app freshly initializes and restarts real stores; historical migration/rollback and save-fence receipts remain source-specific. Full confirmation/concurrent allocation/crash-before-recording matrix requires real joining.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Browser reload is not database crash/allocation proof.                                                      |
| 12. Actual production auth/router/preparation/dispatch/reply composition                         | Core + C                     | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | CURRENT PARTIAL GREEN: original actual-app observational and durable-read cases pass. Omitting real review injection causes503; omitting durable injection causes500 and fails the unchanged positive assertion. Both restore exact source. Joining/dispatch/reply remain absent; no hand-wired success owner used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | No complete mounted UI → native flow claim.                                                                 |
| 13. Multi-agent readers/defaults/attribution/failure/Stop without replay                         | Core + S6 + C                | [historical owner envelope](symposium-acceptance/420d-current-owner-envelope/result.json) | OPEN at actual application boundary. OrdinaryCollaborationReplies has no production instantiation; public execution is unavailable. Historical ordinary-owner evidence remains bounded; full independent recipients and reader/reply lifecycle still required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fixture reply/uncertain/pending outcomes are presentation evidence only.                                    |
| 14. Exact approved Add agent/Before joining and recovery UX                                      | A + core + feature owner + C | [historical C render](symposium-acceptance/c534-browser-independent/result.json)          | PARTIAL fixture/reference evidence only. Actual editable/refrozen review, real fresh join, retained intent, focus/refusal/stale/uncertain flows must be compared on the runnable combined application.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No new render/reference/tolerance/approval or physical iOS acceptance.                                      |
| 15. Bounded Telos/Symposium coexistence through shared ordinary owners                           | Core + S6 + C                | [historical owner envelope](symposium-acceptance/420d-current-owner-envelope/result.json) | Historical role/context/tool/command isolation retained. Requalify the bounded actual ordinary composition after native/application authority is installed; preserve Telos role control and Symposium participation separately.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No new combined orchestration feature or Telos UX claim.                                                    |
| 16. One living map and separate source/behavior/UX/live evidence                                 | C + core checkpoint          | [current baseline](symposium-acceptance/current-app-dcbad-baseline/verification.json)     | ONE MAP REBASELINED to accepted dcbad645/tree79964ceb. Two current selected positives and two expected owner-omission failures are retained; the known-unavailable join was deliberately not selected. All16criteria and prior248Cpaths preserved before this map update.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Live account/runtime/physical-device matrix remains separately authorized and unqualified.                  |

## Next complete application checkpoint

Current production wiring is deliberately incomplete: `app.ts` installs only the
store and observational review; native capacity and the joining port are absent.
The public messages/snapshots writes return503. `ordinaryCollaborationContextHooks`
accepts an optional delivery owner but production callers do not supply it;
`OrdinaryCollaborationReplies` has no production instantiation. Forwarded content
is explicitly refused before ordinary staging. These are implementation gaps,
not invitations to substitute a fake approval, membership, router or cached Session.

Core's unaccepted#1058 checkpoint introduces registration-owned extension inventory
capture/renewal only. Its producer record is explicitly not a complete request,
capacity, dispatch or runnable application seam. Core/MCP/production extension
selection and late HTTP/account authority still have to be resolved. C does not
rebuild native source or infer readiness from this checkpoint.

Once core supplies genuine native inventory/request/count/consume authority and
actual app preparation/join/delivery/reply composition, C will exercise ordinary
chat → Add agent → inspect/edit/refreeze exact context/brief/capacity → fresh join
with zero inference → explicit reviewer prompt → attributed answer, then recovery
and reader follow-up. Required-owner omissions must fail. A combined candidate
will be labelled; accepted main will be requalified after landing. Approved UI
comparison follows the actual runnable source; physical iOS/live runtime remain
separate. Known-blocked full journeys are not repeatedly rerun while these owners
are absent.

## Historical checkpoints and supporting evidence

The following recorded sources/results remain historical. Their original “current”
or “latest” wording refers to the source named in that checkpoint, not this baseline.

Historical accepted-artifact checkpoint combines C `d1166ff0e903caddeb48c8174b41b3efcd2e2eb0` with
accepted main `a7cef26f4de2050412e978e7c311107d5505ed5e` (#1020). Signed source merge
`31e10441a50b5c1ae399d903aea9377439e68099` has tree
`6ab84b44602054aadad9304e672c8aa28209a5c5`. The clean merge preserves all242 prior C
paths and all158 accepted incoming paths exactly; all592 fingerprints match
`v1.0.321-telos-reviewed-presentation-symposium-forwarding.1`. Approved references and the protected Library
assertions/timeouts remain unchanged. B's privacy/currentness and exact saved-version
owners are consumed directly from accepted main, without replaying a candidate patch.

C's independent `--artifacts` harness passes **75tests/7files, zero failures/skips**,
4.07seconds, one worker/1024MiB, on the clean source tree identical to that signed
merge. Actual stores and ordinary serialization carry the exact saved v1 bytes and
provenance after later edits; access and original-source privacy changes refuse
before recorded dispatch. External account/native boundaries are recording fakes.
No required app repro, browser, live model or provider/runtime qualification ran.
[Source and focused actual-owner evidence](symposium-acceptance/accepted-artifact-a7/verification.json).

Predecessor d116 [CI39144116165](https://github.com/dimakis/mitzo/actions/runs/39144116165)
passes all eight jobs on checkout91ee017e/tree6dcb8e63, identical to that head.
Core17908passes/31skips,1307files passed/9skipped,770.11seconds; WebKit259passes/
12skips and all four original60s Library journeys pass. Counts overlap and are not
summed. B landed during that run; C retained its complete source-bound CI packet
and did not request an obsolete d116 manual final review or read its credential.
Fresh final-head CI/whole-PR final/App gates and a coordinated actual merge slot
remain required for this new candidate. Core's durable forward prepare/confirm/read
receipts remain pending. Actual app/durable-positive+omission/join/native/runtime/
fullUX/physical-iOS gaps remain OPEN; the canonical milestone remains active.

Previous final-integration candidate combines prior C
`7837ba55139da9462452c88cb65a1856375a2f6f` with accepted main
`634048b1c7309a411dcfbf39dd2ae4e0308bdcfb` (#1030). Signed source merge
`6f2f7e405cf0b32f1f37ba05adfdb25c6e440de0` has tree
`f89fdcca485a508998456f6eee272bbbbad65b6f`. The clean merge preserves all241 prior C
delta paths and all40 incoming accepted paths byte-for-byte, including both
conditional welcome mounts, ordinary reviewed-context labels and existing CI
metadata-resume coverage. All584 fingerprints match `v1.0.321-telos-reviewed-presentation.1`;
protected Library assertions, timeouts and approved references are unchanged.
[Source preservation proof](symposium-acceptance/accepted-634-final-integration/source-integration.json).

Prior7837 is qualified by [CI39140231193](https://github.com/dimakis/mitzo/actions/runs/39140231193)
(all eight jobs pass), explicit whole-PR final job4997/r1 and
[clean report5563740917](https://github.com/dimakis/mitzo/pull/1022#pullrequestreview-5563740917),
plus dedicated-App success56635609051. These remain source-bound history. Fresh
CI, exact-head whole-PR final review and App approval are required for the new
published head. The coordinator authorized this necessary strict/base integration;
no actual merge slot is reserved during preparation. No broad local suite,
browser launch, provider test, staging operation or production activation ran.
Actual app/durable positive and omission/join/native/runtime/UX/iOS acceptance
remain OPEN; accepted context metadata does not qualify those Symposium journeys.
The canonical milestone remains active.

Previous resumed candidate aligns accepted main
`f39cbfdfa31f5e4c0d3413737827de2c8640d34e` (#1028) with prior C
`c4068c06d583989728dacce95bd289f2d0cef241`. The clean signed source merge
`541fc21d1ad6bbd8642e431e6c1ddd140e8bb370` has tree
`4daaa77aca565a7590ea4bc9654f9dbdff1c4911`, exactly the composed source
used by earlier CI checkout `881302875005926adb884bc3acc777b056802339`.
All235 prior C delta paths survive unchanged at the source merge; all15 incoming
accepted paths are byte-identical. All581 fingerprints match
`v1.0.320-codex-resume`, with zero mismatches.
[Reconciliation and format-failure proof](symposium-acceptance/f39-format-reconciliation/verification.json).

CI39135943443 failed only its evidence-map Prettier check and downstream summary.
The bare C head was tree9e083446; actual composed CI was tree4daaa77a. That
source distinction is retained. The targeted map formatting correction preserves
all non-whitespace content before this new checkpoint note; no assertion, timeout,
reference or native test was changed. This is a formatting repair, not an assertion
or native failure waiver. No broad local suite, typecheck or browser launch ran.

The final published head/tree, current CI, qualifying review rounds, actual
whole-PR final admission/result and dedicated-App status are retained separately
in task-root `implementation-evidence/resume-format-reconciliation/` and the
active milestone note. Fresh gates are required for this advanced head; old ad74
full review and App success remain source-specific history. Strict/base readiness
and the coordinated landing slot remain separate. Full-feature acceptance stays
open, including actual app/durable/join/native/UX/iOS gaps.

Previous accepted-recovery source checkpoint integrates actual accepted recovery main
`2b22bade2b1e612cc564661bf1e69b45a317e5eb` (#1029, including #1027) into prior C
`ad74f30c32621f6d31c679c5220ed7bd2d1dd91a`. The clean signed source merge is
`90a820dede75623e6690f2977eb8582d74827cdf`, tree
`3c930e7defb93c7321771fd58762763ba4e354b9`. All231 prior C delta paths remain
byte-identical at the merge; all27 incoming accepted paths match accepted main.
All580 fingerprints match runtime source `v1.0.319-telos-role-recovery.1`, with zero
mismatches. Approved references and the protected Library test remain unchanged.
[Source integration proof](symposium-acceptance/accepted-recovery-2b22/source-integration.json).

The published candidate adds this map/receipt update only. Its exact head/tree,
normal CI, explicit whole-PR final admission/result and dedicated-App gate are
recorded separately in task-root `implementation-evidence/accepted-recovery-integration/`
and the guarded active milestone note. At this source-preparation checkpoint those
new-head gates are pending; prior passes do not qualify an advanced head. No broad
local suite, typecheck, browser launch or new application acceptance was attempted.

Predecessor `ad74f30c` retains independently verified [CI39122888448](https://github.com/dimakis/mitzo/actions/runs/39122888448)
(all eight jobs pass), explicit full-final job4956/r1 and [clean report5562875515](https://github.com/dimakis/mitzo/pull/1022#pullrequestreview-5562875515),
plus dedicated-App success56631400738. These remain exact-source history. Original
failed application/required joining checks, guarded omission limits and old render
boundaries remain unchanged. Full-feature acceptance stays open.

Historical draft-PR browser-gate repair: C48e4 CI39101438934 failed only WebKit's
original unsplit Agent Library journey at its overall60s deadline. The Connections
failure is an aggregate of that offline result; browser-interaction itself passed.
C verified actual composed checkout52fec5e/tree17342c3c, trace source and final
successful attribute read after all four appearance capture sets. Accepted main
d5d3 is now normally integrated with the exact existing owner3440 one-file fix;
all117 assertions/12 screenshot calls/78 navigation calls and60000ms remain.
Local WebKit startup failed before the four cases ran, so it remains unqualified;
combined CI39104956665 on signed53a60578 is **PASS**, all eight jobs green.
WebKit records251passes/12skips and all four original60s journeys pass.
[Completed combined CI proof](symposium-acceptance/53a60578-combined-ci/verification.json).
[Failure, source and adoption diagnosis](symposium-acceptance/48e4-library-gate/diagnosis.json).

Milestone `358d56cb7e4352ff`, parent `c0851ba23fcc5d04`; both remain active.
This map succeeds core's frozen `requirements-and-reassessment.json` seed. Core
owns the shared implementation plan/checkpoint; this is scoped acceptance evidence.

Latest independently attempted Symposium production-app source is core `6ddc2607e36d4d4a90f06f173bb840678d5c8b4c`,
product tree `d4fa91befaeed24934acf3766498f72e9daa9fa7`, plus C overlay
`365eb55b7ce4c0948018803bb322539259111e77`, tree
`2a42999f92d791cf897f09e0874e50a60192ff50`. It is **UNQUALIFIED** for actual app
and durable source acceptance: the original application journey times out at20seconds,
and the new separate durable-reader case cannot execute. Initial broad envelope:
**438 passed / 4 failed / zero skips**,442cases28files,124.20seconds. A smaller
unchanged retry also times out. Observer-only timing locates the pending first
`app.js` import after target configuration at5694ms; cause remains unproved.
The historical420d comparator also times out now. No timeout, original assertion,
production contract or SDK fallback was changed. All584 source pins match, which
establishes source identity rather than app success.
[Current attempt and composition](symposium-acceptance/6ddc-current-owner-initial/composition.json),
[phase diagnostics](symposium-acceptance/6ddc-app-phase-diagnostic/restoration.json),
[historical comparator](symposium-acceptance/6ddc-comparator-420d-required/result.json).
The guarded missing-injection control is implemented but **NOT RUN**: without a
positive actual-app baseline it refuses before mutation or execution.

Separately, C independently checked completed core CI job117592903558 at PR head
`39a308cf5cd4673a90e9058600394fae51c66de6`: **3 service/API/hook recovery cases pass**
and the original29 service cases pass. Actual CI merge checkout `4a233b92` has the
same tree `11080db4` as39a, verified through GitHub's commit API. This qualifies that
fixture composition only. It does not replace the current C app timeout/omission
block or establish a mounted production capture/preparation/page owner.
[Read-only CI/source verification](symposium-acceptance/39a-core-ci-verification/verification.json).

Last independently verified bounded backend checkpoint (18 October local time): exact core
`420d2570a759859699809e036f551b1cb496efb6`, product tree
`e5c3e74a52def5f5266e549713262c3233b7f4f4`, plus C overlay
`0c9a4704cbe2b4aa74c6cc3ac98b6788f6b6f64f`, tree
`f2e6f146a834179950fee6b67d173c86264d21d9`: **296 passed / 1 required failure /
zero skips**,297cases23files,26.34seconds. This envelope selects required journeys,
artifact contracts and nine existing owner/client/protocol suites. Joining still
returns503; success assertions remain unchanged. New typed existing-association
reads pass through actual application auth/GET routing and restart. Omitting that
GET mount makes the new check fail; exact source was restored. All573 source
fingerprints match with zero C product changes.
[Actual-owner result](symposium-acceptance/420d-current-owner-envelope/result.json),
[composition proof](symposium-acceptance/420d-current-owner-envelope/composition.json),
[omission control](symposium-acceptance/420d-association-route-omission/control.json)
and [source proof](symposium-acceptance/420d-source-pins/result.json).

The separate C c534 browser execution remains **12 UI scenarios plus 2 startup checks
passed**, zero failures/skips/retries,37.18seconds. Selected browser source bytes
are unchanged at420d; original execution/capture source bounds are retained.
[Browser result](symposium-acceptance/c534-browser-independent/result.json).
Backend and browser envelopes overlap and are not summed. Native/runtime and physical
iOS remain separate gates. Earlier source-specific results and negative controls
are preserved.

## Source and authority

Accepted remote main was freshly fetched on 17 October 2026:
`189289da78d971497deaa9cc4ca29365ba9c6e56`. This happened to equal the historical
review snapshot; it was selected from remote main, not assumed from the handover.
Accepted main then advanced to `fea33e215b0d1bcf29604aa13e793329588a2980`
(PR #1006); it was fetched and combined without replacing earlier evidence.
[Refreshed owner result](symposium-acceptance/accepted-fea33e21/result.json) and
[output](symposium-acceptance/accepted-fea33e21/output.log) record **106 passing
checks across 12 files**, 15.84 seconds, against local combined source
`0a6155a66e4d5fe83d2f8c813db9378d0541ea8a`. This includes the new migration and
no-listener transport checks.

C branch: `test/symposium-integration-acceptance`. No production files or shared
CI configuration are owned or edited here. New harness source is not merged.

Canonical records were independently inspected using SQLite `mode=ro`, without
constructing the write-capable artifact owner. The milestone has 16 criteria.
Latest artifact bytes, stored size and SHA-256 agree with core's exports:

| Record                                           | Revision | SHA-256                                                            |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| Plan `dad6534e91551b3e375a57307df729a1`          | 12       | `8f3a3411aa93816ffb54f3545595e64e2ede7a7bb9222bc6f5bc312e556e6b67` |
| Acceptance `4c8cef1b18a2e14db03b301fdef01c4c`    | 2        | `459c32e9c2ad66fd33c71706c0816da66c90467041ff787b75637236657a217c` |
| Mock approval `d2b5bce4090c39a595457335763271b5` | 1        | `cf87dbd06bff52b788cbb2dbfff13ad15e889a36d89e7958568764781e31c1ea` |

The approval retains fresh agents and reviewed full/selected context. Existing-chat
import is deferred; fork is separate. No new plan or milestone tree was created.

## Ownership and exact candidate boundaries

| Owner                                   | Agreed files/contracts                                                                                                                        | Current source and evidence classification                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core — Continue Symposium after #1000   | Native capture/count/consume; application construction/auth/join/recovery/delivery/reply wiring; ledger/call sites; canonical plan/checkpoint | C independently attempted core PR1023 source6ddc2607 with accepted6de/nativef8/durable source;584 pins match. Current app attempt unqualified; last bounded app checkpoint420d. native distribution/account qualification remains separate.                               |
| A — Implement Symposium UI Workstream   | Shared transcript adapter, stable recipient controls, focused UI behavior/captures                                                            | A serif fixfe4f811b retained in420d; private/projection/header/recovery fixtures independently rerun as bounded protected/shared browser cases. No full backend app/native iOS claim.                                                                                     |
| B — Implement Symposium Workstream      | Exact forwarding selection, retained-version adapter and artifact fixture                                                                     | Exact saved-version/custody producer and private selector/storage/refusal owners on420d reused, including original15 source save-fence cases; browser-safe extraction79e467da preserves Node custody in its explicit private entry. Public durable delivery remains open. |
| C — Build Symposium Integration Harness | New scoped fixtures/tests, runner, this single map and independent defect reports                                                             | This branch; actual owners, new durable app case and guarded omission runner. Current startup evidence remains unqualified. No second dispatcher, native algorithm, scheduler, account catalog or artifact engine.                                                        |

Core accepted the two concrete defects/dependencies reported by C: missing reply
reader deliveries, and unsafe application import/teardown. Core is implementing the
production fixes. Its teardown audit also found terminal maintenance on import and
notification flush/badge work that must settle before closing SQLite. C must verify their exact combined revision before updating status.

## Commands and retained results

Run from the repository root after installing lockfile dependencies. The scoped
runner always selects one worker, disables file parallelism and sets a 1 GiB Node
heap. It records HEAD/tree, tracked-diff hash, untracked source hashes, versions,
command, output hash and exit status. A failing required run returns nonzero.

```sh
node scripts/run-symposium-acceptance.mjs --evidence-dir /tmp/symposium-scoped
node scripts/run-symposium-acceptance.mjs --owners --evidence-dir /tmp/symposium-owners
node scripts/run-symposium-acceptance.mjs --required --evidence-dir /tmp/symposium-required
```

`--owners` now reuses fourteen named existing owner/client/protocol suites in
`vitest.symposium-acceptance.config.ts`. On this Mac their supertest listeners need
approved outside-sandbox execution. They create disposable in-process HTTP sockets,
not a normal server or deployed stack. New `requestApplication` dispatch needs no
listener. The normal repository suite discovers the new `.test.ts` checks. Required
`.repro.ts` cases are an explicit working-branch gate and stay red until dependencies
land. Excluding them from a scoped green run is not milestone acceptance; do not
merge a permanently failing required suite or mark a skipped/blocked case accepted.

| Evidence                                                                                                                                                             | Observed result                                         | Meaning and limits                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Baseline owner result](symposium-acceptance/baseline-owners-outside-sandbox/result.json), [output](symposium-acceptance/baseline-owners-outside-sandbox/output.log) | 104 passed / 10 files, exit 0, 19.79 s                  | Includes 5 new checks and 99 reused checks. Actual store/workspace/restart/client/owner behavior; not complete app composition.                       |
| [Sandbox attempt](symposium-acceptance/baseline-owners/result.json), [output](symposium-acceptance/baseline-owners/output.log)                                       | 92 passed, 7 failed, 7 unhandled errors                 | Loopback `listen EPERM`; environment failure, not an accepted router result or a product defect. Preserved rather than erased.                        |
| [Required baseline](symposium-acceptance/baseline-required-no-skips/result.json), [output](symposium-acceptance/baseline-required-no-skips/output.log)               | Required regressions fail; exact counts in receipt      | Reader reply has no authorized readers. Actual-app prerequisite blocks before import while safe seam is absent. No required case is counted accepted. |
| Source-alias TypeScript and focused ESLint                                                                                                                           | Passed on initial new fixture/policy/coexistence source | Final changed-file validation is recorded with the final run below. Broad application builds remain CI work.                                          |

Local dependencies are borrowed through task-local symlinks; observed Node
`v24.10.0` and Vitest `4.1.11` are in receipts. CI must install the repository lockfile;
local results do not claim lockfile-install CI. Counts overlap and must not be added.
The initial fixture red phase failed on its missing helper module; implementing the
actual-owner fixture made the scoped checks green. The no-listener transport also
started with a missing-helper red and now exercises real Express JSON/cookie handling.

Artifact journey (additional handover requirement): B's exact retained versions and
C's75-test accepted artifact/ordinary-serialization proof remain bounded evidence.
Current `OrdinaryCollaborationDelivery` explicitly refuses every `message.forward`
before staging. Host helper serialization, transcript references and native export
do not establish actual forwarded-content delivery or a note-only ACK. Core/S6 own
the ordinary input/delivery seam; real selected-version delivery remains open.

## Actual-app construction prerequisites

The app is a module singleton, despite historical CLAUDE factory wording. Direct
import currently loads a host internal token and merges global MCP configurations.
The fixture must not import it with production credentials/configuration. Core agreed
to an absolute `MITZO_INTERNAL_TOKEN_PATH` selected before module import and an
application-owned resource teardown. C supplies synthetic REPO_PATH, private paths,
empty account inventory, explicit offline environment, synchronous task log and an
empty external MCP catalog; HOME/CODEX_HOME are not changed. Actual interactive
login, cookies, internal token implementation, app/chat/EventStore/router stay real.

Requested teardown includes registry disposal, notification callbacks/store, tasks,
agent library and app-owned profile/context/access/proposal/grant/review SQLite
handles. Core owns this production seam. Guard failure is BLOCKED, not a successful
application test. Once available, actual source review/join/send mounts must execute
with recording external account/count/RPC ports; absent wiring fails the required run.
No normal server, configured runtime or provider is started by this work.

## Future qualification matrix — prepared only

Generate rows from the actual selected account inventory at the time of separately
authorized qualification. Do not infer accounts from fixtures, UI labels or one
representative provider. Do not read production credentials to populate this plan.

| Dimension            | Required rows / retained evidence                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account              | Every configured account ID and immutable profile revision, inventory timestamp/hash; billing account explicitly identified before calls.                                                                                                                 |
| Runtime              | Mac host and OpenShell for each account. Unsupported tuples stay open.                                                                                                                                                                                    |
| Client/device        | Desktop browser, mobile browser and physical iPhone/Capacitor over each runtime; record OS/build/viewport. Browser WebKit simulation does not qualify physical iOS. Watch remains separate.                                                               |
| Model                | Explicit supported Luna ID for target account; never inherit session model. If unavailable, no call until explicit alternate-model approval.                                                                                                              |
| Target/authorization | One feasible separately authorized target, sequential cells; target identity/config/runtime revision and permission record. No per-feature stacks.                                                                                                        |
| Journeys             | Ordinary start, fresh full/selected/brief-only join, repeated Default/@ prompts, same-account independent agents, exact artifacts, queued settings, readers before next command, partial failures, Stop/uncertainty/no replay, reconnect and attribution. |
| Receipt              | Source commit/tree, binary/runtime, request/ACK/final-reply/artifact pins, observed result, visual/device evidence, blocked/unsupported reason; no secrets.                                                                                               |

All future cells are NOT RUN. Offline fixtures qualify no live account/runtime/device.
Canonical staging/pipeline remain stood down. No model calls, deployment, activation,
staging operation or recurring automation is authorized or performed here.

## Older accepted-schema fixture

The 11 KiB compressed SQLite backup was generated by the actual EventStore at
accepted `09f1090fd5be8b1167188a178dca2186eb445795` (tree
`54df91831b2f23a236c343e72549d34dbb693bae`), extracted from local Git history.
The portable generator instantiates that owner with one synthetic session/group
and an unverified review, closes it, then compresses its actual database bytes.
No CREATE/ALTER SQL or invented columns are supplied by the fixture. Manifest
`server/__tests__/fixtures/symposium-event-store-09f1090f.json` pins owner source,
compressed/raw hashes, size, group and immutable snapshot identity. The current
owner migrates it and preserves its review/hash, refuses an invalid membership
mutation without partial effects, and reopens it without gaining native authority.
One focused migration test passed after the expected missing-fixture red. Regenerating
this synthetic fixture is maintenance, not a normal test step or reference-image update.

## Independent visual inspection of A's bounded captures

C directly inspected all four images from capture source
`62c89aff166c6133ccc01aa95c8ff7aaa589241d` (A evidence commit `bed075d4`),
and read the original approved HTML at its retained hash `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
A reports 6 browser cases plus 2 startup dependencies passing, one worker, no
retries. C inspected pixels and test source; C did not independently rerun that
browser job. The scenarios use schema-derived intercepted responses and show no
actual application backend or native device.

| Capture under A's `docs/design/assets/`       | SHA-256                                                            | C observation                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `symposium-shared-desktop-chromium-dark.png`  | `c9ae37c97057880e48e79d3f3fe03b735e0cf7bdeaa10d7f189e402260280b6f` | Retained Architect answer, explicit Reviewer uncertainty/no-resend, Reader pending and composer draft are visible. |
| `symposium-shared-desktop-chromium-light.png` | `5ffec9bf2b9be984e521a8392217f1b7adf29f3381dbe0977404de17e92f3026` | Light/Georgia appearance remains readable with visible controls and no apparent horizontal clipping.               |
| `symposium-shared-mobile-webkit-dark.png`     | `b44064f84ff3925e0f0234d7be931adbbcf14aac6dde3b44508afb8ef9ca33de` | At 320px, header shows two names plus +2 for three participants; approved narrow header rule is violated.          |
| `symposium-shared-mobile-webkit-light.png`    | `31f625399479f9b2b818e2aaac4d4d75083a6205b8249f4b18ef996cfa237804` | Same narrow-header deviation; retained draft and partial-outcome text are readable.                                |

Concrete defect sent to A and core: approved HTML line651 renders two names with
a separate mobile count, while its <=360px rule (lines509–518) hides all names
except the first and hides the separator. The correct 320px result is therefore
**Architect +2**, while current `ConversationAgents.tsx` joins both names into one
span and displays **Architect · Reviewer +2**. Do not change the reference or
simply alter the count without preserving that approved responsive rule. Core
owns the production component; A owns the focused assertion and refreshed captures.

These images omit the ordinary shell, Add agent and Before joining. They do not
close criteria1/4/5/12/14 or establish final combined approved UX. A source refresh
onto #1006 and core recovery/reader work require their own exact combined evidence.

## Combined candidate verification (not accepted main)

Separate branch `test/symposium-acceptance-artifacts-candidate` combines B's
published `313112667ef475a588b112bb179b70dd7a348df5` (PR #1020, based on accepted
`fea33e21`), C harness commits, and core's actual reader fix `eaa68d32` (original
`63ae43cd`) without editing their production files. Combined commit
`4b257990`, tree `2beb2f702c2d94d6676d0af0da2b1b8c60bfceb7`, plus the runner diff
recorded in the receipt: [result](symposium-acceptance/combined-4b257990/result.json),
[output](symposium-acceptance/combined-4b257990/output.log).

The combined required/candidate run has **10 passed, 1 failed, zero skips** across
7 files. The single failure is the guarded missing application import/teardown
prerequisite; the actual app was not imported. This does not qualify combined
application behavior, source closure pins, native capacity or approved UX.

The original reader regression passed unchanged after core's actual store fix:
reply-to-reader delivery is retained; after EventStore restart, the original
prompt, finalized reply and next explicit prompt reach the existing ordinary
context adapter in order, with exactly one recorded `turn/start`. This verifies
the reported repair on this candidate, while accepted main still fails that case.

The two new cross-owner artifact cases pass through B's canonical owner fixture,
exact retained read/forward handoff and C's real ordinary driver/serializer:

- An explicitly selected older saved revision survives later edits, owner restart
  and an absent original session. Recorded native application-context fragments
  reconstruct the handoff byte-for-byte, with old base64 bytes, revision/hash,
  intended recipient and retained provenance unchanged.
- Revoked artifact access is renewed through the ordinary `prepareTurn` callback
  and prevents `turn/start`. This is a bounded internal-owner composition check;
  C's fixture supplies that callback, and production application dispatch does
  not install it yet. It is not proof of an atomic final-send authority fence.

Run the artifact candidate checks explicitly after B's source is composed:

```sh
node scripts/run-symposium-acceptance.mjs --artifacts --evidence-dir /tmp/symposium-artifact-candidate
```

On accepted main without B's modules this command fails for the missing source
dependency; those cases are not silently skipped or counted accepted. The normal
scoped runner continues to run only available accepted-owner checks. The two
artifact tests first went red on missing handoff context/pre-dispatch callback;
adding only the fixture's existing-driver callback/context inputs made them green.

**Open artifact defect:** B subsequently reproduced a late-await privacy gap on
`31311266`: final target/source authorization may change retained-item privacy
after the last material check. B/core own the synchronous retained-material fence
and save/dispatch transaction integration. B's earlier 145 green cases and C's two
bounded green cases do not close that gap. Re-run the owner late-await regression
and these checks against its exact fix before any integrated-material acceptance.
Standalone retention and actual agent-delivery receipt installation remain pending.

A has published [draft PR #1021](https://github.com/dimakis/mitzo/pull/1021) at reported
`6123caaec7b1fa0b24c41c141647dc9c8a06638b`, preserving the independently reported
narrow-header deviation. Its 195 focused checks, 108 design checks with one existing
skip, and six UI/two startup checks are owner evidence; C's independent pixel/source
inspection above remains a bounded finding, not final UX approval.

## Latest artifact repair verification and scoped checkpoint

B published the privacy/custody repair as
`8c12cf9fb820eb5f48d75e175ff839f69432e4d7` (PR #1020, tree
`cc2c849d8f18e3715ade5c1769da39edeb85dc21`). C composed that exact commit without
production edits, yielding candidate `69dbb57c89eea799323b9a5b475bf898bea2e053`,
tree `6b994eb97c7aa757caa345d9b0a7407d55be5861`, plus the recorded runner-only diff.

- [Combined result](symposium-acceptance/combined-artifact-repair/result.json) and
  [output](symposium-acceptance/combined-artifact-repair/output.log): 10 passed,
  1 blocked application prerequisite, zero skips. The original reader case and
  both cross-owner saved-version cases remain green.
- [Actual owner revalidation](symposium-acceptance/combined-artifact-repair/owner-result.json)
  and [output](symposium-acceptance/combined-artifact-repair/owner-output.log):
  **36 passed / 2 files**, 1.71 seconds, including the four late-await
  source/target × privacy/corrupt-custody regressions. C reused B's owner tests.
- Source-focused TypeScript including the artifact candidate test passed on the
  combined candidate. This does not verify mixed-source closure pins or a real
  application final-send transaction fence.

The reported late-await defect is verified repaired within that bounded private
handoff/reader boundary. The new synchronous retained-material assertion is not
an atomic authorization grant; actual application admission/transaction integration,
standalone retention, native capacity and durable delivery remain open.

C's [draft PR #1022](https://github.com/dimakis/mitzo/pull/1022) was published with
GitHub-verified signed commit `1979befa3509ed584b98acfca27c42a24f9acd59`, tree
`72d65c812a35509c2f91cc37278c6d738f3d38e9`, matching the locally inspected tree.
Its normal CI was observed queued; no current-head CI or Centaur approval is claimed.
The local encrypted signing key was not changed. Subsequent evidence commits retain
all earlier receipts and tests; this map is the sole active acceptance map.

The canonical [scoped progress receipt](symposium-acceptance/scoped-progress-receipt.json)
records request `symposium-acceptance-c-1979befa-20261017`, appended through
TelosItemStore with a fresh revision compare-and-swap. The milestone remains active;
summary, all 16 criteria and children were checked unchanged. No shared plan/artifact
revision, parent status or new task hierarchy was written.

A's newer draft head is `d0a8d23b1ae2c60012cd480c57a743f7b4a69eac`; its selected
unavailable-recipient removal regression is owner-reported green. Original four
capture bytes and C's responsive-header finding remain unchanged. Await the core
fix and final combined capture evidence before any UX acceptance.

## Safe actual-application import and real HTTP follow-through

Core supplied exact safe-seam commits `0112ee1453db9361b15383414bd7baa1cfcfeeff`,
`a4bc9d7720e61ef43c11a8616b623a58e3c52887`, and
`9080eff0f8e307d28aa8477d7bc18f70006fb61f` (core tree
`aa9bfe269e2bd8dc06d97709139fd8f59735a6ff`). C composed those immutable owner
commits without production edits onto the prior B/core/C candidate, yielding
`de9974bfa6b4f226847e27afc13832e083354809`, tree
`0af2cdb4cb0bb2c011e9392d573d5fd9e63e3e42`, plus fixture/runner diffs in each receipt.

The harness now uses the exact `closeIdleApplicationResources():Promise<void>`
contract. A failed release or interrupted import retains its root/logs and
synthetic environment/network fences; it does not delete files under possibly
open resources or restore host configuration to unfinished callbacks. Successful
release is followed by an actual503 admission-fence assertion. This is idle
resource release, not a general shutdown or a mechanism to drain active work.

Ordinary driver fixture imports are deferred until the synthetic environment is
installed, including the logger. The memory-only transport has deterministic
loopback peer metadata (its req.ip regression went red then green). For actual
application acceptance, the harness now uses supertest over one disposable
**127.0.0.1** listener with real HTTP response completion, cookie/IP/rate-limit
semantics, bounded request deadlines and listener cleanup. No index.ts, normal
server bootstrap, provider or deployed target is started. Run `--required` outside
Seatbelt on this Mac once that safe source is composed, as for `--owners`.

[Initial semantic-transport run](symposium-acceptance/safe-app-de9974bf/result.json)
and [output](symposium-acceptance/safe-app-de9974bf/output.log) are retained. Its
manual response-finish transport does not qualify socket completion/abort behavior;
the performance middleware reports those synthetic finishes as aborted. The real
HTTP run supersedes that limitation for this bounded request sequence:
[result](symposium-acceptance/real-http-safe-app/result.json),
[output](symposium-acceptance/real-http-safe-app/output.log). Both runs retain the
missing source/review wiring as a failure, not as a passing refusal acceptance.

Observed through the **actual app.ts/chat.ts, real internal-token implementation,
interactive login/cookie/auth middleware, EventStore and typed shared client**:

1. Synthetic operator login returns200 and the real authentication cookie.
2. An unauthenticated conversation read returns401.
3. The authenticated typed client reads the actual existing conversation (200).
4. A valid typed source-review selection reaches the actual app route and returns
   **503 execution_unavailable**, failing the unchanged required expectation200.
5. Idle release completes; later HTTP admission returns503 before closed stores
   can be used. The loopback listener and root are removed only after safe release.

The full combined run remains **10 passed / 1 failed / zero skips**. The failure
has advanced from a pre-import dependency block to the real missing application
source/review owner. It has not turned green. Join, explicit send, finalized
attribution, actual routed reload/restart and full Telos coexistence remain open.
C requested the exact new public review/settings shape and external account/RPC
fixture hooks from core; it will not substitute the independent fixture workspace
for actual application admission or invent an unsupported native capability.

The corrective review at `session-audit/review-2026-10-17.txt` was read in full.
Its distinction between local repaired reader behavior and accepted main is
preserved. Header conformance remains with A/core; corrected breakpoint/column
captures will be independently inspected before updating the UX evidence.

### Same authenticated source/policy restart

The actual-application fixture now closes only idle owners/listener, resets the
module graph, and reopens the **same** synthetic root. It retains the original
cookie and credential file rather than logging in again, writing replacement
accounts or fabricating a session. After real policy mutation through the typed
client, it verifies exact conversation/policy replay, the same authenticated JWT
identity, unchanged internal-token bytes, unchanged ordinary command identity and
unchanged session count across that restart. The restart fixture's missing-helper
red was repaired before rerunning the required journey.

[Restart run](symposium-acceptance/real-http-restart/result.json) and
[output](symposium-acceptance/real-http-restart/output.log) retain **10 passed /
1 failed / zero skips**. All restart assertions and final idle-release/admission
fence pass; the full journey still fails at the actual503 review route. This is
pre-join source/policy restart evidence, not allocation-success/lost-confirmation
recovery or complete joining-to-reply acceptance. Those cases await the core
production review/join/send contracts and actual workspace/account/RPC fixtures.
No production files, approval references or required success assertions were changed.

The [final restart run](symposium-acceptance/real-http-restart-final/result.json)
([output](symposium-acceptance/real-http-restart-final/output.log)) additionally
pins an empty offline model-limit catalog under the synthetic root, so clearing
inherited opt-ins cannot enable catalog network fallback. It again reaches the
real review503 after all auth/policy/restart assertions and safe teardown. Final
source-focused TypeScript and ESLint pass. The scoped accepted-owner subset remains
7 passing cases; it does not include the red full-journey gate.

This is the deliberately unbootstrapped app seam. Production `index.ts` also
installs persistent authentication revocation authority; that bootstrap and logout/
different-login recovery cases are not qualified by this positive same-cookie test.
The test does not replace that owner with a fake or claim complete auth lifecycle.

Review routing remains Symposium core as implementation integration lead and
Review Symposium Telos Design (`01a14bab-6771-79e1-b832-6575ca1d2e6e`) as owning
reviewer. Telos S9 owns Telos-side acceptance/isolation; C's bounded coexistence
checks do not substitute for it. Necessary material event reports follow the
verified human request for sessions to report back; no new merge authority follows.

### Independent corrected UI inspection and current review dependency

C inspected and retained seven unchanged PNGs from A's clean committed source
`d127103bdb9c9de2215d27b643959168b7300813`, tree
`e205b262791b0163b1670baae8a5790380d3f09f`. Each retained image SHA-256 was verified
against that exact Git blob. The [independent receipt](symposium-acceptance/ui-correction-independent/inspection.json)
records image paths/hashes, source status and limitations. The approved HTML hash
remains `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.

The previously reported visible-name/count defect is repaired in these inspected
renders: [320px mobile](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-shared-dark.png)
and [320px desktop conversation container](symposium-acceptance/ui-correction-independent/symposium-corrected-desktop-chromium-header-desktop-column-320-dark.png)
show **Architect +2**; [390px](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-header-390-light.png)
shows **Architect · Reviewer +1**. The retained success remains beside independent
uncertain/pending outcomes. [Pending](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-policy-pending-light.png)
and [refusal/recovery](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-policy-refusal-dark.png)
feedback stays inside Agents with the footer visible. These are static independent
inspections of A's real client/projection/presentation-hook/component fixture with
intercepted synthetic transport. They do not establish full application joining UX,
keyboard behavior, policy request counts, native iOS or approved combined acceptance.
No reference image was regenerated; earlier failed renders remain retained.

Core's committed application branch has advanced through observational review
service `d7d523a8`, typed client `e9919669`, route `1b85c635` and synchronous save
assertion repair `a6724a90`. These are source checkpoints, not independently run
combined application acceptance. At inspection the actual app still constructs
`createSessionCollaborationRouter({ store: eventStore })` without that service.
C requested the consumable mount plus a real prepared-unused-workspace fixture
using external Git/account boundaries and safe workspace-singleton teardown.
The future `/reviews` input includes target selectors; settings must come from
its actual owner result, never the source fixture's `f.settings` or workspace.
A successful Local observational review will remain **unverified** with zero
allocation/inference. It cannot qualify the selected API/OpenShell route, make
joining available or replace the required joining-to-finalized-reply gate.

No tests were rerun for this image/record-only addition. Latest independently run
combined integration evidence remains **10 passed / 1 failed / zero skips** at the
real application review503; the scoped subset remains **7 passed**. At the checked
PR1022 head `9f69920e`, CI was in progress and the Centaur job had completed, with
no submitted review or final LGTM found. Draft status and normal review gates remain.

### Actual application review, recovery and omission control — final checkpoint

Accepted main `136699011e63ae154f6a6bb8b7e46225fbb3dd29` was fetched and merged
into C's own branch without production edits. Its [scoped receipt](symposium-acceptance/accepted-13669901-scoped/result.json)
([output](symposium-acceptance/accepted-13669901-scoped/output.log)) records **7 passing
cases / 4 files**. Focused source TypeScript and ESLint pass.

The independent candidate combines core's committed application service/typed
contract/router/mount through `8513bfee`, the actual workspace idle owner
`e6323256` and actual app teardown call `e9816e22`, and current B implementation
through `b60a7869` (including `cdd81165` local-material callback). It is pinned at
`bd3aa8ab444cd9f174fd89c60e407406778ff21e`, tree
`62bf9a3f9d994f2373eeb13dadf98533262b4665`. B forwarding/context source conflicts
were resolved by selecting B's exact committed files; the router insertion retains
the candidate's existing boolean join handler while adding core's exact review
route. Source-closure pins remain B's source-specific pins. This composition is an
offline diagnostic candidate, **not** a qualified source/runtime distribution or
accepted main. Native algorithms are not recreated or newly qualified here.

[Final actual-app result](symposium-acceptance/actual-review-restart-final/result.json)
and [raw output](symposium-acceptance/actual-review-restart-final/output.log):
**61 passed / 1 failed / zero skips**, 62 cases / 9 files, one worker / 1GiB,
9.28 seconds. The remaining failure is the actual typed `prepareJoin` request:
503, fresh-agent preparation and ordinary delivery are not wired.

The passing real-application case now proves:

- Interactive login, anonymous401, authenticated typed view/policy, original token
  identity/internal-token bytes and source/policy retention across app restart.
- Actual HTTP workspace preview/preparation through the real Connections and
  RepositoryWorkspaces owners, yielding a READY unused target distinct from the
  source chat. Only external GitHub acquisition and identity processes are recorded.
- Actual published Agent Library version and live transport/login binding; review
  reads the selected source, omits the synthetic private provider field and returns
  exact server-derived settings with fresh permission revision0.
- `/reviews` returns200 with **unverified** capacity. Legacy flat `/snapshots`
  remains503. Typed review retry returns the exact saved result.
- A second real app close/reopen retains the same cookie/root, original review,
  settings, workspace and internal token. Only the existing interactive transport is
  rebound. No profile/workspace is recreated and no session/command is allocated.
- Idle Connections configuration is explicitly released after HTTP operations;
  actual app teardown closes only idle owners, fences further HTTP with503, closes
  the listener and removes the synthetic root only after successful release.

This uses a synthetic Local observation account and inert runtime metadata bytes,
which are never executed. It does not qualify the selected OpenAI API/OpenShell
route, count authority, native admission, live model, allocation confirmation,
full different-login lifecycle or finalized application reply.

The [omission-control result](symposium-acceptance/actual-review-missing-mount-control/result.json)
([output](symposium-acceptance/actual-review-missing-mount-control/output.log)) removes
**only** the actual app review factory from the same candidate. It records
**60 passed / 2 failed / zero skips**, failing review503 against required200 plus
the dependent joining prerequisite. The exact production app bytes were restored
and verified against the committed candidate afterward. This is a deliberate
mutation control, not accepted-main behavior or a successful refusal acceptance.

Earlier fixture diagnostics remain preserved: [first preview409](symposium-acceptance/actual-review-mounted-first/result.json),
[call-through diagnosis](symposium-acceptance/actual-review-preview-diagnostic/result.json)
and [private-profile correction](symposium-acceptance/actual-review-private-profile/result.json).
The synthetic account file initially inherited0644 from the empty profile setup;
the real preparation custody owner correctly refused it. C corrected initial
creation to0600 and removed the temporary diagnostic call-through observation.
No production admission was relaxed and no real credential was read.

`--artifacts` now also reuses B's original forwarding and retained-source owner
suites. The earlier [55-case scoped run](symposium-acceptance/final-artifact-custody-scoped/result.json)
is pinned to B `f9409978`; the final62-case combined run additionally includes
original final-await transcript removal/edit, post-prepare custody/privacy and
Promise/value-returning callback refusals through `b60a7869`. Counts overlap.
The independent retained-byte recording handoffs remain green, but durable
application forwarding prepare/confirm/read and recipient delivery are still open.
No new browser, model, native runtime, staging, deployment or merge was performed.

### Independent saved-policy / failed-confirmation visual follow-up

A's final recovery source `6bfbe8d5` is published at
`153fbe4da624c070da3e2d07494087f59f1eb23b`, tree
`6a1f59a89e6b8df8d6e4667c4cec75afe3cef8a8`. C independently inspected all four
new mobile WebKit / desktop Chromium light/dark renders and retained exact Git
blob bytes with hashes in the [recovery inspection receipt](symposium-acceptance/ui-policy-recovery-independent/inspection.json).
Saved-state explanation, confirmation-read error and Refresh sharing are visible
inside Agents; the prior unchecked Reads value and dimmed controls remain rendered,
and the footer is visible. The successful desktop transcript reply is preserved.
These screenshots do not independently prove GET-only retries, disabled DOM/focus,
request counts or completed recovery. A reports those unit/browser behaviors;
C did not launch another browser run or qualify final application mounting/UX.
Earlier seven corrected captures and frozen approval references remain unchanged.

### Exact core source: authenticated begin and private forwarding refusal

Core [PR1023](https://github.com/dimakis/mitzo/pull/1023) source
`cb32e03fda3babb9fe14fd3e486175e5b881f4d6`, tree
`9a33fd7693392147f5871ac4dff8ed49fc127d66`, was consumed directly into a separate C
branch in the existing isolated worktree. Previous `bd3aa8ab` and its branch/evidence
remain preserved. C's clean test overlay is
`713fb30e9e5b499c2466bd821b4c9b41f09e8fdf`, tree
`d5aa7bde9169acc3917ed62defc9752cf3802779`. The [composition receipt](symposium-acceptance/cb32-current-owner-envelope/composition.json)
verifies all product files remain byte-identical to core; only C tests/evidence are
added. No manual production conflict resolution or ad hoc runtime pin choice is
part of this new candidate.

The [final result](symposium-acceptance/cb32-current-owner-envelope/result.json)
([output](symposium-acceptance/cb32-current-owner-envelope/output.log)) records
**116 passed / 1 failed / zero skips**, 117 cases / 12 files, 10.08 seconds,
one worker and1GiB. These counts include the previous bounded cases and core's
existing private-forward storage, normalized selector and ordinary-delivery refusal
suites; they must not be added to earlier totals. Required joining still returns503
through the actual typed client. The linked-agent and finalized-reply success
assertions remain unchanged.

The actual-app fixture now seeds only the synthetic pre-existing chat and source
message through their canonical owners. It no longer calls private
`collaborationConversation.begin`. It instead verifies anonymous begin401,
cross-origin begin403 and no enrollment, then calls the actual typed HTTP begin.
The transport discards the first successful response **after the actual server
commits**, causing a real client-visible failure. Two concurrent exact retries and
another retry after reopening the same root/cookie return the original revision1,
single-source receipt. Session IDs and ordinary command identity do not change.
Existing source/policy restart, real workspace preparation, selected-source review,
typed exact retry, review restart and idle cleanup/admission-fence checks still pass.
This is source-relationship recovery, not allocated-agent confirmation recovery.

The [begin-route omission control](symposium-acceptance/cb32-begin-missing-control/result.json)
([output](symposium-acceptance/cb32-begin-missing-control/output.log)) removes only
`POST /:id/begin` from the actual router. It records **60 passed / 2 failed** in the
62-case envelope, failing at404 against required cross-origin403, plus the dependent
journey prerequisite. The [review-factory omission control](symposium-acceptance/cb32-review-missing-control/result.json)
([output](symposium-acceptance/cb32-review-missing-control/output.log)) preserves
public begin but removes only the actual app review factory; it records
**60 passed / 2 failed** at review503 against required200 and its dependent gate.
Both product files were restored and verified against exact core bytes. These are
explicit negative controls, not successful feature acceptance or main behavior.

The [initial diagnostic](symposium-acceptance/cb32-begin-review-initial/result.json)
records C's mistaken undefined expectation for an absent collaboration. The actual
owner contract returnsnull; the fixture now assertsnull without changing production.
The subsequent [62-case app recovery run](symposium-acceptance/cb32-begin-review-recovery/result.json)
records61pass/1joining failure before the owner envelope was expanded. Its receipt
retains the exact tracked-diff hash for that one assertion change; the later clean
117-case overlay is the current checkpoint. No failed record was overwritten.

[Source-manifest verification](symposium-acceptance/cb32-source-pins/result.json)
imports core's actual TypeScript manifest and fingerprint function and independently
verifies **561 source pins / zero mismatches**, with zero product changes. The normal
compiled checker first refused because this isolated checkout has no `dist` module;
no broad build was attempted. Source checking used tsx outside Seatbelt after its
local IPC pipe was refused inside the sandbox. This is source-hash evidence only,
not compiled distribution, installed runtime, native admission or live qualification.
Focused current-source TypeScript and ESLint pass.

Private forwarding retention/confirmation and the explicit refusal of note-only
ordinary delivery are now independently reused owner evidence. There is still no
public forwarding prepare/confirm/read route, complete selected-content delivery or
native send permit. Full Add agent/join/reply, allocated-agent crash/confirmation and
different-login lifecycle, selected API/OpenShell counting/admission/dispatch,
actual combined-source rendered UX and physical iOS remain open. The eleven earlier
static UI inspections keep their exact A source/hash bounds; no new render, approval
reference, model call, runtime adoption, staging, deployment or merge is claimed.

### Independent serif-fallback header crops — A80231b03

C independently inspected and retained all eight new committed crops from
A [PR1021](https://github.com/dimakis/mitzo/pull/1021) head
`80231b039682b912f3ea6ea43b52293e3e30e37a`, tree
`a606aa2ba6bb0175f0c2ac8318f66691a2d26289`, captured implementation
`fe4f811b0245f5911cd45a74939c8b855d095830`. The [inspection receipt](symposium-acceptance/ui-serif-header-independent/inspection.json)
records each exact Git-blob hash, the unchanged protected-test hash and producer
measurements with their independent limits.

At320, all four WebKit/Chromium light/dark crops show **Architect +2**; at390,
all four show **Architect · Reviewer +1**. Visible names/counts are readable and
adjacent, with the right chevron separated; no visible ellipsis, overlap or duplicated
remaining count was observed. This confirms the bounded visible-name/count behavior
in these static crops against the existing approved container rule.

A reports the CI font-fallback regression at glyph width63.671875, a repaired64px
name track at320, and4px count gap. Those values are producer DOM measurements,
retained as such. Static crops do not independently prove CSS-pixel width, computed
font, gap/containment geometry, focus or browser interactions. C did not rerun the
producer's browser suite or claim that the old failing CI now passes on a newer head.
Exact-head CI/trusted review remain separate gates.

The protected `symposium-approved-design.spec.ts` bytes at A80231b03 were independently
verified identical to A77ce9a27 and the producer hash
`9ac87c581b795a899a5d137d56ae0f0ba3cdd196b3369987b93dfe1dd084aea1`.
The frozen reference remains
`175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
All eleven previously retained A image hashes also match their files at the new
head; their original capture-source bounds remain unchanged. Nineteen unique images
are now independently inspected across the three source-specific groups; image
counts are not test totals.

This documentation/custody update changes no test, assertion, tolerance, production
CSS, reference or ledger. The current117-case corecb32 backend checkpoint is unchanged
at116pass/1required joining failure; these newer A crops do not establish rendered
acceptance of that application source. Full mounted application/join/reply UX,
physical iOS and selected-runtime/native qualification remain open.

### Exactc534 refresh: browser-safe custody and independent browser execution

Core source `c534f3d717a34198fbd0639643b027d2c67879b4`, tree
`a8d853be3c212b96e61b4217f9b6511d5862edd4`, combines atomic67196706 with native
CI dependency3830e3a0. C preserved prior candidate branches and merged only its
scoped harness/evidence into a fresh branch at that exact source. Clean overlay
`b580e7f46ecc368dca213645afc8de28f9b1ab4e`, tree
`6f793776857def8215d6e2b9b07e0d05445b5077`, has zero product changes, independently
verified in the [composition proof](symposium-acceptance/c534-current-owner-envelope/composition.json).

The [actual-owner result](symposium-acceptance/c534-current-owner-envelope/result.json)
([output](symposium-acceptance/c534-current-owner-envelope/output.log)) is
**119 passed / 1 failed / zero skips**, 120 cases / 13 files,9.70seconds.
The only required failure remains actual typed joining503, with linked-session and
finalized-reply success assertions unchanged. Begin response-loss/concurrent/restart,
real HTTP workspace/review/review restart, exact artifact recording handoffs,
private forward storage/refusal, migration and bounded role isolation remain green.
Three newly reused original browser-boundary regressions actually bundle the public
packages, approved chat and shared conversation entries for platformbrowser and
verify that Node custody imports are absent. No harness import or production change
was needed. The private exact helper remains in its explicit server entry.

[Source fingerprint verification](symposium-acceptance/c534-source-pins/result.json)
checks563 actual source pins with zero mismatches and zero product differences.
Scoped current-source TypeScript and ESLint pass. The compiled distribution checker
was not rerun; no broad build or native runtime was installed. The prior cb32 omission
controls remain preserved, not relabelled: app/router and C journey bytes are exactly
unchanged, verified against currentc534, so C did not repeat those negative runs.

C also independently ran the **unchanged** protected approved-design and owned shared
conversation Playwright specs outside Seatbelt, using one worker,1GiB, zero retries,
all traffic intercepted and no server/provider. [Raw execution report](symposium-acceptance/c534-browser-independent/raw/report.json.raw)
([formatted derivative](symposium-acceptance/c534-browser-independent/report.json))
and [result](symposium-acceptance/c534-browser-independent/result.json) record
**12 UI scenarios plus2 startup checks passed**, zero failures/skips/retries,
37.18seconds, across mobile WebKit, mobile Chromium and desktop Chromium, both themes.
Every test has one passed result, expectedStatuspassed and retry0. This browser
envelope overlaps producer scenarios and is separate from the Node120-case envelope;
no combined grand total is asserted.

Six original raw DOM metric files (preserved alongside formatted derivatives) and [twelve measurements](symposium-acceptance/c534-browser-independent/dom-and-capture-receipt.json)
are retained. The independent run measures64px name tracks at320 and4px count gaps
across all project/theme rows; the original width/adjacency/containment assertions
pass. This advances the bounded current-source DOM evidence beyond earlier A-static
observations. It does not change those earlier receipts or retroactively claim their
metrics were measured during static inspection.

C viewed eight selected independent-run captures: setup desktop/mobile, large text,
320/390 serif headers, membership refusal, saved-policy/failed-confirmation recovery
and retained success beside uncertain/pending outcomes. Setup footer copy matches
frozen Add agent markup. Footer/body containment and readable recovery controls are
visible in these states. The actual browser interactions exercise Defaults/@ intent,
text/recipient persistence after reload, focus/Escape recovery, successfulPUT then
failedGET then explicit refresh, later409 refusal and no send. These APIs are entirely
synthetic/intercepted; no real backend joining or allocation occurs in this fixture.

Core's six producer captures, original browser report/receipt and checksum manifest
are separately retained in [producer inspection](symposium-acceptance/c534-core-render-inspection/inspection.json).
C verified their hashes and inspected all six. The producer identifies sourcec534/
implementation671; relevant browser source bytes are unchanged across that merge.
Original producer captures remain owner-attributed, while C's separately executed
report/captures establish the independent rerun. Several image byte hashes coincide
with earlier retained files, so duplicated PNGs are not additional rendered states
or test counts. The raw hash inventories preserve this distinction.

No protected test, reference, tolerance, ledger or production CSS was edited by C.
Actual backend joining-to-finalized-reply, silent allocation/crash/different-login
recovery, selected API/OpenShell native counting/admission/dispatch, complete
saved-content delivery and physical iOS remain open. Passing browser fixtures and
host source hashes do not qualify the full application, installed native runtime,
current-head CI/trusted review, deployment or merge. No model call or staging
operation was performed.

### Evidence JSON formatting repair — original6b8f9f97 execution preserved

PR1022 head6b8f9f97 [CI run39084737528](https://github.com/dimakis/mitzo/actions/runs/39084737528),
main job117548826624, failed Format check on nine retained JSON files. The
[verified job step record](symposium-acceptance/c534-json-formatting-ci-failure.json)
shows tests, lint, type checks and builds succeeded; Summary failed as the aggregate
of the format failure. This was an evidence representation problem, not a newly
observed browser/backend test failure.

The [formatting provenance index](symposium-acceptance/c534-json-formatting-provenance.json)
retains each original publication path/hash/size, unchanged `.json.raw` bytes, a
formatted `.json` derivative and its distinct stored-file hash/size. All nine raw
copies are byte-identical to their Git blobs at6b8f9f97, and parsed JSON plus canonical
data hashes are identical before/after formatting. No source, test, PNG, reference,
formatter exclusion or original producer checksum manifest was changed.

Existing execution `reportSha256`, composition `browserReportSha256` and original
producer receipt hash continue to identify **original raw bytes**, with explicit raw
paths and scope added. Separate fields identify formatted derivatives and their
hashes. Producer retained-file metadata and `RETAINED_SHA256SUMS` now identify current
stored files and include the unchanged raw copies; the original producer `SHA256SUMS`
remains intact as source attribution. Metric representation mappings link each raw
and formatted file without changing the twelve observed measurements.

Prettier is applied only to the derived repository JSON and evidence metadata.
Opaque `.raw` archives retain original bytes without a parser or formatter-ignore
change. This repair does **not** represent another browser/backend execution:
source revisions, execution times, results, counts and full joining/native/UX gates
are unchanged. Fresh normal CI/trusted review is required for the repair's new head.

### Exactfb585 refresh: original source save fence and retained artifact composition

Core PR1023 source `fb5854f6f4280bd84da3abf3c3ae8afb7a167739`, tree
`f85449b00b16a24d769739447c7820dccd5f5e11`, combines accepted9767 (ToolBuilder
and S9 owner work), native542 and B CEN-FA source correctioneacc/core8b5.
C merged its scoped harness into a fresh branch at this exact source, preserving
older candidates. Tested overlay `b4fbc90c06e18b50f71edef88c0276547f847bd3`, tree
`3842d99338a9bac1da8fed85fbcea4c9867f3404`, contains no C product changes.
The [composition proof](symposium-acceptance/fb585-current-owner-envelope/composition.json)
records source equivalence and validation limits.

The [initial actual-owner run](symposium-acceptance/fb585-current-owner-initial/result.json)
([output](symposium-acceptance/fb585-current-owner-initial/output.log)) is preserved:
**147 passed / 3 failed / zero skips**,150cases14files,12.62seconds. Two failures
identified C's retained-artifact fixture omitting the newly required synchronous
original-source assertion; the third was the existing actual joining503.
C adapted only its fixture, keeping the same selected source, exact saved-version
pins, whitespace/Unicode bytes, provenance and successful serialization assertions.
The synthetic operator scope now checks actual collaboration membership synchronously;
the actual context source/EventStore retains and renews the original privacy/source
witness. No reopen or substitute source capability was introduced. A new integration
case hides the actual selected source after review and proves ordinary dispatch is
refused without a sampling request, even when only retained artifacts were selected.
The success and new refusal cases assert the source was opened exactly once.

The [refreshed result](symposium-acceptance/fb585-current-owner-envelope/result.json)
([output](symposium-acceptance/fb585-current-owner-envelope/output.log)) is
**150 passed / 1 required failure / zero skips**,151cases14files,13.53seconds,
one worker/1GiB. The envelope reuses core's fifteen actual producer/EventStore
complete+confirm source save-fence regressions unchanged, plus existing artifact,
private storage/refusal and browser-bundle boundary checks. Actual app auth, public
begin response-loss/concurrent/restart, unused READY workspace, review200/unverified
and review restart pass. Actual typed joining503 is still required RED; linked-agent
and finalized attributed reply success expectations remain unchanged.

[Source verification](symposium-acceptance/fb585-source-pins/result.json) confirms
569 fingerprints for integration.11, zero mismatches and zero C product differences.
Current-source C TypeScript and changed-file ESLint pass. No broad build/native
runtime execution was attempted. App/router/review and required journey bytes are
unchanged from the preserved omission-control sources; those original controls are
not rerun or relabelled. Only unrelated Markdown links/draft-update test files changed
in the frontend/browser paths since c534. The selected protected/shared browser source
remains unchanged; C's c534 report, DOM measurements and captures retain their own
execution bounds. No new browser execution or capture inspection is claimed here.

This is bounded offline evidence. Full joining/recovery/routed reply, actual native
count/consume/dispatch, selected account/runtime, mounted application UX and physical
iOS remain open. S9 remains with its owner. No model call, normal server, staging,
deployment or merge was performed; the parent and milestone remain active.

### Exact420d refresh: typed association reads through actual app auth and restart

Published core PR1023 `420d2570a759859699809e036f551b1cb496efb6`, tree
`e5c3e74a52def5f5266e549713262c3233b7f4f4`, includes accepted main74cfa,
native dependency950 and the metadata-only typed association reader. C preserved
older candidates and composed a new scoped overlay
`0c9a4704cbe2b4aa74c6cc3ac98b6788f6b6f64f`, tree
`f2e6f146a834179950fee6b67d173c86264d21d9`.

C extended its existing actual-app journey to call `listForSession` through the
real authenticated collection GET after the committed begin retries and after the
same-cookie/root app restart. Anonymous reads return401. Exact metadata and terminal
cursor pages, one request per explicit call, unchanged source events/session count
and no initial command are asserted. The actual app route/store/authentication are
not replaced. This adds discovery/recovery evidence, with no inference or context
allocation. All prior begin/workspace/review and required linked-agent/finalized-reply
assertions remain intact. The optional owner envelope now also reuses the original
association client tests; no producer test was edited.

The [actual-owner result](symposium-acceptance/420d-current-owner-envelope/result.json)
([raw output](symposium-acceptance/420d-current-owner-envelope/output.log)) is
**296 passed / 1 required failure / zero skips**,297cases23files,26.34seconds,
one worker/1GiB. This deliberately broader envelope selects `--required --artifacts
--owners`; its counts overlap the151-case fb585 envelope and are not added to it.
Actual joining503 remains the only required failure. Passing metadata discovery
and review do not establish joining, routed finalized reply or full UX acceptance.

A fresh [omission control](symposium-acceptance/420d-association-route-omission/result.json)
([raw output](symposium-acceptance/420d-association-route-omission/output.log)) removes
only the actual collection GET mount in C's isolated candidate, without a replacement
handler/store/response. The actual-app typed read then fails with `Collaboration
unavailable`; the next required case fails its unmet review prerequisite. This control
is **8 passed / 2 failed / zero skips**,10cases6files,6.28seconds, selecting the
smaller `--required` envelope. No joining outcome is inferred from that blocked
prerequisite. [Restoration proof](symposium-acceptance/420d-association-route-omission/control.json)
verifies the original router bytes were restored exactly. The positive run independently
reaches actual joining503; no control mutation is published.

[Source verification](symposium-acceptance/420d-source-pins/result.json) confirms
573 source fingerprints for integration.13, zero mismatches and zero C product edits.
Scoped current-source TypeScript and changed-file ESLint pass. The
[composition proof](symposium-acceptance/420d-current-owner-envelope/composition.json)
records exact source/tree/options and scope. Core app/router/review bytes are unchanged
from fb585; C's journey now has additions only, so whole-file byte identity is not
claimed. Historical begin/review omission controls retain their original bounds.
No frontend/browser source path changed from fb585, and no new C browser execution
or capture inspection was performed. Prior C c534 DOM/report/captures remain source
attributed. Native/runtime/account, complete joining/recovery/reply, mounted app UX,
physical iOS and S9 owner gates remain open. No model call, normal server, staging,
deployment or merge was performed.

### Exact6ddc durable-reader harness: current actual-app attempts remain unqualified

Core published `6ddc2607e36d4d4a90f06f173bb840678d5c8b4c`, tree
`d4fa91befaeed24934acf3766498f72e9daa9fa7`, accepted6de/nativef8,
implementation.16. Core's177 green handler/store/auth/client checks are narrower
owner evidence; they hand-wire the handler rather than prove the production app
injection. C added a **separate** required actual-app durable case, keeping the
original Add agent setup/join/finalized-reply cases and20second setup timeout intact.
The new case calls `MitzoApiClient.getDurableSessionTranscript` through actual app
routing/auth, with expected literal BOM/CRLF/Unicode user text and completed assistant
text/digests, omitted private reasoning/tool/provider fields, no raw replay or source
state/initial command changes, same-root restart and hidden-source refusal. Only the
exact durable endpoint is accepted by its transport; no SDK/restore request or
replacement successful source can satisfy the positive assertion.

Tested C overlay `365eb55b7ce4c0948018803bb322539259111e77`, tree
`2a42999f92d791cf897f09e0874e50a60192ff50`, contains zero product changes.
The optional owner envelope adds five original durable/source suites (fourteen
owner/client/protocol suites total), without editing their producer tests.
[Source proof](symposium-acceptance/6ddc-source-pins/result.json) confirms584 pins,
zero mismatches; scoped TypeScript and fixture/config ESLint pass. Those results
establish source identity and static compatibility, not current app integration.

Four distinct source/time envelopes are retained and **not summed**:

| Envelope                                                                                                                                                               | Result                                      | Observed limit                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Initial required+artifacts+owners](symposium-acceptance/6ddc-current-owner-initial/result.json), [output](symposium-acceptance/6ddc-current-owner-initial/output.log) | 438pass/4fail/0skip;442cases28files;124.20s | Original app20s timeout, new durable and original joining prerequisite failures; original shared-browser bundle5s timeout.                                    |
| [Required-only clean retry](symposium-acceptance/6ddc-actual-app-narrowed/result.json), [output](symposium-acceptance/6ddc-actual-app-narrowed/output.log)             | 8pass/3fail/0skip;11cases6files;92.80s      | Same clean365 source; same original app20s timeout; new durable path not exercised.                                                                           |
| [Phase diagnostic](symposium-acceptance/6ddc-app-phase-diagnostic/result.json), [output](symposium-acceptance/6ddc-app-phase-diagnostic/output.log)                    | 8pass/3fail/0skip;11cases6files;80.38s      | Only15 C timing-observer lines; original timeouts/assertions/product bytes unchanged. First load reached actual app import at5694ms, no return before expiry. |
| [Historical420d comparator](symposium-acceptance/6ddc-comparator-420d-required/result.json), [output](symposium-acceptance/6ddc-comparator-420d-required/output.log)   | 8pass/2fail/0skip;10cases6files;84.47s      | Exact old0c9 source also hits its original20s app timeout on this Mac/dependencies; new durable case is absent on historical source.                          |

The phase [observer patch](symposium-acceptance/6ddc-app-phase-diagnostic/instrumentation.patch)
and [restoration proof](symposium-acceptance/6ddc-app-phase-diagnostic/restoration.json)
retain the actual source diff/hash and exact restored test bytes. Load identity1
prevents confusing an initial import with a later restart. Target import/config
completed before the last marker; connections/HTTP/login were not reached in this
diagnostic. The [comparator restoration](symposium-acceptance/6ddc-comparator-420d-required/restoration.json)
returns C's own checkout to365. The common historical failure does not prove a
host-load cause or a particular source defect; core owns the import/init diagnosis.
No further actual-app retry or source workaround is claimed here.

The [composition receipt](symposium-acceptance/6ddc-current-owner-initial/composition.json)
records all source identities, exact counts, scope and unchanged original setup/
journey bytes. The earlier420d296pass/1required joining503 result remains its original
observation. It is neither replaced by the comparator nor relabelled as6ddc success.
C's earlier browser/DOM/capture evidence likewise remains source-specific: frontend
dependencies have changed since420d, and no6ddc C render/interaction acceptance follows.
Current native/runtime/account, full mounted UX and physical iOS gates remain open.

A new `scripts/run-symposium-durable-injection-control.mjs` implements the requested
missing-injection control. It requires a hash-verified positive actual-app durable
baseline from the **same clean commit/tree and tracked/untracked source**, with no
skips, timeout or prerequisite failures. Only the original required joining failure
may remain. It then removes only the production durable-reader injection, runs the
bounded required suite, restores exact app bytes in `finally`, and accepts an omission
proof only when the new positive durable assertion fails while original setup remains
valid. It installs no SDK/restore/fallback response. Run it in C's isolated feature
composition after a real positive baseline is available:

```sh
node scripts/run-symposium-durable-injection-control.mjs \
  --positive-evidence-dir /tmp/positive-current-source \
  --evidence-dir /tmp/missing-durable-injection
```

Syntax and ESLint pass. The [guard check on actual6ddc app bytes](symposium-acceptance/6ddc-omission-guard/feature-result.json)
([output](symposium-acceptance/6ddc-omission-guard/feature-output.log)) confirms these
unqualified receipts are rejected **before source mutation, output-directory creation
or test execution**; the temporary control script copy was removed. The separate
[primary-checkout precondition probe](symposium-acceptance/6ddc-omission-guard/result.json)
is explicitly attributed to its accepted-base app bytes. **Actual injection omission
is NOT RUN and is not accepted evidence** until the positive app prerequisite passes.

No original assertion/timeout, production/approved UI/reference/ledger/workflow was
changed. No normal server, provider/model call, native runtime activation, staging,
deployment or merge occurred. Parent/milestone and the shared implementation plan
remain with core; this map records the bounded harness and unresolved acceptance gap.

### Exact39a CI: qualified service/API/hook review recovery, separate from production app

C independently downloaded the completed [core ci job117592903558](https://github.com/dimakis/mitzo/actions/runs/39099579412/job/117592903558)
API metadata and raw log for run39099579412. GitHub identifies PR head
`39a308cf5cd4673a90e9058600394fae51c66de6`; checkout logs show actual merge commit
`4a233b922d072cfc3ee17d721335ca02152a1e4d`. Its Git commit API tree and the PR-head
tree are **identical**, `11080db41116021cd17712904f3e7b7c8c204ea5`, establishing
tested source bytes rather than relying on the head label alone.

The [verification receipt](symposium-acceptance/39a-core-ci-verification/verification.json)
and [normalized excerpt](symposium-acceptance/39a-core-ci-verification/excerpt.normalized.log)
record the recovery integration file's **3 passes / zero failures**,1639ms, and
original application-review service file's **29 passes / zero failures**,6843ms.
The full job passes18,349 tests with31 skipped,1,336 files passed/9 skipped. These
named cases are subsets of that total; no sum with each other, C's local envelopes
or earlier checkpoints is asserted. This is independent inspection of normal CI
execution, **not a new C test run**. The retained producer receipt now reports overall success as owner evidence; C
independently checked the completed ci job/checkout, without a fresh all-jobs query.

C inspected the [exact retained test source](symposium-acceptance/39a-core-ci-verification/raw/application-review-recovery.test.tsx.raw).
It connects actual EventStore/application-review service, auth and production
handler/router factories, typed client, React hook and recovery journal through a
hand-wired Express/JSDOM fixture. One case keeps observational review unverified
with no join/allocation. Two cases cover initial/edited review responses lost after
commit, hook unmount/reopen, same-auth transport renewal and reuse of the exact
accepted request/snapshot despite later source/membership changes. They assert no
recapture, no confirmation/recovery invocation, no legacy restore and disabled
confirmation. This is useful retained-review composition evidence.

The capture port is an **explicit fixture adapter** that reads the actual durable
API/view and parses a schema; it is not the final production capture/preparation/
permission adapter. Its controlled `Original brief` fallback does not authorize
production to invent an initial brief. Production `app.ts` injection, first `/begin`
retention, mounted page owner, different-login/allocation/confirmation recovery,
current capacity/authority/native transport, successful joining and full UX/iOS
remain open. No constructor or success fixture was substituted for C's existing
required actual-app test; its6ddc20s failures and the original local5s service
controls remain preserved and unqualified, without source/host-load/flake attribution.

Original [compressed CI log](symposium-acceptance/39a-core-ci-verification/raw/core-job.log.gz),
raw API metadata, original producer receipt and exact source bytes are retained.
Formatted JSON metadata and ANSI-stripped excerpts have explicit representation
hashes; no execution/source/timestamp is rewritten. The verification records the
eight exact raw-log line numbers and uncompressed/compressed hashes. No production,
reference, assertion, timeout, workflow, runtime or model call changed in this
read-only evidence update. C's sole map and the active canonical milestone remain
separate from the root implementation plan and final feature acceptance.

### C48e4 failed browser gate: exact composed source and existing owner repair

C independently fetched [run39101438934](https://github.com/dimakis/mitzo/actions/runs/39101438934)
job metadata, failed WebKit log and failure artifact12126454923. WebKit records
247passes/1failure/12skips: the original unsplit Agent Library journey exceeded its
60000ms test limit. The separate browser-interaction job passed; Connections is
its dependency aggregate failing because the offline matrix failed, not evidence
of a second browser defect. Original failed logs and counts are preserved.

The actual CI checkout is `52fec5e80a4de081f2ed0853421977c961c86ea0`, tree
`17342c3c1db9e18e640d83066b938aa272ae9d44`, composing old C48e4 with accepted main
`d5d3aa0322b55e9e2c8589efc568c7330f0530a8`. C normally integrated that exact accepted
source and verified identical tree bytes. The trace embeds test source hash
`1f3b6e8a931e8f1514d0b3dd7e2ff686e722962ed437ece84a0bb376c23e994c`, identical to
the composed test and accepted6de parent of the existing owner fix. This explains
CI's line33 rather than the older C-head line9. No attribution was made from the
PR head blob alone.

[Diagnosis](symposium-acceptance/48e4-library-gate/diagnosis.json), exact
[trace source](symposium-acceptance/48e4-library-gate/raw/failed-agent-library.spec.ts.raw),
[error context](symposium-acceptance/48e4-library-gate/raw/error-context.md.raw) and
[inspected failure screenshot](symposium-acceptance/48e4-library-gate/failure.png)
are retained. Trace assets show all four appearance sets and final `/chat` handoff.
The last recorded action reads Workspace controls' `aria-expanded=false` successfully
in401.735ms; teardown follows at the overall deadline. This establishes an overall
test-budget failure, without a separate long-stalled action or source/host-load/flake
cause claim. Full171MB artifact and33MB trace remain in C's task evidence directory,
with absolute paths/SHA-256 and original download API recorded in the diagnosis;
the compact relevant evidence is versioned here. No original diagnostic is deleted.

C consumed the existing signed owner commit
`3440ea283508e8fce45b5cf795a692f4d9b61c4d`, sole parent accepted6de, with **only**
`tests/offline/agent-library.spec.ts` changed. Local adoption
`fda8320ad400743663d759aac030c07442e778a2`, tree
`3f589ef6626da53bd6f5e22045f30bff42b2ce2c`, has test hash
`ee566459d7b39c0d2de9354ccb71cb55882a7c29935bceb61c81248efeee15d0`, byte-identical
to the owner and already consumed core39a. No health helper, S7 runtime or unrelated
branch was imported. Product bytes relative to the failed composed checkout are
unchanged. C's independent AST inventories preserve117 assertions,12 screenshot
calls,78 navigation calls, the original60000ms timeout and the equivalent four
appearance combinations (original nested Cartesian product, now explicit cases).
Each case retains the complete journey and original final handoff; fresh fixture
state now runs the same retained-task conflict checks in every appearance. No check,
screenshot path, navigation or tolerance was removed or rewritten by C.

Local listing initially found the borrowed protocol package lacked its compiled
entry. C built only its own protocol package and temporarily selected that package
through a C-local dependency wrapper, leaving foreign source/builds untouched.
The original dependency link was restored exactly. Listing then passed, but approved
outside-Seatbelt focused WebKit execution recorded **0passes/1startup failure/4skips**,
zero retries,42.10seconds. The unchanged browser-startup test exceeded30000ms before
any appearance case executed. This is **UNQUALIFIED**, not a repaired-gate pass.
No launch retry, browser switch or `CODEX_SANDBOX` bypass was attempted; raw report,
source/tree, stderr and dependency-restoration receipt are retained. Source format
and ESLint pass.

Accepted-main and exact-owner commits are composed on an isolated signed C source
with their ancestry retained, matching the audited fixed tree. Combined CI on the
published signed C head `53a6057879493734cba507a234a4f3d28eac31fa` is **PASS**:
[run39104956665](https://github.com/dimakis/mitzo/actions/runs/39104956665), all eight
selected jobs successful. Actual checkout `2a53a5d9c05d2344e55b410a5574069dd1a81ecc`
has the identical tree `0331928678d93fef64d51ffcf4736fa95c14304e`. C independently
retained the raw job metadata, checkout proof and compressed logs.
[Completed source-scoped receipt](symposium-acceptance/53a60578-combined-ci/verification.json).

The repaired WebKit journeys pass in36.7/32.3/31.4/29.5seconds, retaining each
original60000ms timeout. Whole WebKit and mobile Chromium jobs each record251passes/
12skips; desktop Chromium252passes/11skips. Core CI records17668passes/31skips,
1288files passed/9skipped; the separate109-case focused step is not added. Browser
interaction, Swift and Connections aggregate also pass. These counts overlap and
are not summed. Later evidence-only publication changes the head; this receipt
qualifies exactly53a60578 and its identical CI tree, not a future head.
The original Symposium app/omission/join/native/UX/iOS gaps and all historical
source-specific checkpoints remain unchanged. This repair makes no product, model,
live-target, staging, runtime or merge-to-main change.

### Accepted recovery baseline2b22: source preservation and current-head gates

The remote accepted ref was freshly verified before this integration. C combined
only accepted main2b22 with its existing ad74 lineage; no A/B candidate branch or
core application checkout was replayed. Git merge-tree and the actual merge agree
on tree3c930e7d, with no conflict or manual product edit. The signed source merge
retains both parents. The new documentation explains this source boundary and
retains complete prior raw source/hash receipts. All prior harness assertions,
timeouts, protected test/reference bytes and evidence artifacts survive unchanged.
Incoming canonical-advisor schema/fixture and role-recovery controller/client/
protocol/store changes remain byte-identical to accepted source.

The source fingerprint check is identity evidence only. Normal CI and a genuinely
missing explicit whole-PR final review target the final published C head, using
the standing human authorization and normal authenticated admission with auto-fix
disabled. Live queued/running jobs and published reviews must be checked first to
reuse the matching revision and avoid duplicate or obsolete requests. Actual
completed review, qualifying history, dedicated-App approval and strict/base
readiness remain separate checks. Prior ad74 receipts are not approvals for this
advanced candidate. No new account/runtime/device qualification or combined
actual-app success is asserted.
