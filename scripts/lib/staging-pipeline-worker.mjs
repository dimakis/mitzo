/** A foreground controller handles one request. Constructor effects are trusted
 * adapters or test fixtures, never commands or grants supplied by a request. */
export async function runStagingPipelineRequest(
  store,
  effects,
  owner,
  { featurePlanSha256, requestId } = {},
) {
  const claim = store.claim(owner, { requestId });
  if (!claim.granted) return claim;
  const { token, request } = claim;
  effects.authorize?.(token);
  let phase = 'preflight';
  const wait = (reason) => {
    store.defer(token, reason);
    return { requestId: request.id, state: 'queued', reason };
  };
  try {
    store.assertToken(token);
    if (!(await effects.resources(0)).admitted) return wait('host-resources');
    const sourceCommit = await effects.baseline(request.acceptedCommit);
    if (!sourceCommit) return wait('source-superseded');
    store.bindBaseline(token, sourceCommit);
    const current = await effects.check();
    if (!current.safe) return wait('stage-unavailable');
    let featureContext;
    if (request.version === 2) {
      if (current.expected !== sourceCommit) return wait('stage-unavailable');
      const plan = await effects.featurePlan(request, sourceCommit, token);
      if (!/^[a-f0-9]{64}$/.test(plan?.planSha256) || !plan.publicPlan)
        throw Error('Authenticated bounded feature plan required');
      if (featurePlanSha256 !== plan.planSha256)
        return {
          ...wait('feature-plan-required'),
          featurePlanSha256: plan.planSha256,
          featurePlan: plan.publicPlan,
        };
      featureContext = { request, token, planSha256: plan.planSha256, plan: plan.publicPlan };
      store.bindFeaturePlan(token, plan.planSha256, plan.publicPlan.ownerInstance);
    } else if (featurePlanSha256 !== undefined)
      throw Error('Feature plan cannot override readiness');
    if (current.expected !== sourceCommit) {
      // Only the canonical read-only source/artifact/dependency verification can
      // establish zero-growth reuse. Existing paths alone are never proof.
      const prepared = await effects.prepared(sourceCommit);
      const snapshotGrowth = await effects.deploymentGrowth();
      if (!Number.isFinite(snapshotGrowth) || snapshotGrowth < 0)
        throw Error('Snapshot growth unavailable');
      if (!(await effects.resources(prepared.growthGiB + snapshotGrowth)).admitted)
        return wait('host-resources');
      if (!prepared.reused) {
        phase = 'preparing';
        await effects.prepare(sourceCommit);
      }
      phase = 'planning';
      await effects.plan(sourceCommit, current.expected);
      phase = 'preflight';
      const currentSnapshotGrowth = await effects.deploymentGrowth();
      if (!Number.isFinite(currentSnapshotGrowth) || currentSnapshotGrowth < 0)
        throw Error('Snapshot growth unavailable');
      if (!(await effects.resources(currentSnapshotGrowth)).admitted) return wait('host-resources');
      store.markDispatched(token);
      phase = 'deploying';
      await effects.deploy(sourceCommit, current.expected);
    }
    const selected = await effects.check();
    if (!selected.safe || selected.expected !== sourceCommit)
      throw Error('Staging baseline changed');
    if (!(await effects.resources(0)).admitted) {
      // Apply completed and the canonical check just confirmed the exact source
      // and absence of uncertainty. No test has started, so capacity waiting can
      // release this completed operation without fabricating native retirement.
      if (phase === 'deploying') store.settleDeployment(token, sourceCommit);
      return wait('host-resources');
    }
    if (phase !== 'deploying') store.markDispatched(token);
    store.assertToken(token);
    phase = 'testing';
    const result = featureContext
      ? await effects.test(request.suite, sourceCommit, featureContext)
      : await effects.test(request.suite, sourceCommit);
    const after = await effects.check();
    if (!after.safe || after.expected !== sourceCommit || result.cleanupConfirmed !== true)
      throw Error('Test lifecycle or baseline uncertain');
    if (
      featureContext &&
      (result.featureReceipt?.planSha256 !== featureContext.planSha256 ||
        result.featureReceipt?.profileId !== request.profileId ||
        result.featureReceipt?.enrollmentRevision !== request.enrollmentRevision)
    )
      throw Error('Original-owner feature receipt binding changed');
    store.finish(token, {
      outcome: result.outcome,
      sourceCommit,
      cleanupConfirmed: true,
      ...(featureContext ? { featureReceipt: result.featureReceipt } : {}),
    });
    return { requestId: request.id, state: result.outcome, sourceCommit };
  } catch (error) {
    if (error.reservationExpired === true) {
      store.quarantine(token, 'controller-lost');
      return { requestId: request.id, state: 'quarantined', reason: 'controller-lost' };
    }
    if (
      (phase === 'preparing' && error.safePreparationRefusal === true) ||
      (phase === 'planning' && error.terminalRefusal === true)
    )
      return wait('stage-unavailable');
    if (phase === 'preflight') return wait('stage-unavailable');
    const reason = phase === 'testing' ? 'test-cleanup-uncertain' : 'deployment-uncertain';
    store.quarantine(token, reason);
    return { requestId: request.id, state: 'quarantined', reason };
  }
}
