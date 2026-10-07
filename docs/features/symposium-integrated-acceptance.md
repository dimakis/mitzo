# Symposium integrated acceptance checklist

Scope is frozen to PR #678 reconciled with current main. This checklist names
exit gates; the append-only canonical `ACCEPTANCE_LEDGER.md` remains the source
of evidence and retained operation history. Update that ledger with exact
candidate/operation/artifact IDs and bounded outcomes before marking a gate done.

## Candidate baseline

- Integrated baseline: `b34b34dcf4558a9634e09def7f6ed9d67dc99a74`, incorporating
  main `b9028e6cf9086e2c914b13d6022ad5459f7d9bf5`. At the retained 30 September
  checkpoint PR #678 was draft/open, 207 commits ahead and zero behind main.
- Baseline CI run `36775554909` attempt 2 passed all four jobs. Retained suite
  evidence records 7,522 passed / 17 skipped. Exact-head Centaur review
  `5371758787` is LGTM with zero blockers and three verified resolutions
  (consent ownership, WebSocket consent and legacy live takeover/replay).
- These are retained baseline receipts, not fresh verification of subsequent
  edits. Reverify remote head, all-job CI and exact-head independent review
  before acting; any source change requires new candidate gates.
- Record the candidate commit/tree, dependency/build evidence and measured
  runtime/image/helper/bootstrap pins before acceptance. Freeze unrelated
  provider/runtime upgrades while qualifying this candidate.

## Evidence boundary

Stage 27 sign-in `7427922a-2cc5-4e31-a084-72d4a72d9648` completed for
`dimitri.saridakis@gmail.com` Personal Pro. Its single catalog operation
`d5582ec4-6a16-4985-b7b2-06556fa890cf` confirmed failed at native account/read
with `routing_failed`; it remains unreplayed. This category does not identify
an upstream HTTP status or a proven cause. Fresh supported Luna 6 availability
and the complete workflow are unverified.

Earlier live Luna evidence and mocked/unit suites demonstrate their recorded
slices, not this integrated candidate. No inference occurred in the recent
offline diagnostics. DIAG6 `6d84d037-470d-4402-8d7a-be0e2cb2203c` and DIAG7
`55fca0b1-25c4-4df7-b265-6a27741e1113` are retired with cleanup confirmed.
DIAG7 reached supervisor/provider readiness after correcting its missing private
socket setting, then retained four gateway-method-contract-refused events
without method/predicate details. Native account RPC was intentionally
suppressed; no upstream request or inference occurred. Readiness does not prove
account/read composition or explain the Stage 27 failure. A distinct diagnostic
`4fdf7711-0c95-4126-92a8-34ce78cec542` reproduced four refusals and retained
`ReportProviderReadiness` / `readiness-tuple` labels; those labels cannot be
retroactively attributed to the original DIAG7 events. Subsequent source-compatible
fixture corrections accept supported telemetry reports. Telemetry remains enabled:
routing diagnostic `ad5264ca-ccbf-4706-821d-4dfe1582a472` accepted two log batches
containing 16 entries, with no log-report refusals. It remains uncertain and proves
no positive account/catalog routing. Consult the current ledger for each distinct
successor and its evidence; never replay retired or uncertain operations.
Stage 20 review `bb95f6d0-cc49-4434-bb11-ce251fc23163` and all other retained
attempts must be reconciled by original ID, never blindly replayed.

## Exit gates

Source integration and baseline CI/review are established for `b34b34dc`.
The workflow, routing, recovery, resource, device and release gates remain open;
consult the latest ledger entries for candidate-bound evidence. Each next check must target the reviewed candidate
and produce durable, physically verified evidence rather than a configuration
assertion or an optimistic HTTP response.

- [ ] **Integrated source and admission.** Complete fresh CI and exact-head
      independent review; verify an independently prepared build, component pins,
      owned-host custody, provider bindings, policy and artifact seed. Recheck the
      retained inventory of 22 NULL-owner and 33 unsettled commands; the old counts
      are not a current inventory or evidence of resolution.
