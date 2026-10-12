/** A foreground controller handles one request. Constructor effects are trusted
 * adapters or test fixtures, never commands or grants supplied by a request. */
export async function runStagingPipelineRequest(store, effects, owner) {
  const claim = store.claim(owner);
  if (!claim.granted) return claim;
  const { token, request } = claim;
  effects.authorize?.(token);
  let phase = 'preflight';
  const wait = (reason) => {
    store.defer(token, reason);
    return { requestId: request.id, state: 'queued', reason };
  };
  try {
    if (!(await effects.resources(0)).admitted) return wait('host-resources');
    const sourceCommit = await effects.baseline(request.acceptedCommit);
    if (!sourceCommit) return wait('source-superseded');
    store.bindBaseline(token, sourceCommit);
    const current = await effects.check();
    if (!current.safe) return wait('stage-unavailable');
    if (current.expected !== sourceCommit) {
      if (!(await effects.resources(2)).admitted) return wait('host-resources');
      phase = 'preparing';
      await effects.prepare(sourceCommit);
      phase = 'planning';
      await effects.plan(sourceCommit, current.expected);
      phase = 'preflight';
      if (!(await effects.resources(0)).admitted) return wait('host-resources');
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
    phase = 'testing';
    const result = await effects.test(request.suite, sourceCommit);
    const after = await effects.check();
    if (!after.safe || after.expected !== sourceCommit || result.cleanupConfirmed !== true)
      throw Error('Test lifecycle or baseline uncertain');
    store.finish(token, { outcome: result.outcome, sourceCommit, cleanupConfirmed: true });
    return { requestId: request.id, state: result.outcome, sourceCommit };
  } catch (error) {
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
