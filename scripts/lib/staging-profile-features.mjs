import { isDeepStrictEqual } from 'node:util';

const identifier = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const error = () => {
  throw Error('Bounded credential-free public feature contract required');
};
function fields(value, expected) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== expected.split(',').sort().join()
  )
    error();
}
function unique(values) {
  if (new Set(values).size !== values.length)
    throw Error('Public feature identities must be unique');
}
function identifiers(values, max, nonempty = true) {
  if (
    !Array.isArray(values) ||
    values.length > max ||
    (nonempty && !values.length) ||
    values.some((value) => !identifier(value))
  )
    error();
  unique(values);
}
function reservation(value) {
  fields(value, 'requestId,epoch,ownerInstance');
  if (
    !identifier(value.requestId) ||
    !identifier(value.ownerInstance) ||
    !integer(value.epoch, Number.MAX_SAFE_INTEGER) ||
    value.epoch < 1
  )
    error();
}
function modelPolicy(profile) {
  const model = profile.selectedModel;
  if (!profile.supportedModels.includes(model))
    throw Error('Explicit supported test model policy required');
  const luna = /^gpt-\d+(?:\.\d+)?-luna$/.test(model);
  if (luna && profile.modelApproval === null) return;
  const approval = profile.modelApproval;
  if (!approval) throw Error('Explicit supported test model policy required');
  fields(approval, 'decision,approvalId,account,model,reason');
  if (
    approval.decision !== 'explicit-user-approval' ||
    !identifier(approval.approvalId) ||
    approval.account !== profile.chargedAccount ||
    approval.model !== model ||
    !['luna-unavailable', 'test-requires-another-model'].includes(approval.reason)
  )
    throw Error('Explicit supported test model policy required');
}
function validatePlan(plan) {
  fields(
    plan,
    'version,sourceCommit,suiteRevision,runnerRevision,reservation,limits,referenceProfiles,profiles',
  );
  if (
    plan.version !== 1 ||
    !commit(plan.sourceCommit) ||
    !digest(plan.suiteRevision) ||
    !digest(plan.runnerRevision)
  )
    error();
  reservation(plan.reservation);
  if (
    !Array.isArray(plan.referenceProfiles) ||
    !plan.referenceProfiles.length ||
    plan.referenceProfiles.length > 100
  )
    error();
  for (const reference of plan.referenceProfiles) {
    fields(reference, 'id,provider,runtime,capabilities');
    if (['id', 'provider', 'runtime'].some((key) => !identifier(reference[key]))) error();
    identifiers(reference.capabilities, 100, false);
  }
  unique(plan.referenceProfiles.map((reference) => reference.id));
  fields(plan.limits, 'maxProviderDispatches,timeoutMs,maxOutputBytes');
  if (
    !integer(plan.limits.maxProviderDispatches, 12) ||
    plan.limits.maxProviderDispatches < 1 ||
    !integer(plan.limits.timeoutMs, 600000) ||
    plan.limits.timeoutMs < 1 ||
    !integer(plan.limits.maxOutputBytes, 262144) ||
    plan.limits.maxOutputBytes < 1
  )
    error();
  if (!Array.isArray(plan.profiles) || !plan.profiles.length || plan.profiles.length > 100) error();
  for (const profile of plan.profiles) {
    fields(
      profile,
      'referenceId,profileId,provider,runtime,profileRevision,runtimeRevision,authorization,chargedAccount,supportedModels,selectedModel,modelApproval,requiredFeatures,capabilities',
    );
    if (
      ['referenceId', 'profileId', 'provider', 'runtime', 'chargedAccount', 'selectedModel'].some(
        (key) => !identifier(profile[key]),
      ) ||
      !digest(profile.profileRevision) ||
      !digest(profile.runtimeRevision) ||
      !['ready', 'pending'].includes(profile.authorization)
    )
      error();
    identifiers(profile.supportedModels, 256);
    identifiers(profile.requiredFeatures, 24);
    identifiers(profile.capabilities, 100, false);
    // A pending profile may name a candidate model, but cannot dispatch or prove a run.
    if (profile.authorization === 'ready') modelPolicy(profile);
    else if (profile.modelApproval !== null) modelPolicy(profile);
  }
  unique(plan.profiles.map((profile) => profile.profileId));
  unique(plan.profiles.map((profile) => profile.referenceId));
}
function validateResults(results) {
  if (!Array.isArray(results) || results.length > 100) error();
  for (const result of results) {
    fields(
      result,
      'version,sourceCommit,suiteRevision,runnerRevision,reservation,runId,profileId,provider,runtime,profileRevision,runtimeRevision,chargedAccount,selectedModel,providerDispatches,durationMs,outputBytes,observations,cleanup',
    );
    if (
      result.version !== 1 ||
      !commit(result.sourceCommit) ||
      ['suiteRevision', 'runnerRevision', 'profileRevision', 'runtimeRevision'].some(
        (key) => !digest(result[key]),
      ) ||
      ['runId', 'profileId', 'provider', 'runtime', 'chargedAccount', 'selectedModel'].some(
        (key) => !identifier(result[key]),
      ) ||
      ['providerDispatches', 'durationMs', 'outputBytes'].some(
        (key) => !integer(result[key], Number.MAX_SAFE_INTEGER),
      )
    )
      error();
    reservation(result.reservation);
    if (!Array.isArray(result.observations) || result.observations.length > 24) error();
    for (const observation of result.observations) {
      fields(observation, 'feature,outcome,evidenceSha256');
      if (
        !identifier(observation.feature) ||
        !['passed', 'failed', 'skipped'].includes(observation.outcome) ||
        !digest(observation.evidenceSha256)
      )
        error();
    }
    unique(result.observations.map((observation) => observation.feature));
    fields(result.cleanup, 'state,receiptSha256');
    if (
      !['confirmed', 'uncertain'].includes(result.cleanup.state) ||
      !digest(result.cleanup.receiptSha256)
    )
      error();
  }
  unique(results.map((result) => result.profileId));
  unique(results.map((result) => result.runId));
}

