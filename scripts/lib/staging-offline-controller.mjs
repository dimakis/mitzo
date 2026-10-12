import { createOfflineRecoveryProposal } from './staging-offline-ordinary-restore.mjs';
import { offlineContainmentDigest } from './staging-offline-containment-contract.mjs';
import { createOfflineOrdinaryRestoration } from './staging-offline-ordinary-restore.mjs';
import { createOfflineOrdinaryEffects } from './staging-offline-ordinary-effects.mjs';
import { createOfflineContainmentTransaction } from './staging-offline-containment-transaction.mjs';
import { createOfflineContainmentEffects } from './staging-offline-containment-effects.mjs';
import { createOfflineContainmentInspectionOwner } from './staging-offline-containment-observation.mjs';
import { enrollPreparedOfflineOperatorHelper } from './staging-offline-auth-enrollment.mjs';
import { createStagingOfflineOperatorAuthorizer } from './staging-offline-operator-auth.mjs';
import { executeOfflineRecovery } from './staging-offline-execution.mjs';
import { createStagingSourceAcceptanceWitness } from './staging-source-acceptance-witness.mjs';

/** CLI-only original controller wiring. All adapters below are accepted source,
 * not callbacks, proof flags or credentials loaded from proposal JSON. Tests
 * replace constructor capabilities without authenticating or touching staging. */
export async function applyOfflineRecoveryProposal(
  { proposal: selected, sourceRoot, verifySource },
  deps = {},
) {
  const proposal = createOfflineRecoveryProposal(selected);
  if (
    offlineContainmentDigest(proposal) !== offlineContainmentDigest(selected) ||
    typeof verifySource !== 'function'
  )
    throw Error('Exact combined recovery and qualified source verifier required');
  let sourceWitness, sourceToken;
  const checkSource = async () => {
    const receipt = sourceToken
      ? await sourceWitness.assertCurrent(sourceToken)
      : await verifySource();
    if (receipt.sourceCommit !== proposal.ordinaryPlan.facts.source.sourceCommit)
      throw Error('Prepared source changed from authenticated proposal');
    return receipt;
  };
  sourceWitness = (deps.createSourceWitness ?? createStagingSourceAcceptanceWitness)({
    canonicalRoot: proposal.containmentPlan.facts.canonicalRoot,
    sourceRoot,
    verifyFresh: verifySource,
  });
  const helper = await (deps.enroll ?? enrollPreparedOfflineOperatorHelper)(
    sourceRoot,
    checkSource,
  );
  const authorizer = (deps.createAuthorizer ?? createStagingOfflineOperatorAuthorizer)(helper);
  const inspectionFactory = deps.createInspectionOwner ?? createOfflineContainmentInspectionOwner;
  let phases, nativeEffects, ordinaryEffects, capability, containmentReceipt;
  const current = () => {
    if (!phases || phases.assertCurrent() !== true)
      throw Error('Original combined authority required');
    return true;
  };
  const physical = {
    assertBeforeMove(plan, phase) {
      return inspectionFactory({ verifyExecutingSource: checkSource }).assertBeforeMove(
        plan,
        phase,
      );
    },
    async assertContained(plan, intent) {
      current();
      const captured = ordinaryEffects?.getReplacementProof();
      const replacementApp = captured
        ? {
            phase: captured.originalJob ? 'running' : 'prepared',
            sourceCommit: captured.sourceCommit,
            releaseRoot: captured.release,
            plistPath: captured.plistPath,
            plistSha256: captured.plistSha256,
            launcherSha256: captured.launcherSha256,
            expectedProgramArguments: captured.nodeArgs,
            pid: captured.originalJob?.pid ?? null,
            birth: captured.originalJob?.birth ?? null,
          }
        : undefined;
      await inspectionFactory({
        replacementApp,
        verifyCurrentSource: checkSource,
        verifyExecutingSource: checkSource,
      }).assertContained(plan, intent);
      current();
    },
  };
  const verifyContainment = async () => {
    current();
    if (!capability || !containmentReceipt)
      throw Error('Original completed preservation capsule required');
    const receiptSha256 = capability.assertOwnedGuard(proposal.ordinaryPlan);
    if (receiptSha256 !== containmentReceipt.receiptSha256)
      throw Error('Original preserved receipt changed');
    await physical.assertContained(proposal.containmentPlan, {
      planSha256: proposal.containmentPlan.sha256,
    });
    current();
    return { receiptSha256 };
  };
  return executeOfflineRecovery({
    proposal,
    authorizer,
    async admitSource() {
      sourceToken = await sourceWitness.admit(proposal.ordinaryPlan.facts.source.sourceCommit);
    },
    assertContained: verifyContainment,
    async contain(plan, authority, originalPhases) {
      phases = originalPhases;
      nativeEffects = await (deps.createNativeEffects ?? createOfflineContainmentEffects)({
        plan,
        sourceRoot,
        assertAuthorityCurrent: current,
        verifyExecutingSource: checkSource,
        inspectionOwner: physical,
        assertGuardContinuation(...args) {
          if (!ordinaryEffects) throw Error('Original ordinary continuation verifier unavailable');
          current();
          return ordinaryEffects.assertGuardContinuation(...args);
        },
      });
      const transaction = (deps.createTransaction ?? createOfflineContainmentTransaction)({
        plan,
        consumeAuthority: phases.consumeContainment,
        effects: nativeEffects,
        continueGuard(originalCapability, receipt) {
          if (capability || containmentReceipt)
            throw Error('Original preservation handoff already consumed');
          capability = originalCapability;
          containmentReceipt = receipt;
        },
      });
      return transaction.apply(authority);
    },
    async restore(plan, authority, originalPhases) {
      if (originalPhases !== phases || !capability || !containmentReceipt)
        throw Error('Original completed preservation required before restoration');
      ordinaryEffects = (deps.createOrdinaryEffects ?? createOfflineOrdinaryEffects)({
        plan,
        verifySource: checkSource,
        verifyContainment,
        guardCapability: capability,
        initialContainmentReceiptSha256: containmentReceipt.receiptSha256,
        assertAuthorityCurrent: current,
      });
      return (deps.createRestoration ?? createOfflineOrdinaryRestoration)({
        plan,
        consumeAuthority: phases.consumeOrdinary,
        effects: ordinaryEffects,
      }).apply(authority);
    },
  }).finally(() => {
    authorizer.close?.();
    sourceWitness.close();
  });
}
