# Combined parity candidate

13 November 2026. Local preparation for existing draft PR
[#1342](https://github.com/dimakis/mitzo/pull/1342), preserving its history and
the original slice checkouts. This supplements the earlier
[functional checkpoint](local-integration-checkpoint.md); its compatibility-only
proposal and pending custody are historical.

## Inputs and resulting behavior

- Accepted source: `23816770cc1d80b16c557dd88f7078c7cf53f163`, including the
  accepted PR #1322 visibility owner. No speculative main refresh was performed.
- Local functional candidate: `798bb56b7476dc0302341e9e7110ebf075d3930e`.
  Ordinary Claude TaskExecution uses the shared task grant, permission and
  notification owners. Profile exclusion removes task guidance and admission.
  SDK completion delivery defers to the installed central notification owner;
  the standalone legacy path retains diagnostics and existing behavior.
- PR #1342: `6dc2ba3322dbdc2a870c25b35b4b4f2d5c4f132d`, merged locally at
  `15f04587`. The additive controls contract lives beside `helperSupport` in the
  accepted protocol `SessionAccessEvidence` interface. The existing Access
  projection and sanitized logging remain the owners. Branching and rewind are
  unavailable; qualified context inspection means recorded usage only.
- PR #1343: `b9e2adaba6288b4de69f02259b33c72181757cd0`, plus the completed
  local follow-up `8ff47e011c958006f5ea87a4359b30b7278f0c88`. The merge retains
  strict skill parsing, dependency ceiling intersection, visible unsupported
  admission, immutable context in the existing command ledger and original FIFO
  command authority. No replacement queue or permission registry was introduced.

The joined managed-handler seam captures the original SDK callback state's
`checkTool(actualWireName)`. It checks the named handler before dispatch and
through existing asynchronous and synchronous effect fences, including the
TaskExecution, session-launch and peer-message special paths. Per-name cached
tool owners preserve that exact fence. Peer-message runtime and approval
assertions recheck it before effects instead of relying on a check after return.
Existing profile, account, runtime, permission, task, cancellation and skill
checks still apply.

New real-MCP regressions first reproduced TaskExecution store reads outside the
frozen ceiling and after retirement during an authority wait. A further red
case reproduced a peer handler effect after retirement inside its awaited
dispatch. The joined guards make those cases pass. The peer seam fixture
substitutes its effect; it does not claim live peer delivery qualification.

## Combined local verification

These four disjoint test groups ran with one worker and a 1 GiB heap:

| Group                                                                                                                           | Result                                                    | Retained local log                         |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| TaskExecution native fences, actual application startup/continuation, original SDK command boundary                             | 21 passed across 3 suites                                 | `.verification/managed-peer-green-2.log`   |
| Composer, FIFO owner, SDK query/turn, shared skill policy, owned runtime, registry, bundled skills, refusal, startup and launch | 195 passed; one startup case blocked by socket permission | `.verification/combined-skills.log`        |
| Managed credentials, ordinary connections/effects, notification lifecycle, query loop and launch selection                      | 154 passed across 6 suites                                | `.verification/combined-shared-owners.log` |
| Controls and helper-support composition through pure Access projection                                                          | 14 passed; HTTP listener case deliberately excluded       | `.verification/combined-controls.log`      |

Total: 384 passing tests. The startup failure is `listen EPERM` at
`chat-account-startup.test.ts:972` in “serializes paused ordinary resume and draft
conversion in both orderings.” It also produces an unhandled listener error;
neither is accepted as green. The current task grant has `network: none` and was
not widened. Existing Access HTTP tests also require an authorized listener or
coordinated CI. No unchanged listener denial was retried.

Protocol, harness and client TypeScript builds pass. Scoped lint, formatting,
whitespace and intentional source-artifact checks accompany the merge. Runtime
source revision: `v1.0.1135-claude-parity-composition`.

An initial invocation of the new seam group used an incorrectly short executor
timeout and was killed before any completed test result. Its uncertain receipt was inspected;
the successful run above used a new request after correcting the timeout. The
timeout and an unavailable process-list command are not test evidence.

## Publication and remaining acceptance

The coordinated final-validation slot selected accepted main
`778c55bccd17c234c4380db9545962afcc5f651c` (PR #1341). It was integrated once.
The catalog conflict preserves both upstream `SymposiumConsult` routes and this
candidate's qualified Claude `TaskExecution` route. Shared helper registration
contains both names; source fingerprints retain both changes. The accepted SDK
startup diagnostic is preserved. No consultation policy or delivery owner was
replaced.

After this integration, 82 checks passed across the catalog, native TaskExecution
fences, credential helpers, ordinary SDK effects, specialist owner, actual
application startup/continuation and original command boundary suites. This
overlaps the earlier 384 and is not an additional unique-test count. The two
larger specialist application suites could not start their loopback transport:
five cases reported `listen EPERM 127.0.0.1`, and a dependent restart case reported
an uninitialized fixture. Those six cases remain pending hosted evidence; they
are not code-failure or green claims. Logs are
`.verification/final-accepted-delta.log` and
`.verification/final-specialist-consumers.log`.

Protocol/harness/client compilation and conflict-resolution lint, format,
whitespace and source preflight pass. This accepted-source integration used
`v1.0.1136-claude-parity-specialist-composition` before the review fix below.

Independent targeted review reproduced an original-query retirement race in the
profile consumer at `e072791c`: after its final runtime await, the continuation
could dispatch a custodian profile read or proposal before detecting retirement.
Publication was paused. Both cases were reproduced locally through real SDK MCP
and the original callback state with a synthetic custodian. The consumer now
calls its existing synchronous `verifyAuthorization()` immediately before the
request, rechecking original command, operator and captured authorization after
the last await. No consent fence was removed. Four permanent cases preserve
allowed reads/proposals and refuse both retired paths before any request.
All 43 focused profile, managed-handler and TaskExecution checks pass; retained
logs are `.verification/profile-retirement-red-2.log` and
`.verification/profile-retirement-green.log`. Targeted re-review is required
before publication. Final source revision is
`v1.0.1137-claude-original-profile-fence`.

PR #1342 custody was released by its original owner in receipt
`6a45b05f-cf1c-416f-8df0-6cef65230d9b`, with its branch still at `6dc2ba33` and
no operation in flight. This candidate preserves that ancestor so publication
can use a non-force fast-forward after fresh remote inspection. Custody transfers
neither a task grant nor publication, merge or deployment authority.

No remote write, new PR, hosted CI, live model/device call, merge to main or
deployment was performed for this assembly. The coordinator must sequence the
single publication and final validation. Current-head hosted CI, broad server
typechecking, browser checks and trusted Centaur review remain pending.

Restricted prompt admission remains refused, including empty ceilings. Trusted
startup admission must atomically retain the resolved ceiling, and the joined
initial/FIFO/cold-recovery and remaining managed routes need qualification before
enablement. Native Codex restricted execution remains unsupported. Hook support,
`srt-mux` diagnosis, native branching/rewind and provider/live acceptance remain
unfinished. Task grants do not authorize native tools or broader actions.

Routine Telos mutations remain deferred. This is retained repository evidence,
not a saved Telos status, formal reassignment or acceptance receipt.

## First published CI diagnosis and local repair

PR #1342 was subsequently fast-forwarded once to `84f14925`, after independent
targeted re-review cleared the original retirement probe. The initial bounded
check did not yet show CI; run `43510395151` later completed with failure on that
exact head. No green CI claim was made. Logs from preflight job `132178813289`
and frontend job `132178913591` identify four owned causes:

- The frozen command wrapper callback parameter needed an explicit `string` type.
- The task fixture collected general transport records in a narrower event array.
  It now retains the actual record type and validates the permission ID before use.
- The peer fixture returned a tool envelope instead of the peer owner's actual
  `{ chats, nextOffset }` result. It now uses that result contract.
- The peer input fixture used `peer-input` where the SDK requires a UUID. The
  same valid UUID now identifies dispatch, recognition and assertion.

The production annotation also caused frontend compilation to fail. The joined
coverage job `132180381973` reports skipped prerequisite shards after preflight
failed; it does not establish a separate runtime failure. The missing iOS archive
is downstream of the frontend compile failure.

All 48 focused command, task, profile-retirement and SDK-query tests pass after
the repair. A focused TypeScript program checks the three real changed source
files semantically using the existing strict project options and references,
within the 1 GiB heap; it passes. Full-project checking remains a CI gate. Retained
logs are `.verification/ci-43510395151-preflight.log`,
`.verification/ci-43510395151-frontend.log`,
`.verification/ci-43510395151-joined.log`, `.verification/ci-type-fix-tests.log`
and `.verification/ci-type-fix-semantic.log`. The local focused checker is
`.verification/typecheck-owned-delta.mjs`.

Source revision is `v1.0.1138-claude-parity-typecheck`. The fixes are batched
locally for one coordinated follow-up validation decision; no rerun, new push,
main refresh, guard weakening, workflow change, merge or deployment is included
in this diagnosis.

## Follow-up published cycle and batched local fixes

The coordinated non-force follow-up published `183951ef` to the same PR branch.
Current-head CI is run `43512171045`; compile/source preflight, frontend assets,
core checks, all three joined acceptance shards and both prepared-consumer
groups pass. The deployed trusted review service accepted job `7346` with its
existing authentication and model configuration; a current-head final review
has not yet been observed. No duplicate dispatch or forced review was requested.

Three completed unit shards expose confirmed owned defects:

- Job `132186618137`: one existing permission-handler abort test expects the
  established `Aborted` denial, but the strengthened shared revalidation returned
  a misleading permissions-changed/retry response. The early guard now returns
  `Aborted` for an aborted signal, retaining all remaining original owner,
  native scope and skill checks. All 133 focused permission, skill, task and
  profile-retirement tests pass; protocol/harness/client compilation passes.
- Job `132186618253`: six legacy slash-receipt cases extract the real Send
  callback into a VM context. That context omitted the new
  `executableSkillResolution` dependency. The fixture now injects the actual
  imported helper without weakening its refusal assertions. All 37 slash-receipt
  and restricted-skill checks pass. This group overlaps the previous one.
- Job `132186618129`: one older session-tool catalog assertion expected every
  automation tool to exclude Claude SDK. It now explicitly expects qualified
  TaskExecution on that route and retains the three-route assertions for
  unqualified timers and queued messaging. All 56 focused catalog, session-prompt
  and TaskExecution checks pass; counts overlap the other groups.

Logs are `.verification/ci-43512171045-unit2.log`,
`.verification/ci-43512171045-unit1.log`, `.verification/abort-message-fix.log`
and `.verification/slash-receipt-fixture-fix.log`. The original run continues
to preserve remaining evidence; no new publication or rerun is included in
this local repair. Source revision is `v1.0.1139-claude-abort-contract`.

The third shard log is `.verification/ci-43512171045-unit3.log`; its focused
verification is `.verification/catalog-expectation-fix.log`. All eight failed
unit assertions across these three completed shards have a confirmed cause and
a passing focused check. Remaining hosted evidence is preserved, and final
current-head CI and trusted review are still required before acceptance.
