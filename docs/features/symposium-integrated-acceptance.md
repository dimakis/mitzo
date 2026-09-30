# Symposium integrated acceptance checklist

Scope is frozen to PR #678 reconciled with current main. This checklist names
exit gates; the append-only canonical `ACCEPTANCE_LEDGER.md` remains the source
of evidence and retained operation history. Update that ledger with exact
candidate/operation/artifact IDs and bounded outcomes before marking a gate done.

## Candidate baseline

- PR input: `7cdb65b61c5f5fea51e553c969719dd0a4e79ddf`.
- Main input: `b9028e6cf9086e2c914b13d6022ad5459f7d9bf5` (PRs #681,
  #585, #682, #683 and #684). The integration incorporates both inputs without
  rewriting feature history. Identify the resulting candidate and its fresh
  gate receipts in the canonical ledger; input hashes alone are not acceptance.
- Record the resulting commit/tree, dependency/build evidence and measured
  runtime/image/helper/bootstrap pins before acceptance. Any source change
  invalidates candidate gates and requires fresh checks.
- Four green CI jobs and Centaur LGTM review `5368499330` cover only `7cdb65b6`.
  They become historical evidence when the integration is committed. Obtain
  fresh all-job CI and exact-head independent review/LGTM for the candidate.

## Evidence boundary

Stage 27 sign-in `7427922a-2cc5-4e31-a084-72d4a72d9648` completed for
`dimitri.saridakis@gmail.com` Personal Pro. Its single catalog operation
`d5582ec4-6a16-4985-b7b2-06556fa890cf` confirmed failed at native account/read
with `routing_failed`; it remains unreplayed. This category does not identify
an upstream HTTP status or a proven cause. Fresh supported Luna 6 availability
and the complete workflow are unverified.

Earlier live Luna evidence and mocked/unit suites demonstrate their recorded
slices, not this integrated candidate. No inference occurred in the recent
offline diagnostics. DIAGNOSTIC_6 is prepared and stopped; it is a narrow
synthetic fixture, neither acceptance nor a cause of the live routing failure.
Stage 20 review `bb95f6d0-cc49-4434-bb11-ce251fc23163` and all other retained
attempts must be reconciled by original ID, never blindly replayed.

## Exit gates

At checklist creation, all gates below remain open. Consult the latest ledger
entries for completed gates. Each next check must target the reviewed candidate
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
- [ ] **Resources and spend.** Prove enforced CPU/memory/storage bounds and
      trusted native token/monetary reservations, terminal usage and hard stop.
      Application turn/cycle/deadline limits are separate controls; they do not
      establish hard native token or spend enforcement. Unknown usage stays unknown.
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
