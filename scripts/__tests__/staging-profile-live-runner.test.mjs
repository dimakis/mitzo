import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createStagingProfileEffects,
  assertStagingFeaturePlan,
} from '../lib/staging-profile-live-runner.mjs';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = {
  version: 2,
  id: 'feature-1',
  pr: 876,
  taskId: 'task-1',
  acceptedCommit: 'a'.repeat(40),
  suite: 'profile-tools-v1',
  profileId: 'stage-personal',
  enrollmentRevision: 'b'.repeat(64),
};
const plan = {
  version: 1,
  requestId: request.id,
  sourceCommit: request.acceptedCommit,
  profileId: request.profileId,
  enrollmentRevision: request.enrollmentRevision,
  profileRevision: 'c'.repeat(64),
  provider: 'openai',
  runtime: 'local-responses',
  runtimeRevision: 'd'.repeat(64),
  ownerInstance: 'stage-owner',
  chargedAccount: 'personal-stage',
  selectedModel: 'gpt-6-luna',
  modelApprovalId: null,
  suite: request.suite,
  suiteRevision: 'e'.repeat(64),
  runnerRevision: 'f'.repeat(64),
  modelDispatches: [
    {
      purpose: 'main',
      chargedAccount: 'personal-stage',
      selectedModel: 'gpt-6-luna',
      maxModelRounds: 2,
    },
  ],
  auxiliaryDispatches: 'disabled',
  limits: { maxProviderDispatches: 1, timeoutMs: 180000, maxOutputBytes: 65536 },
};
it('validates the same selected model/account and one shared native budget for all inference', () => {
  const all = {
    ...plan,
    runtime: 'openshell-native',
    auxiliaryDispatches: 'same-selected-model-shared-budget',
    modelDispatches: [{ ...plan.modelDispatches[0], purpose: 'all-inference' }],
  };
  expect(() => assertStagingFeaturePlan(all)).not.toThrow();
  for (const changed of [
    { ...all, auxiliaryDispatches: 'disabled' },
    { ...all, runtime: 'local-responses' },
    { ...all, modelDispatches: [{ ...all.modelDispatches[0], maxModelRounds: 3 }] },
    { ...all, modelDispatches: [{ ...all.modelDispatches[0], selectedModel: 'gpt-6-sol' }] },
    { ...all, modelDispatches: [{ ...all.modelDispatches[0], chargedAccount: 'foreign' }] },
  ])
    expect(() => assertStagingFeaturePlan(changed)).toThrow();
});
it('permits a declared exact Vertex Haiku exception without permitting other models/providers', () => {
  const vertex = {
    ...plan,
    runtime: 'openshell-native',
    provider: 'anthropic-vertex',
    selectedModel: 'claude-haiku-4-5@20251001',
    modelApprovalId: 'original-vertex-approval',
    auxiliaryDispatches: 'same-selected-model-shared-budget',
    modelDispatches: [
      {
        ...plan.modelDispatches[0],
        purpose: 'all-inference',
        selectedModel: 'claude-haiku-4-5@20251001',
      },
    ],
  };
  expect(() => assertStagingFeaturePlan(vertex)).not.toThrow();
  expect(() => assertStagingFeaturePlan({ ...vertex, provider: 'openai' })).toThrow();
  expect(() => assertStagingFeaturePlan({ ...vertex, modelApprovalId: null })).toThrow();
  expect(() =>
    assertStagingFeaturePlan({
      ...vertex,
      selectedModel: 'claude-sonnet',
      modelDispatches: [{ ...vertex.modelDispatches[0], selectedModel: 'claude-sonnet' }],
    }),
  ).toThrow();
});
it('accepts only paired exact native/accepted source observation metadata', () => {
  const nativeSourceCommit = '1'.repeat(40);
  const acceptedAppSource = {
    nativeSourceCommit,
    acceptedAppCommit: plan.sourceCommit,
    appRoot: '/isolated/prepared',
    instanceId: plan.ownerInstance,
    custodianPid: 100,
    epoch: 1,
    controllerPid: 101,
    compatibilitySha256: '2'.repeat(64),
  };
  const paired = {
    ...plan,
    runtime: 'openshell-native',
    nativeSourceCommit,
    acceptedAppSource,
    auxiliaryDispatches: 'same-selected-model-shared-budget',
    modelDispatches: [{ ...plan.modelDispatches[0], purpose: 'all-inference' }],
  };
  expect(() => assertStagingFeaturePlan(paired)).not.toThrow();
  for (const changed of [
    { ...paired, acceptedAppSource: undefined },
    { ...paired, acceptedAppSource: { ...acceptedAppSource, acceptedAppCommit: '3'.repeat(40) } },
    { ...paired, acceptedAppSource: { ...acceptedAppSource, nativeSourceCommit: '3'.repeat(40) } },
    { ...paired, acceptedAppSource: { ...acceptedAppSource, instanceId: 'foreign' } },
    { ...paired, acceptedAppSource: { ...acceptedAppSource, controllerPid: 0 } },
    { ...paired, acceptedAppSource: { ...acceptedAppSource, capacityGranted: true } },
  ])
    expect(() => assertStagingFeaturePlan(changed)).toThrow();
});
it('uses only the authenticated canonical bridge and checks the returned exact plan', async () => {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ plan, planSha256: digest(plan) }), { status: 200 }),
  );
  const effects = createStagingProfileEffects({
    authorization: 'Bearer stage-only-token',
    request: fetch,
  });
  await expect(effects.plan(request, request.acceptedCommit)).resolves.toEqual({
    plan,
    planSha256: digest(plan),
  });
  expect(fetch.mock.calls[0][0]).toBe(
    'http://mitzo-staging.localhost:3190/api/staging/features/plan',
  );
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer stage-only-token');
});
it('refuses missing authority, foreign URL, stage drift and undeclared alternate model', async () => {
  expect(() => createStagingProfileEffects({})).toThrow(/authority/);
  expect(() =>
    createStagingProfileEffects({
      authorization: 'Bearer stage',
      baseUrl: 'http://localhost:3100',
    }),
  ).toThrow(/canonical/);
  for (const changed of [
    { ...plan, sourceCommit: '1'.repeat(40) },
    { ...plan, selectedModel: 'gpt-6-sol' },
  ]) {
    const effects = createStagingProfileEffects({
      authorization: 'Bearer stage',
      request: async () =>
        new Response(JSON.stringify({ plan: changed, planSha256: digest(changed) })),
    });
    await expect(effects.plan(request, request.acceptedCommit)).rejects.toThrow(/plan/);
  }
});
it('announces exact account/model before dispatch and returns only the checked receipt', async () => {
  const order = [];
  const featureResult = {
    version: 1,
    profileId: plan.profileId,
    enrollmentRevision: plan.enrollmentRevision,
    planSha256: digest(plan),
    ownerInstance: plan.ownerInstance,
    runId: 'run-1',
    ownerReceiptSha256: '1'.repeat(64),
  };
  const effects = createStagingProfileEffects({
    authorization: 'Bearer stage',
    announce: (line) => order.push(line),
    request: async () => {
      order.push('dispatch');
      return new Response(
        JSON.stringify({
          outcome: 'passed',
          sourceCommit: plan.sourceCommit,
          cleanupConfirmed: true,
          featureResult,
        }),
      );
    },
  });
  const token = { epoch: 1, requestId: plan.requestId, owner: 'controller', nonce: 'nonce' };
  await expect(effects.run(plan, token)).resolves.toMatchObject({ featureResult });
  expect(order[0]).toContain('account=personal-stage model=gpt-6-luna');
  expect(order[1]).toBe('dispatch');
});
it('does not turn a lost response or unconfirmed owned cleanup into a result', async () => {
  const effects = createStagingProfileEffects({
    authorization: 'Bearer stage',
    announce: () => {},
    request: async () => new Response(JSON.stringify({ cleanupConfirmed: false }), { status: 409 }),
  });
  await expect(
    effects.run(plan, { epoch: 1, requestId: plan.requestId, owner: 'controller', nonce: 'nonce' }),
  ).rejects.toThrow(/unavailable/);
});

