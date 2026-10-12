import { expect, it, vi } from 'vitest';
import { freshVmInput } from './fixtures/staging-fresh-applehv-plan.js';
import {
  createFreshAppleHvProvisionPlan,
  provisionFreshAppleHvAllocation,
} from '../../scripts/lib/staging-fresh-applehv.mjs';

function input() {
  const vm = freshVmInput(),
    { machine, files, supervisor, ...base } = vm;
  void machine;
  void files;
  void supervisor;
  const sourceImage = {
    path: vm.canonicalRoot + '/symposium/image-sources/' + '2'.repeat(64) + '-arm64.raw.zst',
    dev: 1,
    ino: 80,
    uid: vm.files.ssh.uid,
    mode: 0o600,
    nlink: 1,
    size: 100,
    expandedBytes: 16 * 1073741824,
    compression: 'zstd',
    sha256: '2'.repeat(64),
  };
  base.budget.scratchGrowthGiB = 1;
  return { ...base, sourceImage };
}
it('source-owned provision plan pins one local reviewed image and full logical growth without a start flag', () => {
  const approved = createFreshAppleHvProvisionPlan(input());
  expect(approved.plan.commandArguments).toEqual([
    'machine',
    'init',
    '--image',
    approved.plan.sourceImage.path,
    '--cpus',
    '2',
    '--memory',
    '4096',
    '--disk-size',
    '16',
    '--rootful=false',
    '--volume',
    '/stage:/stage',
    approved.plan.machineName,
  ]);
  expect(approved.plan.commandArguments).not.toContain('--now');
  expect(Object.isFrozen(approved.plan)).toBe(true);
  const bad = input();
  bad.command = 'anything';
  expect(() => createFreshAppleHvProvisionPlan(bad)).toThrow();
});
it('provisioning requires live original guard, current authentication and independently verified image authority', async () => {
  const approvedProvisioningPlan = createFreshAppleHvProvisionPlan(input()),
    events = [];
  const options = {
    allocation: {
      allocationUUID: approvedProvisioningPlan.plan.allocationUUID,
      nativeRoot: approvedProvisioningPlan.plan.nativeRoot,
    },
    canonicalRoot: '/stage',
    sourceRoot: approvedProvisioningPlan.plan.sourceRoot,
    approvedProvisioningPlan,
    assertGuardCurrent: vi.fn(() => events.push('guard')),
    assertAcceptedSource: vi.fn(async () => events.push('source')),
    assertArchivedNativeTopologyCurrent: vi.fn(async () => events.push('archive')),
    assertNativeAuthenticationCurrent: vi.fn(() => events.push('auth')),
    assertApprovedImage: vi.fn(async () => {
      throw Error('no independently reviewed stock image');
    }),
  };
  const effects = {
    verifyPrerequisites: vi.fn(async () => {}),
    initializeOnce: vi.fn(async () => {}),
    capturePlan: vi.fn(async () => ({ measured: 'facts-only' })),
  };
  await expect(provisionFreshAppleHvAllocation(options, effects)).rejects.toThrow();
  expect(effects.initializeOnce).not.toHaveBeenCalled();
  options.assertApprovedImage.mockResolvedValue(undefined);
  options.assertArchivedNativeTopologyCurrent.mockRejectedValueOnce(
    Error('original archive changed'),
  );
  await expect(provisionFreshAppleHvAllocation(options, effects)).rejects.toThrow(/archive/);
  expect(effects.initializeOnce).not.toHaveBeenCalled();
  expect(await provisionFreshAppleHvAllocation(options, effects)).toEqual({
    measured: 'facts-only',
  });
  expect(effects.initializeOnce).toHaveBeenCalledTimes(1);
  expect(events).toContain('auth');
});
it('a JSON approval declaration cannot replace process-local native authority', async () => {
  const approvedProvisioningPlan = createFreshAppleHvProvisionPlan(input());
  await expect(
    provisionFreshAppleHvAllocation({
      approvedProvisioningPlan,
      assertGuardCurrent: true,
      assertAcceptedSource: true,
      assertNativeAuthenticationCurrent: true,
      assertApprovedImage: true,
    }),
  ).rejects.toThrow();
});
it('rejects an image without an independently bounded expanded size', () => {
  const bad = input();
  bad.sourceImage.expandedBytes = 17 * 1073741824;
  expect(() => createFreshAppleHvProvisionPlan(bad)).toThrow();
  const good = input();
  good.sourceImage.expandedBytes = 16 * 1073741824;
  expect(createFreshAppleHvProvisionPlan(good).plan.sourceImage.expandedBytes).toBe(
    16 * 1073741824,
  );
});