- [ ] **Personal catalog prerequisite.** Diagnose the named account/read blocker
      using one separately owned, bounded operation with authorization and current
      revision/custody fences. Preserve the original failed catalog ID. Require a
      fresh authenticated Personal Pro connection and supported `gpt-6-luna` low
      catalog before any inference; saved availability is insufficient.
- [ ] **Complete application workflow.** Run source → initial artifact →
      independent review → fix → delta review → meaningful acceptance criteria →
      immutable record → publication preparation on one exact candidate. Prove
      dispatch, native terminal completion, attribution and physical artifact
      revision at every transition. The full sequence has not been achieved.
      Check file SHA/identity separately from semantic software tests: matching
      bytes do not establish correctness. Publication completion requires the
      separate artifact-bound approval below.
- [ ] **Recovery and cleanup.** Demonstrate crash, cancellation and restart
      reconciliation using the same retained operation IDs, including uncertain
      creation/delivery and physical sandbox, credential, artifact lease and
      writer-release proof. No duplicate dispatch or cleanup-based invented success.
- [ ] **Application limits and resources.** Persist selected host-turn and
      review/fix-cycle limits, deadline, user stop, no-progress termination and
      explicitly authorized continuation. Prove their admission, restart and
      cancellation behavior through the actual owners. Record the selected
      settings before dispatch; proposed first-run settings are 12 host turns,
      at most two review/fix cycles and 15 minutes, not permanent defaults or a
      spend guarantee. Separately prove and measure CPU/memory/storage bounds.
      Guaranteed native no-overshoot token/spend caps and mandatory final token
      totals are deferred, not initial-release gates. Trusted execution and
      artifact completion may succeed with usage recorded as unknown.
- [ ] **iOS device path.** Exercise sign-in, connection/model selection,
      reviewer/context setup, workflow progress and recovery on an actual iOS
      device against the integrated candidate; desktop/mock coverage is insufficient.
- [ ] **Migration and rollback readiness.** Review production inventory,
      ownership reconciliation, migration plan and verifiable rollback criteria.
      Production migration, rollback execution, merge and cutover remain CLOSED;
      this checklist grants none of those actions.
- [ ] **Record and approved publication.** Bind the immutable review record,
      semantic results and delta history to the exact accepted artifact. Obtain
      explicit artifact-bound approval before external publication; preflight is
      not publication authorization. Record the approved action and its receipt.

## Application-policy contract

The explicit 27 September decision, “use application limits; defer the hard
token cap,” governs this release.
A host turn is one selected-seat native dispatch. Initial, review, fix, delta
and retry dispatches share an atomic persisted reservation in the existing
workflow; concurrency and restart cannot reset it. An unknown accepted operation
stays charged and is reconciled by original ID before any retry. Exhaustion,
deadline, user stop and no progress fence new work and request exact cancellation;
they do not guarantee instant cessation of an accepted model call. Continuation
requires a fresh authorized limit amendment retaining counters and history.
Host-turn reservations must never be labelled native token/spend `enforced`.
Exact account/model, grants, membership, artifact binding and final dispatch
authority remain required. Uncertain execution, artifact identity or authority
remain blockers even when usage may stay unknown.

## Existing owners, transitions and dependencies

Reuse these owners; do not introduce another scheduler. Cross-store transitions
require durable intent, exact idempotent effects/receipts, fencing and same-ID
reconciliation rather than an assumption of atomic commits.