it('binds original native resource observations to expected source/owner and refuses extra capacity flags', async () => {
  const response = {
    version: 1,
    sourceCommit: request.acceptedCommit,
    ownerInstance: 'actual-owner',
    resources: {
      aggregateGiB: 3,
      growthGiB: 0.1,
      diskFreeGiB: 100,
      vmMemoryMiB: 4096,
      vmCpus: 2,
      allocationUUID: '11111111-1111-4111-8111-111111111111',
      bootUUID: '22222222-2222-4222-8222-222222222222',
      planSha256: 'b'.repeat(64),
      supervisorPid: 100,
      vfkitPid: 101,
      observationSha256: 'c'.repeat(64),
      nativeRetirementClaim: false,
    },
  };
  let actual = response;
  const effects = createStagingProfileEffects({
    authorization: 'Bearer isolated-stage',
    request: async () => new Response(JSON.stringify(actual)),
  });
  await expect(effects.observeResources(request.acceptedCommit, 'actual-owner')).resolves.toEqual(
    response,
  );
  await expect(effects.observeResources(request.acceptedCommit, 'other-owner')).rejects.toThrow(
    /differ/,
  );
  actual = { ...response, resources: { ...response.resources, capacityGranted: true } };
  await expect(effects.observeResources(request.acceptedCommit, 'actual-owner')).rejects.toThrow(
    /Bounded/,
  );
});
