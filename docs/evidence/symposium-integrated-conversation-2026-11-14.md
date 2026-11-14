# Integrated ordinary conversation surface — slice 1

Implementation base: accepted `main` at `9af764899`. Isolated branch:
`fix/symposium-integrated-conversation`. This slice changes transcript/composer
integration and the existing ordinary owner needed to address the original agent.
Chats grouping remains slice 2's work; combined application acceptance is slice 3's.
No Telos assignment, merge, deployment or real-provider qualification is claimed.

## Result

- Ordinary history and authorized shared messages render through one `ChatArea`.
  Existing rich blocks, live output, permissions and message controls retain their
  owners. Source conversation/message/command identity reconciles echoes; equal
  text from independent sources or commands remains. Independent sequence cursors
  are never sorted together by wall-clock time.
- The ordinary `ChatInput` stays mounted through joining, source activity and
  responsive page changes. The existing status rail, draft, context, attachments,
  Terminal and selection survive. Shared text-only limitations explain what must
  be removed; retained content is not discarded. A retained input follows current
  recipient routing even while a resized page awaits status qualification.
- A newly shared chat explicitly addresses the original named agent. Saved empty
  and default-empty choices stay empty. Choose who replies opens the existing
  picker. Reader and default-reply policies are unchanged by joining or reading.
- Existing shared send/Stop journals own uncertainty, partial successes and
  recovery. Participant removal cannot return pending work to ordinary dispatch.
  Refresh checks stale state; Check original request reconciles uncertain work.
  Source activity cannot replace routing or redirect Stop to a different command.
- Original local Codex and SDK owners can receive observed shared commands through
  their existing authenticated admission. Codex retains an observer per command,
  forwards native acceptance/terminal receipts, and suppresses automatic failed-tool
  continuation for that observed command. No new session or client-only authority
  substitutes for the source's owner. Foreign or unsupported owners remain refused.

## Red/green evidence

Focused production-component regressions first reproduced two transcript containers,
composer replacement, inaccessible empty-recipient recovery, source-running control
replacement, lost rich drafts, echo conflicts and stale routing after viewport
qualification. Assertions exercise `SymposiumConversation`, `SharedConversationHost`,
`ChatArea`, the real `ChatInput` and their hooks. Only HTTP/authentication/external
membership boundaries are deterministic fixtures.

The delayed-status regression retains the exact textarea, draft, focus and selection
immediately after a responsive owner remount. It changes recipients and sends before
the status response returns, checking the exact selected recipient and request count.
Existing unbound-input and backend-refusal tests caught two further integration
regressions; both pass after correction. A final omission regression also proved
that retained recovery notices could reach a retired page's status sink during
qualification. The portal now binds the current status owner, keeping Check original
request visible and functional without replacing the input. CI-reported timer and
session-prompt fixture typing errors were corrected with explicit timer handles and
schema-validated collaboration settings.

The stronger actual application recovery assertion subsequently exposed a second
status-owner omission: the portal carried the sink and active state but omitted
`ViewContext`, which the status rail inside `ChatInput` reads. The preceding unit
test had supplied an external rail and masked that topology. Removing the extra
rail reproduces missing recovery/details controls. An isolated status-view bridge
now forwards the page's reader state without making notice reports rerender their
own input. The corrected test opens the real status details and retains the exact
textarea through qualification. API recovery alone did not establish this UI gate;
slice 3 subsequently verified the independent application assertion on combined
`ee2b8440e`: 21 checks across four files passed. The actual lost-response UI opens
Conversation status details and checks the original request without another turn,
then completes the 31-turn Stop/reconnect/restart continuation. Status details
legitimately groups multiple notices; the visible details-to-Check path is the gate.

The original-owner dispatch test first failed with “Choose a fresh configured group
participant.” It now checks original authenticated Codex/SDK owner reuse, unchanged
transport/client identity, lifecycle forwarding and rejection of another login.
Native adapter tests verify lookup of a later command's observer on the existing
owner; observer tests cover exact-command isolation and terminal/teardown cleanup.

