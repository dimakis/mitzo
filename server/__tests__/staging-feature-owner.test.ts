import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  StagingFeatureOwner,
  StagingFeaturePlan,
  type StagingFeatureOwnerAuthority,
} from '../staging-feature-owner.js';

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-feature-offline-'));
  roots.push(root);
  const enrollment = {
    profileId: 'stage-personal',
    enrollmentRevision: 'e'.repeat(64),
    binding: {
      accountId: 'stage-personal',
      accountLabel: 'Stage Personal',
      provider: 'openai',
      profileRevision: 'd'.repeat(64),
    },
    runtime: 'local-responses',
    runtimeRevision: 'f'.repeat(64),
    chargedAccount: 'stage-personal',
    selectedModel: 'gpt-6-luna',
    modelApprovalId: null,
  };
  const start = vi
    .fn<StagingFeatureOwnerAuthority['port']['startChat']>()
    .mockResolvedValue(undefined);
  const reservation = vi.fn();
  const authority = {
    sourceCommit: 'a'.repeat(40),
    ownerInstance: 'owner-current',
    fixtureDirectory: root,
    currentProfiles: () => ({ resume() {}, validateModelSelection() {} }),
    enrollment: () => enrollment,
    assertOriginalOwner() {},
    assertFreshAuthorization() {},
    assertModelApproval() {
      throw new Error('No grant');
    },
    assertReservation: reservation,
    port: {
      startChat: start,
      stopChat: vi.fn(),
      registry: { get: () => undefined },
      eventStore: {},
      isAllowedPath: () => true,
    },
  } as unknown as StagingFeatureOwnerAuthority;
  const owner = new StagingFeatureOwner(authority);
  const request = {
    version: 2,
    id: 'request-one',
    pr: 1,
    taskId: 'task-one',
    acceptedCommit: authority.sourceCommit,
    suite: 'profile-tools-v1',
    profileId: enrollment.profileId,
    enrollmentRevision: enrollment.enrollmentRevision,
  };
  const token = {
    epoch: 1,
    requestId: request.id,
    owner: 'queue-original',
    nonce: 'nonce-original',
  };
  return { root, owner, start, reservation, authority, request, token, enrollment };
}
it('plans read-only with every model route pinned and refuses a reservation before any fixture or turn', async () => {
  const f = await setup();
  const { plan } = f.owner.plan(f.request, f.authority.sourceCommit);
  expect(plan.modelDispatches).toEqual([
    {
      purpose: 'main',
      chargedAccount: 'stage-personal',
      selectedModel: 'gpt-6-luna',
      maxModelRounds: 2,
    },
  ]);
  expect(plan.auxiliaryDispatches).toBe('disabled');
  expect(await readdir(f.root)).toEqual([]);
  f.reservation.mockImplementation(() => {
    throw new Error('Absent actual queue guard');
  });
  await expect(f.owner.run(plan, f.token)).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual([]);
});
it('retains and closes a partial-start original capability before onQueryReady and does not synthesize a receipt', async () => {
  const f = await setup();
  const close = vi.fn(async () => {});
  f.start.mockImplementation(async (_transport, _id, _prompt, options) => {
    if (!options.stagingFeature) throw new Error('Original staging feature startup scope missing');
    options.stagingFeature.retainCleanup(close);
    throw new Error('Original initialization failed before query ready');
  });
  const { plan } = f.owner.plan(f.request, f.authority.sourceCommit);
  await expect(f.owner.run(plan, f.token)).rejects.toThrow('reconciliation');
  expect(close).toHaveBeenCalledOnce();
  expect(() => f.owner.receipt('invented')).toThrow('unavailable');
  await expect(f.owner.run(plan, f.token)).rejects.toThrow('unavailable');
  expect(f.start).toHaveBeenCalledOnce();
});

it('refuses Codex auxiliary inference without supported explicit compaction qualification', async () => {
  const f = await setup();
  Object.assign(f.enrollment, {
    runtime: 'local-codex',
    binding: { ...f.enrollment.binding, provider: 'openai-codex' },
  });
  expect(() => f.owner.plan(f.request, f.authority.sourceCommit)).toThrow('auxiliary');
  expect(f.start).not.toHaveBeenCalled();
  expect(await readdir(f.root)).toEqual([]);
});

it('admits only exact selected-model all-inference scope within the same native two-request budget', async () => {
  const f = await setup();
  const original = f.owner.plan(f.request, f.authority.sourceCommit).plan;
  const native = {
    ...original,
    runtime: 'openshell-native',
    auxiliaryDispatches: 'same-selected-model-shared-budget',
    modelDispatches: [{ ...original.modelDispatches[0], purpose: 'all-inference' }],
  };
  expect(StagingFeaturePlan.safeParse(native).success).toBe(true);
  expect(StagingFeaturePlan.safeParse({ ...native, auxiliaryDispatches: 'disabled' }).success).toBe(
    false,
  );
  expect(StagingFeaturePlan.safeParse({ ...native, runtime: 'local-responses' }).success).toBe(
    false,
  );
  expect(
    StagingFeaturePlan.safeParse({
      ...native,
      modelDispatches: [{ ...native.modelDispatches[0], maxModelRounds: 3 }],
    }).success,
  ).toBe(false);
  expect(
    StagingFeaturePlan.safeParse({
      ...native,
      modelDispatches: [{ ...native.modelDispatches[0], chargedAccount: 'foreign' }],
    }).success,
  ).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
});
