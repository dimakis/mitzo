import process from 'node:process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  createStagingSourceAcceptanceWitness,
  SOURCE_HISTORY_SCRATCH_BYTES,
} from './staging-source-acceptance-witness.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
import { acquireOriginalNativeAppUpdateGuard } from './staging-native-app-update-guard.mjs';
import { STAGING_RESOURCE_BUDGET } from './staging-resource-budget.mjs';
const refuse = () =>
  Error('Original queue-owned native app update unavailable; preserve app, VM and guard');
const hash = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const sync = (fn) => {
  const result = fn();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {});
    throw refuse();
  }
};
/** Actual original actor composes this with its physical compatibility inspector,
 * live VM owner and actual main child replacement port. No network request can
 * supply those capabilities. The retained native source and capacity never change. */
export function createOriginalNativeAppUpdateController({
  root,
  allocation,
  nativeSourceCommit,
  sourceInspector,
  appSourceBridge,
  vmOwner,
  observeRegisteredOriginal,
  assertOriginalCurrent,
  createChildSelection,
  replaceOriginalChild,
}) {
  let transition,
    retainedCommit = nativeSourceCommit,
    retainedInventorySha256 = hash(sourceInspector.original);
  if (
    [
      observeRegisteredOriginal,
      assertOriginalCurrent,
      createChildSelection,
      replaceOriginalChild,
    ].some((fn) => typeof fn !== 'function') ||
    typeof vmOwner?.assertRunningCurrent !== 'function' ||
    typeof vmOwner?.assertOriginalRunningCurrent !== 'function'
  )
    throw refuse();
  const plans = new Map();
  const current = () => sync(assertOriginalCurrent);
  const resources = () => {
    current();
    vmOwner.assertOriginalRunningCurrent();
    try {
      const facts = vmOwner.assertRunningCurrent();
      current();
      return { admitted: true, reasons: [], facts };
    } catch {
      vmOwner.assertOriginalRunningCurrent();
      current();
      return { admitted: false, reasons: ['original-native-resources-unavailable'] };
    }
  };
  const admit = () => {
    const observation = resources();
    const reserve = SOURCE_HISTORY_SCRATCH_BYTES / 1024 ** 3;
    if (
      !observation.admitted ||
      !Number.isFinite(observation.facts.aggregateGiB) ||
      !Number.isFinite(observation.facts.growthGiB) ||
      !Number.isFinite(observation.facts.diskFreeGiB) ||
      observation.facts.aggregateGiB + observation.facts.growthGiB + reserve >
        STAGING_RESOURCE_BUDGET.stagingGiB ||
      observation.facts.diskFreeGiB - observation.facts.growthGiB - reserve <
        STAGING_RESOURCE_BUDGET.diskFreeGiB
    )
      throw refuse();
  };
  const selectedCurrent = async (selected) => {
    const selectedPlan = transition;
    if (
      !selectedPlan ||
      selectedPlan.target !== selected ||
      performance.now() >= selectedPlan.deadline
    )
      throw refuse();
    selectedPlan.callerCurrent();
    current();
    selectedPlan.guard?.assertCurrent();
    await selectedPlan.witness.assertCurrent(selectedPlan.acceptance);
    selectedPlan.callerCurrent();
    current();
    selectedPlan.guard?.assertCurrent();
    if (hash(sourceInspector.inspect(selected)) !== selectedPlan.inventorySha256) throw refuse();
    if (performance.now() >= selectedPlan.deadline) throw refuse();
  };
  return Object.freeze({
    assertSelectedSourceCurrent: selectedCurrent,
    selectedSource() {
      return transition?.target ?? retainedCommit;
    },
    /** Used only at a new same-source child admission/readiness phase. The
     * genuine admitted original process retains this tuple after plan expiry. */
    assertRetainedSourceCurrent(selected) {
      current();
      if (
        transition ||
        selected !== retainedCommit ||
        hash(sourceInspector.inspect(selected)) !== retainedInventorySha256
      )
        throw refuse();
      current();
    },
    selectedTransition() {
      return Boolean(transition);
    },
    resources(input, callerCurrent) {
      callerCurrent();
      current();
      if (appSourceBridge.capture().acceptedAppCommit !== input.expectedCurrent) throw refuse();
      const observation = resources();
      callerCurrent();
      current();
      return Object.freeze({
        version: 1,
        nativeSourceCommit,
        acceptedAppSource: appSourceBridge.capture(),
        assessment: observation,
      });
    },
    async plan(input, callerCurrent) {
      callerCurrent();
      current();
      if (transition || plans.size !== 0) throw refuse();
      const old = appSourceBridge.capture();
      if (old.acceptedAppCommit !== input.expectedCurrent || input.target === old.acceptedAppCommit)
        throw refuse();
      admit();
      const sourceRoot = join(root, 'releases', input.target.slice(0, 12));
      const witness = createStagingSourceAcceptanceWitness({
        canonicalRoot: root,
        sourceRoot,
        verifyFresh: async () => {
          callerCurrent();
          current();
          return verifyPreparedController(root, sourceRoot, input.target);
        },
      });
      const context = {
        target: input.target,
        sourceRoot,
        witness,
        callerCurrent,
        deadline: performance.now() + 12 * 60 * 1000,
      };
      transition = context;
      try {
        context.acceptance = await witness.admit(input.target);
        context.inventorySha256 = hash(sourceInspector.inspect(input.target));
        context.candidate = await appSourceBridge.qualify(input.target);
        await appSourceBridge.assertCandidateCurrent(context.candidate);
        callerCurrent();
        current();
        admit();
        if (hash(appSourceBridge.capture()) !== hash(old)) throw refuse();
        const proposal = Object.freeze({
          version: 1,
          allocation,
          nativeSourceCommit,
          target: input.target,
          sourceRoot,
          old,
          inventorySha256: context.inventorySha256,
          queueProofSha256: hash(input.queueProof),
          sourceScratchReserveBytes: SOURCE_HISTORY_SCRATCH_BYTES,
          nativeAllocationChanged: false,
          nativeRetirementClaim: false,
        });
        const planSha256 = hash(proposal);
        plans.set(planSha256, { ...context, proposal, used: false });
        return { proposal, planSha256 };
      } catch (error) {
        witness.close();
        throw error;
      } finally {
        transition = undefined;
      }
    },
    async apply(input, callerCurrent) {
      callerCurrent();
      current();
      const context = plans.get(input.planSha256);
      if (
        !context ||
        context.used ||
        transition ||
        context.target !== input.target ||
        context.proposal.old.acceptedAppCommit !== input.expectedCurrent ||
        context.proposal.queueProofSha256 !== hash(input.queueProof) ||
        performance.now() >= context.deadline ||
        hash(appSourceBridge.capture()) !== hash(context.proposal.old)
      )
        throw refuse();
      context.callerCurrent = callerCurrent;
      transition = context;
      context.used = true; // One attempt. Failure cannot replay a disconnect/fork.
      try {
        await selectedCurrent(context.target);
        admit();
        context.guard = acquireOriginalNativeAppUpdateGuard({
          root,
          allocation,
          planSha256: input.planSha256,
          observeRegisteredOriginal,
          assertOperationCurrent() {
            callerCurrent();
            current();
            vmOwner.assertOriginalRunningCurrent();
          },
        });
        await selectedCurrent(context.target);
        await appSourceBridge.assertCandidateCurrent(context.candidate);
        if (hash(appSourceBridge.capture()) !== hash(context.proposal.old)) throw refuse();
        const selection = createChildSelection({
          sourceCommit: context.target,
          sourceRoot: context.sourceRoot,
          async assertCurrent() {
            await selectedCurrent(context.target);
            admit();
          },
        });
        callerCurrent();
        current();
        context.guard.assertCurrent();
        const identity = await replaceOriginalChild(selection);
        await selectedCurrent(context.target);
        callerCurrent();
        current();
        const observed = appSourceBridge.capture();
        if (
          observed.acceptedAppCommit !== context.target ||
          observed.controllerPid !== identity.controllerPid ||
          observed.epoch !== identity.epoch ||
          observed.custodianPid !== process.pid ||
          observed.custodianPid !== context.proposal.old.custodianPid ||
          observed.instanceId !== context.proposal.old.instanceId ||
          observed.controllerPid === context.proposal.old.controllerPid ||
          observed.epoch <= context.proposal.old.epoch
        )
          throw refuse();
        context.guard.complete(() => {
          callerCurrent();
          current();
          vmOwner.assertOriginalRunningCurrent();
          return appSourceBridge.capture();
        });
        retainedCommit = context.target;
        retainedInventorySha256 = context.inventorySha256;
        witnessClose(context);
        plans.delete(input.planSha256);
        return Object.freeze({
          version: 1,
          nativeSourceCommit,
          acceptedAppSource: observed,
          planSha256: input.planSha256,
          nativeAllocationChanged: false,
          nativeRetirementClaim: false,
        });
      } finally {
        // Failure leaves its original guard, source witness and used proposal
        // intact. It cannot reopen the old source, infer cleanup or replay.
        transition = undefined;
      }
    },
    observeReadyCandidate() {
      if (!transition || !transition.guard) throw refuse();
      return transition.candidate;
    },
  });
}
function witnessClose(context) {
  context.witness.close();
}
