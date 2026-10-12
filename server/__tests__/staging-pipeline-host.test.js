import { expect, it, vi } from 'vitest';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMacStagingResources,
  createStagingPipelineEffects,
  observeMacStagingResources,
} from '../../scripts/lib/staging-pipeline-host.mjs';
it.runIf(process.platform === 'darwin')(
  'refuses any unqualified new native allocation before inferring legacy VM absence',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-resource-fence-'));
    const run = vi.fn();
    try {
      const allocations = join(root, 'symposium/allocations');
      mkdirSync(join(allocations, 'fresh-uuid'), { recursive: true });
      expect(() => observeMacStagingResources(root, run)).toThrow('actual original VM owner');
      expect(run).not.toHaveBeenCalled();
      rmSync(allocations, { recursive: true });
      symlinkSync('/unknown/native/storage', allocations);
      expect(() => observeMacStagingResources(root, run)).toThrow('actual original VM owner');
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);
const output = {
  pressure: '1',
  free: 'System-wide memory free percentage: 45%',
  swap: 'vm.swapusage: total = 1024.00M  used = 0.25M  free = 1023.75M  (encrypted)',
  disk: 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/disk 100000000 20000000 80000000 20% /',
  usage: '20971520\t/stage\n1048576\t/archive',
  vm: { Resources: { Memory: 4096, CPUs: 2 } },
};
it('parses pressure and aggregate staging/quarantine disk use without confusing free pages with pressure', () => {
  expect(parseMacStagingResources(output)).toMatchObject({
    pressureLevel: 1,
    memoryFreePercent: 45,
    swapUsedMiB: 0.25,
    stagingGiB: 21,
    vmMemoryMiB: 4096,
    vmCpus: 2,
  });
  for (const field of ['pressure', 'free', 'swap', 'disk', 'usage'])
    expect(() => parseMacStagingResources({ ...output, [field]: 'unknown' })).toThrow();
});
it('uses only canonical exact-commit prepare/plan/apply with bounded build heap', async () => {
  const run = vi.fn((_program, args) => {
    if (args[0] === 'check') return JSON.stringify({ safe: true, expected: 'a'.repeat(40) });
    return '{}';
  });
  const e = createStagingPipelineEffects({ root: '/stage', run });
  const sha = 'a'.repeat(40),
    old = 'b'.repeat(40);
  await e.prepare(sha);
  await e.plan(sha, old);
  await e.deploy(sha, old);
  const controller = fileURLToPath(new URL('../../scripts/staging.mjs', import.meta.url));
  expect(run.mock.calls.map(([program, args]) => [program, args])).toEqual([
    [process.execPath, [controller, 'prepare', '--commit', sha]],
    [process.execPath, [controller, 'deploy', '--commit', sha, '--expected-current', old]],
    [
      process.execPath,
      [controller, 'deploy', '--commit', sha, '--expected-current', old, '--apply'],
    ],
  ]);
  expect(run.mock.calls.every((c) => c[2].heapMiB === 2048)).toBe(true);
});
it('requires accepted ancestry and binds an advanced baseline to the actual main tip', async () => {
  const sha = 'a'.repeat(40),
    tip = 'b'.repeat(40);
  const run = vi.fn((_program, args) =>
    args[1].endsWith('/commits/main')
      ? JSON.stringify({ sha: tip })
      : JSON.stringify({ status: 'ahead', base_commit: { sha } }),
  );
  const e = createStagingPipelineEffects({ root: '/stage', run });
  expect(await e.baseline(sha)).toBe(tip);
  run.mockReturnValue(JSON.stringify({ status: 'diverged', base_commit: { sha } }));
  await expect(e.baseline(sha)).rejects.toThrow();
});
it('readiness test invokes no provider and reports a normal HTTP failure as settled', async () => {
  const run = vi.fn(() => JSON.stringify({ safe: true, expected: 'a'.repeat(40) }));
  for (const ok of [true, false]) {
    const fetch = vi.fn(async () => ({ ok }));
    const e = createStagingPipelineEffects({ root: '/stage', run, fetch });
    expect(await e.test('http-readiness', 'a'.repeat(40))).toEqual({
      outcome: ok ? 'passed' : 'failed',
      cleanupConfirmed: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://mitzo-staging.localhost:3190/',
      expect.objectContaining({ redirect: 'error' }),
    );
  }
  const e = createStagingPipelineEffects({ root: '/stage', run });
  await expect(e.test('model-test', 'a'.repeat(40))).rejects.toThrow();
});
it('candidate probe accepts only the exact canonical read-only validation result', async () => {
  const target = 'a'.repeat(40);
  const run = vi.fn(() => JSON.stringify({ prepared: false, source: target, growthGiB: 6 }));
  const e = createStagingPipelineEffects({ run });
  expect(await e.prepared(target)).toEqual({ reused: false, growthGiB: 6 });
  expect(run.mock.calls[0][1].slice(1)).toEqual(['prepare', '--commit', target, '--check-only']);
  run.mockReturnValue(JSON.stringify({ prepared: '/stage/release', source: target, reused: true }));
  expect(await e.prepared(target)).toEqual({ reused: true, growthGiB: 0 });
  for (const result of [
    { prepared: true, source: target },
    { prepared: false, source: target },
    { prepared: false, source: target, growthGiB: 1 },
    { prepared: '/stage/release', source: 'b'.repeat(40), reused: true },
  ]) {
    run.mockReturnValue(JSON.stringify(result));
    await expect(e.prepared(target)).rejects.toThrow();
  }
});
it('feature dispatch uses authenticated stage selection and exact plan/source/owner evidence', async () => {
  const request = {
    version: 2,
    id: 'feature',
    suite: 'profile-tools-v1',
    profileId: 'stage-profile',
    enrollmentRevision: 'e'.repeat(64),
  };
  const source = 'a'.repeat(40),
    token = { epoch: 1, requestId: 'feature', owner: 'worker', nonce: 'nonce' };
  const plan = {
    version: 1,
    requestId: 'feature',
    sourceCommit: source,
    profileId: 'stage-profile',
    enrollmentRevision: 'e'.repeat(64),
    ownerInstance: 'owner',
    chargedAccount: 'stage-account',
    selectedModel: 'gpt-6.1-luna',
  };
  const featureResult = {
    version: 1,
    profileId: 'stage-profile',
    enrollmentRevision: 'e'.repeat(64),
    planSha256: 'f'.repeat(64),
    ownerInstance: 'owner',
    runId: 'run',
    ownerReceiptSha256: 'd'.repeat(64),
  };
  const profiles = {
    lookupEnrollment: vi.fn(async () => ({
      profileId: request.profileId,
      enrollmentRevision: request.enrollmentRevision,
    })),
    plan: vi.fn(async () => ({ plan, planSha256: 'f'.repeat(64) })),
    run: vi.fn(async () => ({
      outcome: 'passed',
      sourceCommit: source,
      cleanupConfirmed: true,
      featureResult,
    })),
  };
  const effects = createStagingPipelineEffects({ profiles });
  expect(await effects.lookupEnrollment(request.profileId)).toEqual({
    profileId: request.profileId,
    enrollmentRevision: request.enrollmentRevision,
  });
  expect(await effects.featurePlan(request, source)).toEqual({
    publicPlan: plan,
    planSha256: 'f'.repeat(64),
  });
  expect(
    await effects.test('profile-tools-v1', source, {
      request,
      token,
      plan,
      planSha256: 'f'.repeat(64),
    }),
  ).toEqual({ outcome: 'passed', cleanupConfirmed: true, featureReceipt: featureResult });
  expect(profiles.run).toHaveBeenCalledWith(plan, token);
  profiles.plan.mockResolvedValue({
    plan: { ...plan, sourceCommit: 'b'.repeat(40) },
    planSha256: 'f'.repeat(64),
  });
  await expect(effects.featurePlan(request, source)).rejects.toThrow();
  profiles.run.mockResolvedValue({
    outcome: 'passed',
    sourceCommit: source,
    cleanupConfirmed: true,
    featureResult: { ...featureResult, ownerInstance: 'successor' },
  });
  await expect(
    effects.test('profile-tools-v1', source, { request, token, plan, planSha256: 'f'.repeat(64) }),
  ).rejects.toThrow();
});
it('uninstalled feature owner authority fails closed without provider or fixture calls', async () => {
  const effects = createStagingPipelineEffects({ root: '/nonexistent-stage-root' });
  await expect(effects.lookupEnrollment('stage-profile')).rejects.toThrow();
});