/** Pure contract assessment, not an execution or enrollment authority. JSON is
 * never live proof. The optional synchronous verifier is a trusted controller
 * dependency, not a public input: it must read original-owner evidence and bind
 * actual dispatch, observations, fresh enrollment/model approval and cleanup to
 * the complete result. There is currently no installed authenticated consumer.
 * A caller that substitutes `() => true` has not performed live verification.
 */
export function assessStagingProfileFeatures(plan, results, verifyOriginalOwnerRun) {
  validatePlan(plan);
  validateResults(results);
  if (Buffer.byteLength(JSON.stringify([plan, results])) > 1048576) error();
  if (verifyOriginalOwnerRun !== undefined && typeof verifyOriginalOwnerRun !== 'function') error();
  const issues = [];
  const add = (profileId, reason) => issues.push({ profileId, reason });
  for (const reference of plan.referenceProfiles) {
    const actual = plan.profiles.find((profile) => profile.referenceId === reference.id);
    if (!actual) add(reference.id, 'reference-profile-missing');
    else if (
      actual.provider !== reference.provider ||
      actual.runtime !== reference.runtime ||
      !isDeepStrictEqual([...actual.capabilities].sort(), [...reference.capabilities].sort())
    )
      add(actual.profileId, 'reference-profile-mismatch');
  }
  for (const profile of plan.profiles)
    if (!plan.referenceProfiles.some((reference) => reference.id === profile.referenceId))
      add(profile.profileId, 'reference-profile-unexpected');
  const expected = new Set(plan.profiles.map((profile) => profile.profileId));
  for (const result of results)
    if (!expected.has(result.profileId)) add(result.profileId, 'unexpected-profile');
  const totals = results.reduce(
    (sum, result) => ({
      providerDispatches: sum.providerDispatches + result.providerDispatches,
      durationMs: sum.durationMs + result.durationMs,
      outputBytes: sum.outputBytes + result.outputBytes,
    }),
    { providerDispatches: 0, durationMs: 0, outputBytes: 0 },
  );
  if (
    totals.providerDispatches > plan.limits.maxProviderDispatches ||
    totals.durationMs > plan.limits.timeoutMs ||
    totals.outputBytes > plan.limits.maxOutputBytes
  )
    add('all-profiles', 'run-budget-exceeded');
  for (const profile of plan.profiles) {
    if (profile.authorization !== 'ready') add(profile.profileId, 'authorization-pending');
    const result = results.find((candidate) => candidate.profileId === profile.profileId);
    if (!result) {
      add(profile.profileId, 'feature-run-missing');
      continue;
    }
    const matching =
      ['sourceCommit', 'suiteRevision', 'runnerRevision'].every(
        (key) => result[key] === plan[key],
      ) &&
      isDeepStrictEqual(result.reservation, plan.reservation) &&
      [
        'provider',
        'runtime',
        'profileRevision',
        'runtimeRevision',
        'chargedAccount',
        'selectedModel',
      ].every((key) => result[key] === profile[key]);
    if (!matching) add(profile.profileId, 'run-binding-mismatch');
    if (result.providerDispatches < 1) add(profile.profileId, 'provider-dispatch-missing');
    if (result.cleanup.state !== 'confirmed') add(profile.profileId, 'cleanup-uncertain');
    if (
      !isDeepStrictEqual(
        result.observations.map((item) => item.feature).sort(),
        [...profile.requiredFeatures].sort(),
      ) ||
      result.observations.some((item) => item.outcome !== 'passed')
    )
      add(profile.profileId, 'features-incomplete');
  }
  const runEvidenceMatches = issues.length === 0;
  // Do not consult authority for invalid or incomplete claimed results.
  if (runEvidenceMatches)
    for (const result of results) {
      let verified = false;
      try {
        const verdict = verifyOriginalOwnerRun?.(structuredClone(result), structuredClone(plan));
        verified = verdict === true;
        // Async verifiers are unsupported. Consume a rejected promise without
        // accepting it as proof or leaking private diagnostic text.
        if (verdict instanceof Promise) void verdict.catch(() => {});
      } catch {
        /* Private evidence failures remain bounded. */
      }
      if (!verified) add(result.profileId, 'owner-verification-required');
    }
  return {
    runEvidenceMatches,
    liveFeatureValidation: issues.length ? 'not-live-proven' : 'passed',
    issues,
    totals,
  };
}
