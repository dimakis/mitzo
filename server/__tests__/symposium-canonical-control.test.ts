import { expect, it } from 'vitest';
import {
  assertCanonicalOwnerRuntime,
  assertCanonicalOwnerRetired,
  drainCanonicalOwner,
} from '../symposium-canonical-control.js';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
const plan = {
  sourceCommit: 'a'.repeat(40),
  configSha256: 'b'.repeat(64),
  buildSha256: 'c'.repeat(64),
  releaseRoot: '/private/stage/releases/aaaaaaaaaaaa',
  planDirectory: '/private/stage/symposium/service',
} as OwnedReleasePlan;
function fixture() {
  const owner = {
    version: 1 as const,
    sourceCommit: plan.sourceCommit,
    configSha256: plan.configSha256,
    buildSha256: plan.buildSha256,
    instanceId: 'original',
    epoch: 2,
    capturedAt: 100,
    parent: { pid: 111, birth: 'parent birth', cwd: plan.releaseRoot },
    app: { pid: 112, birth: 'app birth', cwd: plan.releaseRoot, parentPid: 111 },
  };
  const registry = {
    ...plan,
    state: 'active',
    instanceId: 'original',
    controllerGeneration: 2,
    createdAt: 50,
  };
  const runtime = {
    jobPid: 111,
    parent: { ...owner.parent },
    app: { ...owner.app },
    portPids: [112],
    protectedPids: [900],
  };
  return { owner, registry, runtime };
}
it('recognizes the original parent and its exact app child without equating launchd PID with listener PID', () => {
  const f = fixture();
  expect(() => assertCanonicalOwnerRuntime(plan, f.owner, f.registry, f.runtime)).not.toThrow();
});
it.each([
  'parent-reused',
  'child-reused',
  'adopted-child',
  'foreign-job',
  'production',
  'listener',
  'epoch',
  'registry',
  'source',
])('refuses %s before control', (kind) => {
  const f = fixture();
  if (kind === 'parent-reused') f.runtime.parent.birth = 'another parent';
  if (kind === 'child-reused') f.runtime.app.birth = 'another child';
  if (kind === 'adopted-child') f.runtime.app.parentPid = 999;
  if (kind === 'foreign-job') f.runtime.jobPid = 999;
  if (kind === 'production') f.runtime.protectedPids = [111];
  if (kind === 'listener') f.runtime.portPids = [999];
  if (kind === 'epoch') f.registry.controllerGeneration = 3;
  if (kind === 'registry') f.registry.state = 'retirement_uncertain';
  if (kind === 'source') f.owner.sourceCommit = 'd'.repeat(40);
  expect(() => assertCanonicalOwnerRuntime(plan, f.owner, f.registry, f.runtime)).toThrow();
});
it('requires original native retirement proof, not just absent processes', () => {
  const f = fixture();
  const row = {
    ...f.registry,
    state: 'retired',
    completedAt: 200,
    retirementStateParent: '/private/stage/gateway',
  };
  const receipt = {
    version: 1 as const,
    gatewayStateDirectory: '/private/stage/gateway/gateway-one',
    instanceId: 'original',
    controllerGeneration: 2,
    completedAt: 200,
  };
  expect(() => assertCanonicalOwnerRetired(f.owner, row, receipt, 150)).not.toThrow();
  expect(() => assertCanonicalOwnerRetired(f.owner, row, null, 150)).toThrow();
  expect(() =>
    assertCanonicalOwnerRetired(f.owner, row, { ...receipt, instanceId: 'successor' }, 150),
  ).toThrow();
  expect(() => assertCanonicalOwnerRetired(f.owner, row, receipt, 250)).toThrow();
});
it('retains the operation lock when shutdown is uncertain and never starts a replacement', async () => {
  const calls: string[] = [];
  await expect(
    drainCanonicalOwner({
      lock: async () => {
        calls.push('lock');
      },
      validate: async () => {
        calls.push('validate');
      },
      stop: async () => {
        calls.push('stop');
      },
      verifyRetired: async () => {
        throw Error('native retirement unknown');
      },
      unlock: async () => {
        calls.push('unlock');
      },
      audit: async (state) => {
        calls.push(state);
      },
    }),
  ).rejects.toThrow();
  expect(calls).toEqual(['lock', 'validate', 'stop', 'uncertain']);
});
it('unlocks a pre-control refusal and a confirmed drain', async () => {
  for (const refuse of [true, false]) {
    const calls: string[] = [];
    const result = drainCanonicalOwner({
      lock: async () => {
        calls.push('lock');
      },
      validate: async () => {
        if (refuse) throw Error('identity changed');
      },
      stop: async () => {
        calls.push('stop');
      },
      verifyRetired: async () => {
        calls.push('retired');
      },
      unlock: async () => {
        calls.push('unlock');
      },
      audit: async (state) => {
        calls.push(state);
      },
    });
    if (refuse) await expect(result).rejects.toThrow();
    else await result;
    expect(calls).toEqual(
      refuse ? ['lock', 'refused', 'unlock'] : ['lock', 'stop', 'retired', 'verified', 'unlock'],
    );
  }
});