| Transition                        | Existing owner and boundary                                                                                                                                                                                                                                                                                          | Package / dependency                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Admission and dispatch            | `SymposiumReviewStore` (`symposium-review-workflows.ts`) persists policy/counters/attempts; `SymposiumReviewCoordinator`, `createSymposiumApplicationDispatchPolicy` and `selectSymposiumApplicationClaim` reserve and authorize through `app.ts`. Native controller/EventStore retain claims and dispatch receipts. | 1; prerequisite for 2/3                                                                                         |
| Account/read and model discovery  | `symposium-model-discovery-host.ts`, `symposium-model-discovery.ts`, `symposium-owned-host.ts` and `symposium-owned-gateway.ts` compose actual supervisor/gateway credential binding. Retain failing phase/cause before cleanup.                                                                                     | 2; synthetic fixture qualification before provider access                                                       |
| Source import, writer and seal    | `symposium-source-import.ts`, artifact initializer/owner/generations, source/physical seals and successor authority/copy/import retain exact provenance and writer ownership. Staging alone is not runnable admission.                                                                                               | 3; policy plus physical reservation/admission/claim boundaries                                                  |
| Independent review, fix and delta | `createSymposiumTrustedReviewHost`, review routes/coordinator/store and `symposium-owned-review-artifacts.ts` bind reader authority, findings, successor grants/permits and fresh runtime retirement.                                                                                                                | 3; reproduce Stage 18 staging/claim, Stage 19 missing permit and Stage 20 sealed/shutting-down runtime failures |
| Criteria and immutable record     | `createOwnedCriterionReceipts` (`symposium-criterion-receipts.ts`) and `symposium-review-records.ts` bind results to artifacts. Existing file-SHA criteria require trusted semantic definitions for software correctness.                                                                                            | 5; prerequisite for complete criteria in 4                                                                      |
| Publication preparation           | Review publication, sealed publication service/authority and publication approval owners bind exact artifact/record/action and reconcile original IDs. Preparation does not approve an external effect.                                                                                                              | 3/4; external publication remains separately gated                                                              |
| Recovery, seats and release       | Retained custodian/native controller/gateway/artifact owners provide custody and fencing; existing profiles, seat lifecycle and device paths provide restoration/configuration.                                                                                                                                      | 5/6; gateway/custodian loss or reboot and actual iOS remain acceptance gaps                                     |

Package 3 must pass the entire production application composition with a fake
model transport and physical artifacts before package 4 live inference. Preserve
reservation, admission, claim, permit, runtime retirement and artifact boundaries;
inject lost responses, duplicates, cancellation and failures between owners.
Package 5 recovery design and package 6 device planning may proceed independently;
semantic criteria must pass before claiming the full live criteria step.

## Evidence levels and remaining proof

Record each level separately in the existing ledger: implemented, offline-tested,
physically tested, live-model-tested, reviewed, merged and deployed. Code and
helper tests establish their slices; neither green CI nor LGTM establishes the
complete workflow, physical recovery, device matrix, merge or deployment.
`server/__tests__/symposium-application-policy.test.ts` already covers persisted
charging/restart, stopped preparations, exact-operation binding, deadline,
no-progress, retry, two-cycle limits, explicit continuation and completion with
unknown usage. This is offline coverage, not a claim that the production composed
lifecycle or physical cancellation/resource/reboot behavior has passed. Package 3
must close composition; packages 5/6 must close the remaining physical and device
proof. Phases 1/2 retain their original completed scope; Phase 3
`3675378835096b46` is a superseded historical redirect, not feature completion.
All unfinished work belongs to current parent `6403fb22f9bb743c`.

## Execution discipline

Freeze feature expansion. Each diagnostic must name an exit-gate blocker,
retain the operation-owned cause before cleanup and stop on uncertainty.
Reconcile retained IDs and cleanup evidence before any distinct successor.

For every real model-backed test, explicitly select fresh supported
`gpt-6-luna` with reasoning effort `low`, with participating seats persisted as
`gpt-6-luna` / `personal-chatgpt` / `low`. Before the call, announce the exact
model and charged `dimitri.saridakis@gmail.com` Personal Pro account. If that
model is unavailable, obtain explicit approval before another model. No work
account or development-session model fallback is allowed.

Acceptance requires all exit gates and their candidate-bound evidence; the
source integration alone does not close them or authorize production actions.
