import { createHash } from 'node:crypto';
const canonicalUrl = 'http://mitzo-staging.localhost:3190';
const identifier = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const modelOrAccount = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(v);
const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const commit = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.split(',').sort().join()
  )
    throw Error('Bounded staging feature plan required');
}
function assertAcceptedAppSource(observation, sourceCommit, nativeSourceCommit, ownerInstance) {
  exact(
    observation,
    'nativeSourceCommit,acceptedAppCommit,appRoot,instanceId,custodianPid,epoch,controllerPid,compatibilitySha256',
  );
  if (
    !commit(sourceCommit) ||
    !commit(nativeSourceCommit) ||
    observation.nativeSourceCommit !== nativeSourceCommit ||
    observation.acceptedAppCommit !== sourceCommit ||
    observation.instanceId !== ownerInstance ||
    !identifier(ownerInstance) ||
    typeof observation.appRoot !== 'string' ||
    !observation.appRoot.startsWith('/') ||
    observation.appRoot.length > 4096 ||
    ['custodianPid', 'controllerPid', 'epoch'].some(
      (key) => !Number.isSafeInteger(observation[key]) || observation[key] < 1,
    ) ||
    !digest(observation.compatibilitySha256)
  )
    throw Error('Paired original native/accepted source observations required');
}
function pairedSource(value) {
  return (
    Object.hasOwn(value ?? {}, 'nativeSourceCommit') ||
    Object.hasOwn(value ?? {}, 'acceptedAppSource')
  );
}
export function assertStagingFeaturePlan(plan) {
  exact(
    plan,
    'version,requestId,sourceCommit,profileId,enrollmentRevision,profileRevision,provider,runtime,runtimeRevision,ownerInstance,chargedAccount,selectedModel,modelApprovalId,suite,suiteRevision,runnerRevision,modelDispatches,auxiliaryDispatches,limits' +
      (pairedSource(plan) ? ',nativeSourceCommit,acceptedAppSource' : ''),
  );
  if (
    plan.version !== 1 ||
    plan.suite !== 'profile-tools-v1' ||
    !commit(plan.sourceCommit) ||
    ['requestId', 'profileId', 'provider', 'runtime', 'ownerInstance'].some(
      (key) => !identifier(plan[key]),
    ) ||
    !modelOrAccount(plan.chargedAccount) ||
    !modelOrAccount(plan.selectedModel) ||
    [
      'enrollmentRevision',
      'profileRevision',
      'runtimeRevision',
      'suiteRevision',
      'runnerRevision',
    ].some((key) => !digest(plan[key]))
  )
    throw Error('Bounded staging feature plan required');
  if (
    !/^gpt-\d+(?:\.\d+)?-luna$/.test(plan.selectedModel) &&
    !(
      plan.provider === 'anthropic-vertex' &&
      plan.selectedModel === 'claude-haiku-4-5@20251001' &&
      identifier(plan.modelApprovalId)
    )
  )
    throw Error('Explicit Luna or owner-verified alternative model plan required');
  if (plan.modelApprovalId !== null && !identifier(plan.modelApprovalId))
    throw Error('Bounded staging feature plan required');
  if (
    !['disabled', 'same-selected-model-shared-budget'].includes(plan.auxiliaryDispatches) ||
    !Array.isArray(plan.modelDispatches) ||
    plan.modelDispatches.length !== 1
  )
    throw Error('Bounded staging model scope required');
  exact(plan.modelDispatches[0], 'purpose,chargedAccount,selectedModel,maxModelRounds');
  if (
    (plan.auxiliaryDispatches === 'disabled'
      ? plan.modelDispatches[0].purpose !== 'main'
      : plan.modelDispatches[0].purpose !== 'all-inference' ||
        plan.runtime !== 'openshell-native') ||
    plan.modelDispatches[0].chargedAccount !== plan.chargedAccount ||
    plan.modelDispatches[0].selectedModel !== plan.selectedModel ||
    plan.modelDispatches[0].maxModelRounds !== 2
  )
    throw Error('Exact staging model scope required');
  if (pairedSource(plan)) {
    if (plan.runtime !== 'openshell-native')
      throw Error('Original native source observations required');
    assertAcceptedAppSource(
      plan.acceptedAppSource,
      plan.sourceCommit,
      plan.nativeSourceCommit,
      plan.ownerInstance,
    );
  }
  exact(plan.limits, 'maxProviderDispatches,timeoutMs,maxOutputBytes');
  if (
    plan.limits.maxProviderDispatches !== 1 ||
    !Number.isSafeInteger(plan.limits.timeoutMs) ||
    plan.limits.timeoutMs < 1000 ||
    plan.limits.timeoutMs > 180000 ||
    !Number.isSafeInteger(plan.limits.maxOutputBytes) ||
    plan.limits.maxOutputBytes < 1 ||
    plan.limits.maxOutputBytes > 65536
  )
    throw Error('Bounded staging feature plan required');
}
async function boundedJson(response) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 65536)
    throw Error('Staging feature owner authority unavailable');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw Error('Bounded staging feature response required');
      }
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