Verified locally, one worker and a 1 GiB Node heap:

- 292 composer, integrated conversation, transcript and sending regressions across
  25 suites; 76 existing `SymposiumConversation` tests also passed.
- 244 native lifecycle, session-prompt, scoped-dispatch and observer tests.
- 176 ordinary Codex/SDK owner, delivery/recovery, contributor Stop/viewer and
  native dispatch regressions across seven suites.
- Design guard: 109 passed, one existing skip. Approved HTML remains SHA256
  `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
- Protocol/harness/client TypeScript builds, focused ESLint, formatting and reviewed
  source registration checks passed.

Representative commands:

```sh
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run frontend/src/components/__tests__/ChatInput* frontend/src/components/__tests__/OrdinarySharedConversation.test.tsx frontend/src/components/__tests__/SharedConversation.test.tsx frontend/src/components/__tests__/SharedConversationStatus.test.tsx frontend/src/components/__tests__/CollaborationTranscript.test.tsx frontend/src/hooks/__tests__/useConversationSending.test.tsx --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 npx vitest run server/__tests__/ordinary-turn-observers.test.ts server/__tests__/codex-chat-session.test.ts server/__tests__/session-prompt-dispatch.test.ts server/__tests__/ordinary-scoped-command.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=1024 npm run test:design -- --maxWorkers=1
node scripts/check-reviewed-handler-artifacts.mjs --source
npx tsc -b packages/protocol packages/harness packages/client
```

## Independent application and visual states

Slice 3's combined candidate `7f4055305` includes this slice through `5908c4dc6`
and slice 2. Its reported green journey, retained in `d80bd1d89`, uses actual
`ResponsiveChatView`, authenticated application, admission, stores and SSE with
deterministic external native RPC. It covers source/reviewer concurrency, partial
failure, failed-recipient-only retry, long history, lost send/Stop responses, one
interrupt, exact retry without replay, reconnect/remount and application teardown/
reimport of the same database. The later narrow fixes and final combined head still
require slice 3's fresh acceptance/CI results. Source order is identified by exact
thread/command identity; global turn ordinals are not source identity.

Hosted ordinary-page screenshots subsequently exposed another approved-reference
gap: both real responsive pages passed `compact` to the Agents action, which omitted
all participant names even after sharing. The special-preview reference tests did
not exercise that branch. The existing compact action now shows the approved name/
count span when the shared host is active, retaining its button and Agents dialog.
On phone this uses the old metadata summary's space, with settings preserving the
details and existing header actions. Existing tokens provide a readable name track;
the bot remains visible and the redundant phone chevron is omitted. A red/green
ordinary compact-header joining regression proves names and unchanged input/button
identity without inference. The 97 focused participant/shared/native-presentation
tests and 109 design checks pass. Actual ordinary-page name width, overflow and
paired screenshot acceptance remain slice 3's hosted rendering gate.

Slice 3's corrected hosted reference adapter subsequently reached the real 320px/
200% text assertion: all six engine/theme cases retained a 52px name track, and
the captured header pushed Links & access/New chat outside the visible row. This
is a confirmed rendering blocker, despite the earlier component checks. The
named ordinary heading now permits flex wrapping, and its text track reserves
space for the adjacent count. The narrow ordinary browser fixture now includes
the production WorkspaceControls, participant action and SessionAccess alongside
the real composer, with unchanged 64px minimum-name and 44px action checks at
200% text. It bundles/lists; 123 owner/design checks pass with one existing skip.
Fresh hosted geometry and screenshot acceptance remain required; local browser
execution remains blocked as described below.

The next hosted combined run (`f60ad7ce3`, run `43594789588`) independently
verified phone 320/390px bounds, name/count spacing and all header actions in
normal and 200% text. The 320px name track measured 69.61px normally and 111.22px
at 200%; 390px measured 158px/166px. Its remaining six failures were at desktop
1280px/200%: the 172px minimum entry left 52px after two 20px glyphs, two 24px
gaps and two 16px paddings. The desktop minimum now includes those existing
glyph/gap/padding tokens as well as the name track; the verified phone minimum
is preserved in the phone rule. Slice 3 subsequently reports run `43596283360`
at combined `1cab1837c` passing both actual application and responsive render
jobs, including desktop/phone geometry. Its capture inspection and full CI remain
separate gates; this branch has not independently rerun the hosted matrix.

Dimitri's composer feedback requires the ordinary shared recipient control to
remain icon-only and retain the original context wheel, microphone, tools and
resources. Names and unavailable selection details remain in the picker, tooltip
and accessible description. A production-owner regression keeps the exact input,
wheel and microphone through joining, reviewer-only selection, source activity and
responsive requalification. It opens the real wheel and proves that its usage is
still attributed to Architect, then invokes the original voice owner. No hardware
or speech/model service is used. This test and 53 related composer/status/usage
checks pass. The narrow browser fixture now explicitly supplies deterministic
audio capability and token evidence through existing props, with DOM-retention
checks for the real MicButton and TokenBar. The broader application fixture lacks
these capabilities and cannot prove those controls' visibility.

The user also approved the separate `v004` exploratory context-wheel mockup:
selected-agent color segments and count in the composer, individual named wheels
in the Agents popup, and unreported usage kept unknown. This is a retained design
direction, not implemented multi-agent usage plumbing or production acceptance.
The current production change names the existing source wheel; it never relabels
source usage when a different reply recipient is selected.

Full CI at `6e64337be` exposed additional stale fixture contracts. The two existing
application UI journeys selected a reviewer while retaining the newly selected
historical source, which has no live send owner. Both reproduced red. They now
explicitly address only their real reviewer and supply retained ordinary messages
through the transcript owner. Both application journeys pass, including long
history/remount and fresh-agent context/partial failure/Stop recovery. Empty
Defaults adopts server policy changes through the existing observer without
inference; the earlier stale-policy case still exercises explicit Refresh.

The old browser fixtures now retain picker/input identity through singleton
membership, inspect icon-only selections by tooltip, and use the named Architect
checkbox. Their external boundaries explicitly handle only the original agent's
readiness read and the exact POST `/api/telos/work/links` navigation read. Unknown
reads and mutations still fail. All 42 affected render scenarios plus two startup
checks list/bundle; lint and formatting pass. Rendered execution remains pending.
The same CI run's separate CT07/09 non-Git joined-browser contract timed out at
120 seconds; its original log is retained, with no root cause established here.

Accepted main `0ad803cda` (ordinary Claude information tools, #1349) is integrated.
The sole conflict was the source registry; all 2,458 unique entries from both
parents remain, with hashes regenerated from the combined source. The auto-merged
`chat.ts` retains ordinary ownership and accepted information-tool instructions.
Both real application UI journeys plus the affected Claude-information/SDK-effect
owners pass: 31 checks across four files, plus 36 original-owner dispatch checks.
Current combined CI and exact-head
Centaur verification remain pending.

Slice 3 reports hosted run `43599810172` (job `132461946147`, combined `bb868`)
passing the application journey and all six actual ResponsiveChatView/icon-only
cases. All six narrow fixture cases stopped at the context-owner assertion:
substring `Agent` matched Agent, Agent loop time and Agent time rows. Its selector
now scopes the exact child label before checking the full owner text. This is a
test-only correction; original failure evidence remains retained and fresh hosted
execution is required.

The expanded hosted run `43600918311` reports 11 application checks and 50/56
browser checks passing, including all six narrow wheel/microphone cases and all
actual responsive cases. Slice 3 retained the singleton/light WebKit trace in
artifact `14116124654`, job `132465272305` (trace SHA256
`28f453ee222f950051cdf7c64ff47df3bcff2c9353b45c9f674ebec4147bb5a7`).
Its only non-GET was POST `/api/telos/work/links` with the exact Architect
conversation reference, aborted by the fixture and miscounted as a write. The
authenticated server handler performs a navigation read. The singleton fixture
now handles only that exact path/method/body as a read; all other non-GETs remain
counted and the zero-write assertion stays. No production changes. Hosted rerun
remains required for these six cases.

Full CI exposed the existing forwarding UI fixture's old zero-recipient
assumption: selecting Reviewer also retained the new original-agent selection,
although that historical source intentionally has no live ordinary owner. Its
production readiness check correctly refused this audience. Slice 3's test-only
`7b2130d62` change explicitly deselects the source and waits for the remounted
context control's qualification before clicking. The same two hunks reproduce
red/green here through the real application/UI forwarding journey, retaining one
confirmation and one native turn across lost confirmation and remount. No
production readiness or control authority changed.

Centaur's `bb219f421` review identified four further blocking regressions. Focused
owner tests reproduce all four before their fixes: encoded native delivery packets
replacing multiple operator bodies, source finalization/tool-only rows moving above
their shared prompt, reviewer uncertainty hiding the independent original Stop,
and a queued send awaiting durable preparation dispatching after navigation. The
fix retains projected operator bodies/IDs and suppresses their exact native echo;
anchors unreconciled source rows by command and source order; retains both Stop
owners; and scopes the retained portal store to the conversation identity. Both
queued sends and corrections now refuse dispatch after navigation while keeping
their retained queue rows. Responsive transitions within the same conversation
continue to preserve the same input. Fresh Centaur verification remains required.

Centaur's combined `b93961fb7` review then identified two additional blockers:
`CEN-6CFB95D6132C` (assignment/fork remount loses the draft and remaining queue)
and `CEN-A5B18F62570B` (native delivery packets resurface after the fifty-message
shared window rolls over). The real-client send-receipt fixture now mounts the
actual `ChatInputHost`: four assignment/fork cases failed before the production
fix while the unrelated-navigation controls still passed. The live-window test
also reproduced the encoded native packet becoming visible. Original red logs
remain in the task's `slice1-validation/slice1-host-assignment-red.log` and
`slice1-rollover-packet-red.log`; slice 3 independently retains application-level
rollover/reopen/restart failures and correlated assignment/fork failures.

The portal now transfers only when the current submitted operation records its
exact source/assigned identity and still owns its draft scope. Existing assignment
receipts, edits, focus and queue stay with that mounted input. Navigation, New,
unmount and late foreign assignments retain their existing retirement fences.
The projection separately retains earlier messages when its live window shifts.
An authenticated reopen reconstructs exact bodies and delivery revisions from
the existing paged event API up to the frozen snapshot cursor; later refreshes
read only deltas. No new endpoint, reader authority, inference or text matching is
introduced. History validation rejects sequence/scope/identity gaps and passes the
current abort signal to each read. A failed read keeps the last complete projection;
initial loading defers native rows until command suppression can be verified.

Current focused validation passes 234 tests across ten affected owner suites,
including 32 real-client send receipts through the retained input and 11 client
projection cases. These cover old delivery revision updates, delta-only refresh,
cancelled reconstruction and malformed/foreign history. Both existing actual
application UI journeys pass; design checks pass 109 with one existing skip.
The production-wrapper failure control verifies the native packet remains absent
before association, during a deferred page read, and after an incomplete response;
the same textarea/draft and explicit Refresh conversation action remain available.
The client package builds and focused lint passes without warnings. The earlier
hosted 11-application/56-browser checkpoint predates these two fixes; independent
combined application/browser qualification and exact-head Centaur verification of
this successor remain required. These findings are not marked reviewer-closed.

Independent application qualification of `8dea24770` passed the three retained
history/body/projection-ID phases and correlated assignment controls. Its new
desktop grouped-search/Open journey exposed a further integration gap: the exact
participant's native history loaded successfully, but source setup correctly
returned `foreign_origin`, leaving the new packet-safety gate waiting. The guard
is retained. Source setup now has a separate `participant_history` observation
containing the requested participant, original begin source and current membership.
It requires the existing continuous linked-join owner and verified original begin;
ordinary foreign membership, corrupt proof and multiple associations remain refused.
There is no new endpoint, inference or grant of source/participant send authority.

The participant route hydrates parent command anchors through the same authorized
history reader, displays canonical prompts delivered to that participant plus its
own rich replies, and omits other agents' replies. It keeps one transcript/input,
draft, focus, selection and tools. Send/interrupt, join and policy mutations are
unavailable there, with an explicit Open shared conversation action using the
verified source ID. The original participant Stop owner remains intact. Legacy
embedded consumers without a router keep their ordinary controls; qualified
history still refuses dispatch and explains how to return through Chats.

The new production-wrapper test reproduces failure before qualification support,
then verifies exact prompt/body occurrence, absent native packet/foreign reply,
one transcript/input, retained draft/focus/selection and the exact navigation
action with zero writes. A real store allocation/link/restart test verifies the
new observation and refuses a removed/readded participant's stale linked proof.
Client schema controls reject self/foreign original-source claims. All 135 affected
owner checks across seven files, both actual application UI journeys, protocol and
client package builds, 109 design checks (one existing skip), and focused lint pass.
Independent full application/search/Open and hosted successor qualification remain
pending; the previous accepted forced review job7484 covers only `8dea24770`.

`tests/offline/symposium-ordinary-surface.spec.ts` adds the actual ordinary production
composition to the offline browser matrix: remote joining, one transcript, exact
input preservation at 320/390/1280 px, source activity and empty selection in dark/
mint/system and light/teal/Georgia settings. It bundles and lists six scenarios.
Local browser execution is **unverified**: the default executable was absent;
dependency installation downloaded Chromium but failed downloading FFmpeg. The
supported executor's attempt to launch that installed Chromium failed macOS Mach
bootstrap/socket registration permissions. No denied launch was repeated or sandbox
guard bypassed. Hosted browser execution and capture inspection remain required.
The first hosted traces also exposed an external fixture prerequisite: its socket
builder intentionally threw while the store connected, preventing rendering. Slice
3 supplied an inert deterministic welcome transport in `06ad8abd7`; its exact
narrow-fixture correction is retained here. This is a fixture-only correction,
with fresh hosted rendering and capture inspection still required.

The full frontend typecheck exceeded the local 1 GiB heap. Hosted preflight and
frontend production build subsequently passed on `159358c08`; the status-view
successor still requires fresh compilation and browser checks. Physical-device behavior,
the user's exact failing phone build/request and production acceptance remain
unverified. No real model calls, credentials or private reasoning were used.

PR #1347 was inspected: open/draft at `4f5dd94981c9c4bd4b9b31e639a3fae7f560772f`,
conflicting, and scoped to joining readiness/permissions/dialog bounds. This slice
does not duplicate that implementation. Merge priority remains the complete Claude
parity stack first, then integrated Symposium validation and exact-head Centaur/CI
gates under separate merge authorization.

### Exact-head review follow-up: imported history and SDK pre-input Stop

Centaur job 7488 processed head `4ba082d5412921fac0244015b6f46252cdad08d5`
and returned `human_decision`, with CEN-810B598C8E4E and CEN-0B3D24E6F442
still blocking. Its successful check is processing status, not LGTM:
https://github.com/dimakis/mitzo/pull/1356#issuecomment-6880187597.
That head's full CI 43611496998 subsequently passed. These new fixes still require
their own exact-head review and CI; neither finding is reviewer-closed here.

Imported SDK history is independently authorized ordinary history. Source setup
now returns an observational `ordinary_history` result only for a visible imported
session with no current collaboration association. SharedConversation retains its
ordinary rich history, mounted input and draft without creating a shared identity.
Hidden imports remain unavailable; an import with a current shared association
cannot bypass packet qualification. Protocol and actual production-wrapper tests
reproduce the old hidden-history behavior and verify the exact read-only contract.

Pre-input SDK cancellation uses positive retained evidence for the exact original
session and command: a consumed SDK admission, its exact execution token terminal
reason stopped/abandoned, the owner's cancellation error and zero SDK turn events.
Stopped maps to interrupted and abandoned to failed. SDK acceptance, provider
terminal evidence and visible replies are not manufactured. Error text, generic
completion, another session or a missing acknowledgment alone do not settle work.
The original observation survives store restart and does not consult today's
active generation. Existing whole-session cold-input qualification keeps its
additional terminal/all-generation checks.

The shared Stop port can now address the exact active pre-input command through
the existing SDK queue owner, before a native interrupt target exists. It retains
normal authentication, current-owner and synchronous execution fences. A foreign
command or already-yielded input cannot use this path. Native interrupt behavior
and its uncertain receipt remain unchanged. The actual SDK/application test warms
a reviewed participant, holds only the deterministic external account-info return
before input yield, sends and stops through the production shared composer, then
uses its actual Check original request action. It retains the later draft and
same textarea, clears pending Stop, and proves zero additional SDK inputs or
interrupts and no invented SDK/provider events. No application model is invoked.
The previous two SDK application journeys share the extracted external fixture;
the new DOM test has its own file and application lifetime.

Initial focused red evidence had three failing regressions (imported protocol/UI
and exact cancellation observation); the original log remains in this task's
`slice1-validation/slice1-centaur-4ba-red.log`. The final combined run passes 149
owner checks across 14 suites, including the actual SDK UI journey and adjacent
ordinary/forwarding journeys. Design checks pass 109 with one existing skip.
Focused lint and package builds
pass. Full server compilation exceeds the local 1 GiB heap; its log is retained
and hosted current-head preflight remains required. Independent imported-history
application reproduction and successor verification belong to slice 3.

### Native CI fixture cleanup after accepted-main integration

Accepted main `416faccb366f64ab858897f5b4bfa465e91ef385` is integrated in
`c9caf405696b56e014b897d48ebdb5464b8ba191`. Both exact SDK input-cancellation
and current-generation command-identity helpers are retained, together with
accepted coordination/retry behavior and all 2,465 source registrations. After
integration, 243 checks across 21 suites pass (one existing design skip), with
package builds, lint, formatting and source pins green.

Full CI 43618643185 has a different native failure from slice 3's uncertain
repository capture. Job 132520882437 fails only the native Claude-login fixture's
`afterEach` directory removal with `ENOTEMPTY` (log lines 389–400). Its sign-in
link assertions and awaited cancellation/completion ran before cleanup; the other
three sandbox checks pass. Original job log SHA256:
`b95b8a27a8d84e415f85bf861dce3f579ea87aba13e101cece20f66d0d008278`.
The log is retained in this task's `slice1-validation` directory.

The test cleanup now uses Node's bounded recursive-removal retries (five retries,
50 ms retry delay). Persistent cleanup failure still fails, and all four native
assertions remain required. No production owner, authorization, process lifecycle
or model call changes. This does not resolve or replay slice 3's separate unknown
repository-capture outcome.

Focused lint and formatting pass. Local process fixtures exit before readiness
(five failures, four passes across three test files), so native cleanup remains
unqualified locally; those original outputs are retained. Fresh hosted native CI
and final exact-head Centaur verification remain required. No launch restriction
was bypassed and no provider/model execution was introduced.
