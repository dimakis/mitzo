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

| Contribution | Acknowledged source and custody | Composition |
| --- | --- | --- |
| Device ownership #1357 | Owner `66931ded-9484-828c-b0ad-05805d2deae4`; source head `7fbee608b1a45e9a9015fddb6eb62eee7d57e438`, base `19aa8a19b274ae1fee416f0f187c772111251366` | Ordered `b951da37f62df0d2f304b86d1abf7f7882e0c150`, `49ebd9fb35442914c9845a629e6cde521d7ce772`, `7fbee608b1a45e9a9015fddb6eb62eee7d57e438`; handoff `64871a5e-4472-4fe0-9a9b-bc6eefe954d9`; final boundary `a6da0b0e-94cb-424b-b697-fa29c6bc28a3` transfers the three unfinished fixes to this integration writer. Source owner reviews composed fences. |
| Input diagnostics #1358 | Verified implementation owner `8cd5f77c-f34b-82f9-a39e-6ac76a0cb183`; head `68acf6760d71619b9dd2b336495a06837de2e28c`, single-commit parent `0ad803cdae56ed6e22c89273ae800d3e7aeb9706` | Handoff `0497a1d8-1f63-486d-ad80-8e3d7224f505` transfers both unfinished review fixes. Source owner retains original branch and reviews the composition. Private incident/research history is excluded. |
| Context/runtime reporting | Existing owner `4acd5b81-1ff1-8b53-8900-37c15d071038` | ACK `7e9c34b6-78c6-4dab-98e3-683b8022cbe9`: no implementation commit/PR at handoff; test artifacts unrun. Owner continues implementation in the original checkout; no separate PR, copied dependencies or inherited grants. |
| Independent coverage audit | Existing auditor `eed63efb-da6e-8843-8796-e75eba8c7269` | Handoff `2823b243-3e5b-41ea-93f4-b6343bfa1f30`, audit commit `96e3c6cb6`, correction `8e0612420`; original 63-entry/eight-category ledger and S01–S14 dispositions retained. Its 287-test pass covers `416faccb`, not this candidate. |

## Open blocking findings inherited from source PRs

These are unfinished work, not approved fixes or passing composed outcomes.

| Finding | Required outcome and evidence |
| --- | --- |
| #1357 `CEN-3C9DE1FD89FE`, review `5906086158` | Live Claude continuation status must accept a verified second operator login so actual metadata and `useExplicitLocalChat` enable ordinary Send. Preserve account/runtime/workspace custody and unknown/revoked/foreign negatives. |
| #1357 `CEN-6EA0ADBA0AF5` | Targeted `stopOrdinary` must accept canonical operator ownership while preserving original command, interrupt receipt, target/generation, current-owner and post-await authorization fences. |
| #1357 hosted TS2322 | CI `43596068439`, job `132450706735`, legacy permission fixture passes unsupported `sessionId`; `permId` already locates the owner. Preserve denial assertions. |
| #1358 `CEN-0A6284EDF91F`, review `5905457673` | Generic SDK AbortError after input refusal must retain the SessionRuntimeError in the terminal callback and failed chat-start trace. Cover both throwing and normally closing iterators; user Stop stays distinct. |
| #1358 `CEN-65374BDD3AB5` | Keep original causes in memory while sanitizing the actual serialized startup logger. Inject private text/paths and verify serialized output, not only logger spies. |

#1358's original CI checks were successful at the owner handoff, but its trusted
final review recommends FIX. #1357's 429 local checks and #1358's 191 local checks
are attributed source results and do not establish success on the combined tree.

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

At this checkpoint the attributed source integration and regenerated source pins
are present. The source-artifact checker and `git diff --check` pass. No combined
Vitest, TypeScript, build, browser, device or live-provider success is claimed.

TaskExecution grant `b953a931-2c3e-4cc2-ae73-d312fbf4ff27` covers this chat's
admitted integration root only. Registry probe request
`aa6e5112-0dab-43c0-8c5b-040f04e35e14` returns `ENOTFOUND`; dependency setup
has not run. The reporting owner's new scoped grant also reproduces DNS failure.
A native CLI route versus executor repair decision was requested; neither route
nor another session's grant is inferred from peer messages. Existing test artifacts
must run red before implementing their fixes, then green on the composed tree.

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