/** Foreground effects for the existing singleton queue. Only the qualified
 * bootstrap's private stage auth is accepted; there is no login/config/provider
 * discovery fallback. These endpoints stay unavailable until owner enrollment.
 * The caller must preserve dispatched uncertainty when a response is lost. */
export function createStagingProfileEffects({
  baseUrl = canonicalUrl,
  authorization,
  request = fetch,
  announce = (line) => process.stderr.write(line + '\n'),
} = {}) {
  if (baseUrl !== canonicalUrl)
    throw Error('Only the canonical staging feature bridge is supported');
  if (typeof authorization !== 'string' || !/^Bearer [^\s]{1,16384}$/.test(authorization))
    throw Error('Fresh staging feature client authority required');
  async function call(path, body, timeoutMs = 15000) {
    try {
      return await boundedJson(
        await request(canonicalUrl + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch {
      throw Error('Staging feature owner authority unavailable');
    }
  }
  return {
    /** Observations from the existing authenticated original native owner.
     * Parsing JSON grants no capacity; caller still qualifies canonical origin,
     * accepted source and the actual retained owner before admitting work. */
    async observeResources(sourceCommit, ownerInstance) {
      if (!commit(sourceCommit) || !identifier(ownerInstance))
        throw Error('Exact original native source/owner required');
      const response = await call('/api/staging/features/resources');
      exact(
        response,
        'version,sourceCommit,ownerInstance,resources' +
          (pairedSource(response) ? ',nativeSourceCommit,acceptedAppSource' : ''),
      );
      if (pairedSource(response))
        assertAcceptedAppSource(
          response.acceptedAppSource,
          response.sourceCommit,
          response.nativeSourceCommit,
          response.ownerInstance,
        );
      exact(
        response.resources,
        'aggregateGiB,growthGiB,diskFreeGiB,vmMemoryMiB,vmCpus,allocationUUID,planSha256,bootUUID,supervisorPid,vfkitPid,observationSha256,nativeRetirementClaim',
      );
      const observed = response.resources;
      if (
        response.version !== 1 ||
        response.sourceCommit !== sourceCommit ||
        response.ownerInstance !== ownerInstance ||
        observed.vmMemoryMiB !== 4096 ||
        observed.vmCpus !== 2 ||
        observed.nativeRetirementClaim !== false ||
        ['aggregateGiB', 'growthGiB', 'diskFreeGiB'].some(
          (key) => !Number.isFinite(observed[key]) || observed[key] < 0,
        ) ||
        ['supervisorPid', 'vfkitPid'].some(
          (key) => !Number.isSafeInteger(observed[key]) || observed[key] <= 0,
        ) ||
        ['allocationUUID', 'bootUUID'].some(
          (key) =>
            typeof observed[key] !== 'string' ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(observed[key]),
        ) ||
        !digest(observed.planSha256) ||
        !digest(observed.observationSha256)
      )
        throw Error('Original native resource observations differ');
      return response;
    },
    async lookupEnrollment(profileId) {
      if (!identifier(profileId)) throw Error('Bounded staging profile required');
      const enrollment = await call(
        '/api/staging/features/enrollments/' + encodeURIComponent(profileId),
      );
      exact(
        enrollment,
        'profileId,enrollmentRevision' +
          (pairedSource(enrollment) ? ',sourceCommit,nativeSourceCommit,acceptedAppSource' : ''),
      );
      if (pairedSource(enrollment))
        assertAcceptedAppSource(
          enrollment.acceptedAppSource,
          enrollment.sourceCommit,
          enrollment.nativeSourceCommit,
          enrollment.acceptedAppSource?.instanceId,
        );
      if (enrollment.profileId !== profileId || !digest(enrollment.enrollmentRevision))
        throw Error('Staging feature enrollment unavailable');
      return enrollment;
    },
    async plan(request, sourceCommit) {
      if (
        !request ||
        request.version !== 2 ||
        request.suite !== 'profile-tools-v1' ||
        !identifier(request.id) ||
        !identifier(request.profileId) ||
        !digest(request.enrollmentRevision) ||
        !commit(sourceCommit)
      )
        throw Error('Exact staging feature request required');
      const response = await call('/api/staging/features/plan', { request, sourceCommit });
      exact(response, 'plan,planSha256');
      assertStagingFeaturePlan(response.plan);
      if (
        response.plan.requestId !== request.id ||
        response.plan.sourceCommit !== sourceCommit ||
        response.plan.profileId !== request.profileId ||
        response.plan.enrollmentRevision !== request.enrollmentRevision ||
        response.planSha256 !== hash(response.plan)
      )
        throw Error('Staging feature plan changed');
      return response;
    },
    async run(plan, token) {
      assertStagingFeaturePlan(plan);
      exact(token, 'epoch,requestId,owner,nonce');
      if (
        token.requestId !== plan.requestId ||
        !Number.isSafeInteger(token.epoch) ||
        token.epoch < 1 ||
        !identifier(token.owner) ||
        !identifier(token.nonce)
      )
        throw Error('Exact staging feature reservation required');
      announce(
        plan.auxiliaryDispatches === 'disabled'
          ? `[staging-feature] LIVE CHARGE account=${plan.chargedAccount} model=${plan.selectedModel} max-model-rounds=2 auxiliary=disabled`
          : `[staging-feature] LIVE CHARGE account=${plan.chargedAccount} model=${plan.selectedModel} all-inference=main+any-auxiliary shared-max-requests=2`,
      );
      const result = await call(
        '/api/staging/features/run',
        { plan, token },
        plan.limits.timeoutMs + 10000,
      );
      exact(result, 'outcome,sourceCommit,cleanupConfirmed,featureResult');
      exact(
        result.featureResult,
        'version,profileId,enrollmentRevision,planSha256,ownerInstance,runId,ownerReceiptSha256',
      );
      if (
        !['passed', 'failed'].includes(result.outcome) ||
        result.sourceCommit !== plan.sourceCommit ||
        result.cleanupConfirmed !== true ||
        result.featureResult.version !== 1 ||
        result.featureResult.profileId !== plan.profileId ||
        result.featureResult.enrollmentRevision !== plan.enrollmentRevision ||
        result.featureResult.planSha256 !== hash(plan) ||
        result.featureResult.ownerInstance !== plan.ownerInstance ||
        !identifier(result.featureResult.runId) ||
        !digest(result.featureResult.ownerReceiptSha256)
      )
        throw Error('Original-owner feature receipt unavailable');
      return result;
    },
  };
}
