import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createStagingProfileEffects } from '../lib/staging-profile-live-runner.mjs';
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
