import { expect, it, vi } from 'vitest';
import {
  parseMacStagingResources,
  createStagingPipelineEffects,
} from '../../scripts/lib/staging-pipeline-host.mjs';
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
  expect(run.mock.calls.map(([program, args]) => [program, args])).toEqual([
    ['/stage/bin/mitzo-staging', ['prepare', '--commit', sha]],
    ['/stage/bin/mitzo-staging', ['deploy', '--commit', sha, '--expected-current', old]],
    ['/stage/bin/mitzo-staging', ['deploy', '--commit', sha, '--expected-current', old, '--apply']],
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
