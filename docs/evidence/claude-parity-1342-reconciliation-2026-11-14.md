# PR #1342 reconciliation

14 November 2026. Ordinary delivery conversation
`059e312d-4552-89ed-83e8-1009eeea3c0c`, explicitly requested by Dimitri. Existing
#1342 is the sole delivery vehicle. Formal Telos lead/worker assignments and
active slice IDs remain unchanged. No duplicate PR, backlog or worker is created.

## Source and custody

Initial remote #1342: `b2675af8199ab8a99f3628d3d93c4e65145c7244`, branch
`feat/session-controls-contract`. Initial accepted main:
`19aa8a19b274ae1fee416f0f187c772111251366`. The isolated checkout uses local
`task/claude-parity-1342`; publication uses an explicit refspec to the existing
PR branch. Original commits/authorship remain ancestors; no force push is needed.

The first accepted-base merge reconciles structured approval cancellation from
#1351 and Stop/pre-input/FIFO/terminal behavior from #1348 with the immutable
command ceiling. The second composes accepted #1349 at
`0ad803cdae56ed6e22c89273ae800d3e7aeb9706`: information helpers and all three Telos
artifact/startup/final-delivery corrections remain intact. The reviewed-source
manifest retains every accepted key and adds only residual source/test entries.

The merge coordinator acknowledged this ordinary session's custody and retained
order #1350 → #1353 → #1342, with parallel preparation and no released #1342 turn.
#1350 owns native positive selection and failed-turn Retry, including retained
original context and uncertain-effect refusal. #1353 owns service composition.
Neither is reimplemented here. Their accepted changes must be integrated before
final combined validation. Reporting/device and adjacent Symposium scopes remain
with their owners.

## Coherent residual

- TaskExecution catalog/SDK callback/managed handler selection, canonical bounded
  grant reuse and profile-dependent routing guidance.
- Shared successful-completion notification ownership, preserving central policy
  and deduplication plus the standalone legacy fallback.
- Strict skill/dependency parsing and immutable original-command ceiling through
  the existing admission ledger, FIFO/query binding, callbacks and managed
  handlers. Public restricted prompt execution remains visibly unavailable.
- Existing Access support labels: recorded context usage is limited; optional
  user branching/rewind remain unavailable.

Composition identified missing direct command-ceiling checks in newly accepted
Telos handlers and the existing web helper. Real MCP regression calls reproduced
short-name/empty-ceiling bypass and missing retirement checks before the fix.
The composed handlers now use exact wire names and existing authority callbacks,
including renewed effect/delivery checks. No alternate permission owner was added.

## Offline verification and limitations

Native setup uses this checkout's existing `prepare-development.mjs --install`:
Node24.22.3, npm11.18.0, pinned SDK0.3.322. TaskExecution status returned no grants;
the user explicitly selected native execution after historical executor network
failures. No executor retry or inherited grant is claimed.

All local Vitest runs use one worker and a 1 GiB Node heap. Retained raw logs are
in the delivery conversation workspace, outside the Git working tree:

- `focused-boundaries.log`:130 tests pass across five suites (task effects,
  original FIFO/command/query ceiling, profile retirement, permission handler).
- `focused-composition.log`:231 pass;19 startup cases fail while fixtures inspect
  denied host `.mitzo` paths. These are not green claims. Small attempted offline
  fixture adjustments did not remove that dependency and were reverted. No private
  host access or production configuration was acquired.
- `information-composition.log`:119 pass across five suites after accepted1349
  composition, including real information/Telos/web MCP calls, API admission and
  the existing task effect fixtures.
- `stop-ceiling-composition.log`:five command-boundary cases pass, including
  restricted Stop-before-input → retained FIFO Continue with a deny-all successor.
- `task-all-profiles.log`:21 task tests pass, including default and explicit
  profiles plus exact exclusions across personal Claude, Vertex and API accounts.
- `residual-public-boundaries.log`:368 tests pass across nine existing suites:
  public skill refusal, parser/dependencies, composer replay, Access controls,
  session launch/prompt operations and WebSocket admission.

Some suite counts overlap and must not be summed. Hosted gates will be recorded
after completion. Synthetic
providers/process effects/push transports are distinct from live model/account,
service-write, physical-device, adoption or deployment qualification.

## Delivery checkpoint

Initial published candidate `1c9174bdc` is mergeable and preserves the original
remote history. CI43600568696 caught a fixture inference cycle after the accepted
`beforeInput` return changed from void to boolean. Explicit return/owner types
break that cycle without changing behavior. A scoped semantic TypeScript check
of the fixture and three affected handler sources reports zero diagnostics.
Source fingerprints pass; the full server build remains a hosted gate after
the local1GiB heap exhaustion. Preflight's printed native-failure lines are
expected negative-control output from its Python fixture tests, not additional
native test failures. Automatic Centaur7468 is queued on the failed CI; no
duplicate review was dispatched. Prior job7356 was skipped at the cycle cap.

