# Remaining Claude parity integration

This is one integration candidate for delivery immediately after #1342. Preparation
and review run concurrently with that PR; its owner remains its only writer and
landing executor. This candidate does not establish full parity or authorize
merge, deployment, staging, live models, device testing or a new worker session.

## Integration custody and source attribution

Integration writer: ordinary conversation `f0325706-afeb-8067-baca-1aece1c090b9`.
Queue coordinator: `9d3d439f-8e94-87c6-b00d-16f030dbdba3`, which acknowledged
#1342 first and this consolidated PR immediately next. The integration writer is
also the nominated eventual merge executor, contingent on explicit combined-PR
merge authority and fresh gates. No second executor is assigned. Formal Telos
feature lead `16f8de38-05ab-8734-ab84-a544ab9559ed`, anchor
`8e186fdf-9058-4ad6-af18-8fd6797bf935` and child assignments remain unchanged;
repository slice `44ef3681c6c8d7b7` remains active.

The candidate began at fresh accepted main
`27345bb50c698646f5a7c2128ab6573b488f624c` (#1353), tree
`a64b3b2a631dc90a5c272a1237c689b8d039e749`. Original author identity and source
commit IDs are retained through attributed cherry-picks. Source branches, PRs and
dirty work are preserved. Neither original PR is independently landing or closed.

| Contribution               | Acknowledged source and custody                                                                                                                                                        | Composition                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device ownership #1357     | Owner `66931ded-9484-828c-b0ad-05805d2deae4`; source head `7fbee608b1a45e9a9015fddb6eb62eee7d57e438`, base `19aa8a19b274ae1fee416f0f187c772111251366`                                  | Ordered `b951da37f62df0d2f304b86d1abf7f7882e0c150`, `49ebd9fb35442914c9845a629e6cde521d7ce772`, `7fbee608b1a45e9a9015fddb6eb62eee7d57e438`; handoff `64871a5e-4472-4fe0-9a9b-bc6eefe954d9`; final boundary `a6da0b0e-94cb-424b-b697-fa29c6bc28a3` transfers the three unfinished fixes to this integration writer. Source owner reviews composed fences. |
| Input diagnostics #1358    | Verified implementation owner `8cd5f77c-f34b-82f9-a39e-6ac76a0cb183`; head `68acf6760d71619b9dd2b336495a06837de2e28c`, single-commit parent `0ad803cdae56ed6e22c89273ae800d3e7aeb9706` | Handoff `0497a1d8-1f63-486d-ad80-8e3d7224f505` transfers both unfinished review fixes. Source owner retains original branch and reviews the composition. Private incident/research history is excluded.                                                                                                                                                  |
| Context/runtime reporting  | Existing owner `4acd5b81-1ff1-8b53-8900-37c15d071038`                                                                                                                                  | ACK `7e9c34b6-78c6-4dab-98e3-683b8022cbe9`: no implementation commit/PR at handoff; test artifacts unrun. Owner continues implementation in the original checkout; no separate PR, copied dependencies or inherited grants.                                                                                                                              |
| Independent coverage audit | Existing auditor `eed63efb-da6e-8843-8796-e75eba8c7269`                                                                                                                                | Handoff `2823b243-3e5b-41ea-93f4-b6343bfa1f30`, audit commit `96e3c6cb6`, correction `8e0612420`; original 63-entry/eight-category ledger and S01–S14 dispositions retained. Its 287-test pass covers `416faccb`, not this candidate.                                                                                                                    |

## Original blocking findings inherited from source PRs

This is the retained baseline finding ledger. Tested source corrections are
recorded below; composed-head verification and trusted finding closure remain
required.

Pre-fix Centaur review `5906594789` on
`f508455aa88177caaceb5cd6e2de0b9febd279c3` recommends FIX and retains the four
runtime defects below as `CEN-B9E7697D8CD1` (Send), `CEN-9A0551011967` (Stop),
`CEN-46BDAAE2FF3D` (refusal AbortError) and `CEN-B873B59061F9` (serialized privacy).
Keep these IDs alongside the original source finding ledger during follow-up.

| Finding                                       | Required outcome and evidence                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1357 `CEN-3C9DE1FD89FE`, review `5906086158` | Live Claude continuation status must accept a verified second operator login so actual metadata and `useExplicitLocalChat` enable ordinary Send. Preserve account/runtime/workspace custody and unknown/revoked/foreign negatives.                                                                       |
| #1357 `CEN-6EA0ADBA0AF5`                      | Targeted `stopOrdinary` must accept canonical operator ownership while preserving original command, interrupt receipt, target/generation, current-owner and post-await authorization fences.                                                                                                             |
| #1357 hosted TS2322                           | CI `43596068439`, job `132450706735`, legacy permission fixture passed unsupported `sessionId`; removed in integration commit `d5499ae43`, preserving every denial assertion and existing `permId` ownership lookup. Hosted compile/source preflight `132548935217` passes on combined head `f508455aa`. |
| #1358 `CEN-0A6284EDF91F`, review `5905457673` | Generic SDK AbortError after input refusal must retain the SessionRuntimeError in the terminal callback and failed chat-start trace. Cover both throwing and normally closing iterators; user Stop stays distinct.                                                                                       |
| #1358 `CEN-65374BDD3AB5`                      | Keep original causes in memory while sanitizing the actual serialized startup logger. Inject private text/paths and verify serialized output, not only logger spies.                                                                                                                                     |

#1358's original CI checks were successful at the owner handoff, but its trusted
final review recommends FIX. #1357's 429 local checks and #1358's 191 local checks
are attributed source results and do not establish success on the combined tree.

Source owner `8cd5f77c` reviewed exact integration commit
`85e83b7a4ba8884b2d70d7d8c36162020ac2c224` read-only, receipt
`f7a98e91-2006-4f9b-bced-0791d95efd94`. It found no new blocking composition
regression in the diagnostics/conflict scope: 15/17 files have identical edits to
the source; the owned-runtime conflict retains the accepted Retry source guard,
historical-source predicates and post-await revalidation within diagnostic
annotation. No tests were executed, and both original diagnostics findings remain
open. This scoped source assessment is not final LGTM, independent full permission
review or approval of later changes.

Device owner review `c82e58fb-7529-414d-b97a-b43bf0508203` independently compared
exact head `8901dd0b8313e423eb06d0112734d46a490ba3e3` with accepted `27345bb5`:
all three attributed patches and the four device/control test files are retained,
no new scoped ownership composition regression was found, and all 2458 registered
artifact hashes match. No composed runtime tests or final approval were claimed.

## Tested owner corrections incorporated

The two source owners explicitly took back their respective two runtime fixes
under their own qualified execution routes, then returned tested local commits.
The integration writer made no duplicate implementation. Sources were fetched
read-only, and original source branches/remote PR heads remain preserved. Only
this consolidated PR publishes the new corrections.

- Diagnostics handback `d2f2f221-c4e0-4d2d-84e0-19f0283f4f16`, final handoff
  `55682788-f22a-481a-8c97-12894bd1b23b`: original commits
  `9f35b3d70b494a2cfe0a322737c1ec44d81136fc` and
  `76fb20c6aece70bb96b96af7f9e78cb8c12b67b8`, source tree
  `f5d185cc48e3c482f653ca965bbd2694d4a28283`. Attributed integration commits are
  `586e4b0d150405576c230505a5f972bd9cd65feb` and
  `0b0eddd1ed2a7b214a952a34b553bc75d6ea274b`. Retained refusal reaches the terminal
  callback after generic SDK AbortError while an already classified runtime
  failure remains intact. Startup logging emits allowlisted diagnostics and
  correlation without serializing the original cause; the cause stays in memory.
- Device handback `03a8cd74-ad23-4ff9-b528-3a44e797c0ac`, final handoff
  `bd2174be-b8ed-4403-8fe8-32041e6c0d9e`: original commit
  `c68bfd24a8f7a0aacf5a68c546c179ea75e84fca`, source tree
  `1d79cfaebf7995e42344807edb227e8b2613495e`; attributed integration commit
  `063015318b909e8d509c8b8130e656476ecea1e1`. Canonical operator ownership now
  qualifies live Claude continuation metadata and targeted Stop. Original command,
  interrupt receipt, binding, current owner/target and post-await fences remain.
  The previously corrected legacy permission fixture is retained.

Diagnostics source validation verifies 210 distinct checks across seven files:
202 diagnostics/integration checks passed; the expanded run had 209 passes and one
logger test failure because `LOG_LEVEL=error` suppressed its expected info record.
Rerunning only the logger suite with `LOG_LEVEL=info` passed all eight checks.
This environment correction is retained rather than relabelling the expanded run
as wholly green. Meaningful RED/GREEN covers generic AbortError plus personal and
Vertex mode/workspace refusals, normal closure/Stop controls, and both routes'
actual Pino serialization of injected private causes.

Device source validation passes 93 checks across eight suites after meaningful
RED failures for all four account fixtures' disabled composer and second-login
targeted Stop. The actual HTTP metadata feeds `useExplicitLocalChat`, continuation
construction and public admission; the production prompt port exercises SDK queue
Stop, original-receipt retry, changed owner/binding/command and post-await loss.
Both source owners report scoped lint/format, source pins, diff and secret checks
passing. These are separate source-tree results, not a combined test count or
approval of the integration tree. Runtime source conflicts were confined to pins;
the bundle retains its own revision and regenerates all registered hashes.

Reporting S01 test capacity was explicitly declined by the diagnostics owner
(`6f588d9d-0258-4821-9264-30ef70702b72`); no reporting RED/GREEN or implementation
is inferred from these corrections. Its original owner and execution-route
prerequisite remain unchanged.

## Remaining reporting outcomes

- S01: same-session `session_writes_lost` after terminal result must reach existing
  nonfatal retained diagnostics without admitting late input/output/results or
  lending authority to a successor. Keep callback/account/owner/provenance fences.
  `mirror_error` applies only with configured SDK sessionStore. Native transcript
  durability and Mitzo EventStore durability are different outcomes.
- S02: preserve retry/quota/refusal evidence, reset/retry timing, selected versus
  observed model and retracted UUIDs through existing consumers. Unknown stays
  unknown. Do not enable fallback or change selected account/model.
- S06: feature-detect SDK context summary through the bound SDK and existing
  TokenBar; distinguish estimates/prior usage from measured context. The granular
  inspector was planned, not implemented, and is not a new programme here.
- S09: qualify existing child/background progress with run ordering, parent
  identity, replacement, ambient exclusion and stale/terminal fences. Do not enable
  backgrounding or paid summaries.
- S05 experimental personal utilization is optional and may explicitly defer.
  Vertex/API plan entitlement is unavailable; token/cost totals are not quotas.

S03/S04 and S07/S08/S10–S14 retain the audit's documented optional/deferred
dispositions. Pending-decision recovery still needs honest restart qualification.
Do not promote optional SDK capabilities into a second implementation programme.

## Dependencies and preserved accepted contracts

#1342 latest observed source is `2499da8b1b0f2a8c2cbe29715074c093f0b10af4`;
it is not accepted at this checkpoint. Incorporate its actual accepted SHA before
final combined gates. It owns canonical TaskExecution grant reuse, completion
notifications, immutable original-command skill/dependency ceilings, authorization
replay and the restored existing Vertex repository callback. Do not fix or push
its branch, independently land #1343, or duplicate its repository implementation.

The repository acceptance target is MGMT → discover/inspect configured target →
safe isolated secondary checkout → same-chat continuation → actual edit/test/commit
under genuine authority, preserving dirty work. Supplied-checkout Bash is not
equivalent evidence. Configured-secondary worktree evidence does not prove modern
primary-cwd adoption, arbitrary unconfigured repository adoption or the original
input-authority incident's root cause.

Preserve accepted #1348 lifecycle, #1349 information, #1350 profile selection and
bounded Retry/FIFO, #1351 approval guards, #1352 canonical Telos and #1353 service
and CI-trigger contracts. Regenerate source fingerprints from the composed tree;
do not copy stale pins or restore the removed full-suite main-push trigger.

There is a concrete separate #1345 parity dependency: correlated peer replies
across operator logins. Owner `1428dc32-6bd9-8974-949a-a60fd1eced22` confirms
source `59f0bf5e1202442e4c660ab5b8aee7deb23153a8` on candidate
`0d65a690799ba18d7d8843c2e3672bb40e79d738`. Its host-only same-operator resolver
preserves reversed participants, original grants, provenance, cancellation and
revocation. Handoff `7099fda5-5d36-4dc4-9732-a6ca0653da16` explicitly retains
delivery in #1345 and disallows extraction. This candidate does not absorb it;
full cross-login peer-reply parity remains pending that separate accepted result.
Other Symposium/Telos PRs #1354–#1356/#1359–#1361 are excluded.

## Verification and delivery status

The attributed source integration and regenerated source pins are present. The
local source-artifact checker and `git diff --check` pass. No local Vitest or
dependency installation is claimed.

Hosted CI `43628267406` completed on exact `f508455aa`: compilation/source
preflight, shared frontend build, all four unit shards, design checks, browser
interaction and layouts, Swift/native, composed repository, Telos and Connections
jobs pass. The permission fixture typing correction is therefore compiled on the
combined tree. Core checks fail ONLY at Format check for this evidence document
(job `132549862852`); its dependent `unit-validation` and `ci` aggregators are red.
Lint, audit, secret scan and the other Core steps pass. This formatting correction
needs its normal fresh CI result and does not resolve Centaur's four runtime
findings. Prior successful jobs do not approve the next head.

TaskExecution grant `b953a931-2c3e-4cc2-ae73-d312fbf4ff27` covers this chat's
admitted integration root only. Registry probe request
`aa6e5112-0dab-43c0-8c5b-040f04e35e14` returns `ENOTFOUND`; dependency setup
has not run. The reporting owner's new scoped grant also reproduces DNS failure.
A native CLI route versus executor repair decision was requested; neither route
nor another session's grant is inferred from peer messages. Existing test artifacts
must run red before implementing their fixes, then green on the composed tree.

TaskExecution selected-file commit request
`aa6e5112-0dab-43c0-8c5b-040f04e35e30` incorrectly sought `.git` at the admitted
parent rather than the nested clone and returned uncertain/ENOENT. Inspection
proved the clone's HEAD unchanged, index empty and document still untracked. The
document was then committed with authorized native Git in the exact clone. No
effect was blindly retried, and no source checkout was modified by that recovery.

Final readiness requires accepted #1342 composition, focused tests under one
worker/1 GiB, normal combined-result PR CI, independent permission review, source
owner reviews and trusted Centaur final LGTM/merge/zero blockers for the exact head.
Every push invalidates prior-head approval. Preserve baseline/finding ledger and
request a final original-job FOLLOW-UP at the cap rather than duplicating reviews.
Actual next landing turn is coordinated in the originating chat. Merge authority
for this combined PR remains an explicit outstanding decision.

Physical desktop/iOS, real account login/refresh, full process restart, actual
installed/account-specific inventory and live/provider qualification remain
unverified. Instrumentation enables future diagnosis; it is not retrospective
proof of the original first-input or device incident. Source acceptance, production
adoption, live/device qualification and user acceptance are recorded separately.