Current combined-head CI, trusted Centaur final LGTM/merge with zero
blockers, required independent permission review, actual coordinated turn and
head/base-fenced merge remain required. The old #1342 Centaur report at
`183951ef` identifies Symposium authorization replay; inspect superseding accepted
behavior and retain review continuity rather than treating the old report as a
current approval. Initial hosted CI failures were a Telos oversized-brief timeout
and mobile-WebKit draft-value assertion; dependent aggregate failures add no new
root cause. Preserve those logs; current-head CI remains decisive.

Deployment, live provider/service writes, scheduled messages and worker starts
are outside this delivery.

## CI cold-recovery fixture correction

Run43601079662 on `b719989c8` passed compile/source, core, browser and three unit
shards; shard2 reported five failures in the ordinary SDK integration suite. Four
cold cases waited five seconds for both the restored predecessor's startup/tool
callbacks and the new successor. In the first CI trace, the predecessor's Bash
permission completed at13:50:13.65UTC and its result arrived at13:50:13.75, just
before test teardown began. The subsequent credential-input case also observed
extra queries; interference from unfinished teardown is consistent with that
trace but is not independently proved as its sole cause.

The unchanged19-case suite passes locally. The correction makes the predecessor
boundary explicit: wait for its existing startup budget, hold its result, assert
that the new command has no execution admission or SDK events, then release it.
The existing successor-history assertion and five-second timeout remain intact,
as does the overall scenario deadline. All19 cases pass with this stronger
boundary, one worker and1GiB heap (`ci-cold-boundary-green.log`). Scoped lint,
formatting, whitespace and regenerated source fingerprints pass. An ad-hoc
semantic check used the server config for this integration file and encountered
inherited fixture/rootDir diagnostics; it is not reported as a passing project
typecheck. Hosted preflight and the new full CI remain the required evidence.

## CI journey budget and retained authorization findings

The next hosted run43604579700 (`cba3a83db`) passed the repaired predecessor
boundary and the credential-input scenario. Its four remaining failures reached
the whole-journey30-second deadline later, around `active-stop` or
`saved-after-stop`. The first trace contains four completed SDK results between
14:27:13 and14:27:30UTC; each information turn takes about five seconds. These
cases combine five SDK command starts, four real MCP surfaces, cold recovery,
revocation and Stop. The aggregate journey budget is now60seconds; existing
phase deadlines, positive assertions and negative controls are unchanged. All19
cases pass locally with one worker/1GiB (`ci-cold-budget-green.log`,141.94s).
This is functional qualification with synthetic providers, not a performance SLA.
An additional local experiment inserted five seconds of synthetic latency into
each of the four MCP information turns. The full first/queued/cold/Stop scenario
passed in44.22seconds with its original phase deadlines; the temporary delay was
then removed (`ci-cold-budget-latency.log`).

Retained report6865913086 correctly identifies two separate authorization
defects in the canonical `SpecialistConsultations.authorize` owner:
`CEN-9D5A3F9C4150` (blocking role/profile-pin replay) and
`CEN-BC17E8AFBA41` (requested-duration immutability, a nonblocking follow-up).
Neither is delivered by #1350; its owner confirmed their distinct scope. This
repair retains normalized authorization intent in the existing policy receipt's
`input` alongside the resolved selection. An exact replay compares that intent,
reuses original profile pins and expiry, and revalidates current authority,
account, runtime, profile and repository. Changed duration (including shortening),
routes or limits conflicts before approval or receipt replacement. Revoked or
expired policies cannot be reauthorized by replay. No new registry or store is
introduced, and public policy response fields remain unchanged.

Legacy receipts without retained original intent stay readable/usable under
their existing policy guards. An authorization replay refuses to invent their
original duration and directs the caller to review a new requestId. The focused
regressions use the actual owner and SQLite ledger with synthetic dependencies;
they include role ambiguity after publication and ledger reopen, explicit pins,
normalized defaults, changed intent and authority negative controls. Against the
old authorization owner, the initial20-case regression set produced10failures
and10passing controls, including the reported role and duration defects and
revoked/expired replay. This is not a claim that all10 failures are distinct
product defects: some check earlier conflict classification or new legacy
refusal behavior. Centaur must verify the published repair and retain its prior
finding ledger; local evidence is not a final LGTM.

Final focused qualification:29 tests pass across the authorization regression,
existing policy store and actual specialist-tool handler suites
(`ci-specialist-replay-final.log`). Four affected source files have zero scoped
semantic TypeScript diagnostics under the server configuration. The full build
remains hosted CI evidence because the earlier local build exhausted the
prescribed1GiB heap. Source fingerprints and the runtime revision are updated
for this reviewed delta. No live specialist, account or service was invoked.

## Parallel composition with #1350, 14 November

The retained published baseline is `9879cf7d2`, integrated against accepted
`0ad803cd`: CI43607478432 passed all33 jobs and trusted Centaur review5905495499
reported LGTM, recommendation merge, zero blockers/follow-ups and one verified
resolved finding. Its required App-owned status succeeded. This evidence does
not approve subsequent composition edits.

Local preparation merges exact #1350 candidate
`186807ceb3938352a37a7bc6e4477c9f3c65c68d`, including its legacy Retry UI correction,
while retaining the assigned task branch and original histories. #1350 owns native
positive selection, bounded Retry and coordination tools; this session does not
reimplement those features. #1353 services and its accepted integration remain
separate owned work. Actual landing order remains1350,1353,1342; no1342 turn or
deployment authority is implied by this preparation.

Six conflicted files were reconciled. The catalog and SDK bridge retain
TaskExecution together with #1350's coordination/profile/session/scheduler tools.
The original query's command authority and per-wire-name managed handler ceilings
remain in force, including StartSession and TelosCreateSession. The final input
fence runs the ordinary owner's positive Stop cancellation before the peer guard;
valid steering retains the active command ceiling. Retry retains its canonical
source, deterministic command identity and FIFO priority. Existing #1349 corrections
and #1342 authorization replay/duration repairs remain present.

The composition exposed an additional #1342 handoff defect: the canonical skill
freezer reconstructed a prepared context from text/prompt, dropping an inherited
allowedTools ceiling for a new derived command. It now captures the complete
trusted prepared context through the existing ledger, preserving deny-all versus
an absent legacy ceiling, including retained contexts with plain command text.
No public restricted-skill execution is enabled: current direct/dependency
restriction refusals remain tested. There is no new admission registry or store.

Six freezer cases cover slash/plain text and absent/empty/Read ceilings, a later
queued Write context, no latest-catalog read and detached input arrays. Before the
fix five failed and one passed; all six pass after the fix. An actual SDK boundary
case joins canonical derived admission/freezing to callbacks: Retry allows Read,
refuses Write and the actual TaskExecution wire name, retires old callbacks and
then applies the successor's independent deny-all ceiling. A widening control
failed on an unexpected Write allowance and was removed.

Local qualification uses one worker and a1GiB Node heap, synthetic providers and
effects. The combined SDK journey suite passed22/22 in170.73s before the final
freezer correction;216 focused checks passed, including the UI's legacy confirmed
Retry, TaskExecution, native profile selection and coordination invocation. After
joining the new SDK regression to the actual freezer, its two suites passed25/25.
These counts overlap. Final affected SDK checks, source integrity and hooks are
recorded in the ordinary delivery checkpoint. No rendered browser/device or live
account/model/service qualification is claimed by these source/component tests.

After the freezer fix, the four affected public Retry/preparation journeys passed
again (36.61s); the other18 cases retain the full-suite result above. Design and
coordination/messaging checks passed141 with one existing skip. The three SDK
authority-refusal cases then passed after their expected registration list was
updated to include the scheduler tools; their post-approval refusal assertions
remain intact. Seven scoped source/test files have zero semantic TypeScript
diagnostics. This is not a full repository typecheck/build. Source fingerprints
were regenerated for runtime revision1165 and verified against the combined tree.

Fresh combined-head CI, exact-head trusted integration review, required independent
permission review and actual accepted1350/1353 composition remain landing gates.

## Parallel service composition with #1353

The next local composition consumes exact service candidate
`3e4f83ec90d162e367f45deaa5527c791be03164`, independently refreshed from its existing
branch against accepted0ad803cd. Service ownership remains with its existing
owner. The merge retains its full native Connection eligibility (including
ListConnections), canonical Google consent, configured/API tool catalogs and SDK
adapters, alongside TaskExecution, coordination and the original command ceiling.

New service entry points must borrow the original query's per-wire authority.
Google's separate MCP union-schema registration now checks the actual
`mcp__mitzo-connections__GoogleWorkspaceRead` name before and after its existing
authority/credential waits and through its effect owner. Configured/API callbacks
check their actual `mcp__mitzo-tool-library__...` name. Existing lazy admission
callbacks retain a bounded cache per registered wire name so one tool's authority
cannot be reused for another name; all cached peers retain the existing cleanup.
These caches grant nothing and introduce no permission registry, queue or recovery
store. Profile, mode, connection, account, receipt and cancellation checks remain
with their canonical owners.

Six actual MCP invocation regressions failed before this integration wiring and
passed afterward. They cover original wire refusal and loss of the ceiling during
asynchronous credential/MCP-source preparation, with zero synthetic effects after
refusal. Positive MCP/API cases additionally invoke the exact frozen wire through
three successive/retired adapters. Existing skill, profile exclusion, grant
revocation, cancellation, exception privacy and uncertain-result controls remain.

The service continuation fixture now consumes a real first SDK input before
asserting resumed history for its successor; merely registering/invoking an MCP
handler does not establish SDK conversation history. Its34 cases pass. Full
combined SDK journeys, focused consumers and source/type/hook results are retained
in the ordinary checkpoint. No hosted or reviewer approval of these unpublished
composition changes is claimed.

The final combined tree passed all22 SDK journeys in163.59s and199 focused
checks across nine suites. These include the43 Google/library cases and34 direct
connection cases, TaskExecution/coordination invocation, capability projections,
and stale/late SDK authority. Counts overlap earlier results; do not sum them.
