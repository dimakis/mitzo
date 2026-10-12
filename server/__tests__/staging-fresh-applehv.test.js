import process from 'node:process';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  createFreshAppleHvPlan,
  createFreshAppleHvOwner,
  validateFreshAppleHvMutableMachine,
  parseFreshAppleHvOpenFiles,
  validateFreshAppleHvNativeArguments,
} from '../../scripts/lib/staging-fresh-applehv.mjs';

import { freshVmInput } from './fixtures/staging-fresh-applehv-plan.js';

it('pins a bounded stock fresh allocation and freezes its complete reviewable digest', () => {
  const approved = createFreshAppleHvPlan(freshVmInput());
  expect(approved.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(approved.plan.projectedGrowthGiB).toBe(18);
  expect(approved.plan.projectedAggregateGiB).toBe(29);
  expect(Object.isFrozen(approved.plan.machine.definition)).toBe(true);
  expect(createFreshAppleHvPlan(freshVmInput()).sha256).toBe(approved.sha256);
});
it('binds a larger reviewed policy to accepted source bytes and all measured commitments', () => {
  const input = freshVmInput();
  input.resourcePolicy.aggregateGiBLimit = input.budget.aggregateGiBLimit = 48;
  input.budget.stageGiB = 28.151802;
  input.budget.quarantineGiB = input.budget.inflightGiB = 0;
  input.budget.scratchGrowthGiB = 1;
  input.budget.diskFreeGiB = 53.24353;
  expect(createFreshAppleHvPlan(input).plan.projectedAggregateGiB).toBeCloseTo(47.151802);
  input.budget.additionalGrowthGiB = 2;
  expect(() => createFreshAppleHvPlan(input)).toThrow(/retention/);
  input.budget.additionalGrowthGiB = 0;
  input.resourcePolicy.sha256 = '0'.repeat(64);
  expect(() => createFreshAppleHvPlan(input)).toThrow(/policy/);
});
it('full virtual disk capacity participates in admission; unknown pressure and disk retention never become cheap sparse growth', () => {
  const input = freshVmInput();
  input.budget.stageGiB = 28.151802;
  input.budget.quarantineGiB = 0;
  expect(() => createFreshAppleHvPlan(input)).toThrow(/retention/);
  input.budget.stageGiB = 8;
  input.budget.diskFreeGiB = 30;
  expect(() => createFreshAppleHvPlan(input)).toThrow(/headroom/);
  input.budget.diskFreeGiB = 50;
  input.budget.inflightGiB = null;
  expect(() => createFreshAppleHvPlan(input)).toThrow();
});
it('refuses reused disk identity, old endpoint, broad mounts, nonstock helper and auto restart', () => {
  for (const mutate of [
    (p) => {
      p.files.disk.ino = 20;
    },
    (p) => {
      p.machine.definition.AppleHypervisor.Vfkit.Endpoint = 'http://localhost:62752';
    },
    (p) => {
      p.machine.definition.Mounts[0].Source = '/';
    },
    (p) => {
      p.helpers[0].sha256 = '0'.repeat(64);
    },
    (p) => {
      p.supervisor.keepAlive = true;
    },
    (p) => {
      p.machine.definition.Resources.Memory = 8192;
    },
  ]) {
    const input = freshVmInput();
    mutate(input);
    expect(() => createFreshAppleHvPlan(input)).toThrow();
  }
});
it('stock first boot may create only the exact expected-absent EFI store under its pinned private parent', () => {
  const input = freshVmInput(),
    path = input.files.efi.path;
  input.files.efi = {
    path,
    state: 'expected-absent',
    parent: { path: join(path, '..'), dev: 1, ino: 50, uid: process.getuid(), mode: 0o755 },
  };
  expect(createFreshAppleHvPlan(input).plan.files.efi.state).toBe('expected-absent');
  input.files.efi.parent.path = '/old/quarantine';
  expect(() => createFreshAppleHvPlan(input)).toThrow();
});
it('mutable LastUp is accepted only within the actual original start interval and all other VM fields stay pinned', () => {
  const plan = createFreshAppleHvPlan(freshVmInput()).plan;
  const current = globalThis.structuredClone(plan.machine.definition);
  const startedAt = Date.parse('2026-10-12T12:00:00Z'),
    observedAt = startedAt + 1000;
  current.LastUp = new Date(startedAt + 500).toISOString();
  expect(() =>
    validateFreshAppleHvMutableMachine(plan, current, { startedAt, observedAt }),
  ).not.toThrow();
  current.LastUp = '2020-01-01T00:00:00Z';
  expect(() =>
    validateFreshAppleHvMutableMachine(plan, current, { startedAt, observedAt }),
  ).toThrow();
  current.LastUp = new Date(startedAt + 500).toISOString();
  current.ImagePath.Path = '/old/retained.raw';
  expect(() =>
    validateFreshAppleHvMutableMachine(plan, current, { startedAt, observedAt }),
  ).toThrow();
});
it('open-backing observations bind the exact lsof process and device/inode records', () => {
  expect(parseFreshAppleHvOpenFiles('p43\nf10\nD0x1\ni99\nn/new.raw\n', 43)).toEqual([
    { D: '0x1', i: '99', n: '/new.raw' },
  ]);
  for (const text of [
    'p44\nf10\nD0x1\ni99\nn/new.raw\n',
    'p43\nf10\np99\nn/new.raw\n',
    'not an observation',
  ])
    expect(() => parseFreshAppleHvOpenFiles(text, 43)).toThrow();
});
it('actual vfkit command proves one exact raw disk and mount, not a matching path prefix', () => {
  const plan = createFreshAppleHvPlan(freshVmInput()).plan,
    machine = plan.machine.definition;
  const command = [
    plan.helpers[1].path,
    '--cpus',
    '2',
    '--memory',
    '4096',
    '--bootloader',
    'efi,variable-store=' + plan.files.efi.path + ',create',
    '--device',
    'virtio-blk,path=' + plan.files.disk.path,
    '--device',
    'virtio-fs,sharedDir=' + plan.canonicalRoot + ',mountTag=' + machine.Mounts[0].Tag,
    '--restful-uri',
    'tcp://localhost:62502',
  ].join(' ');
  expect(() => validateFreshAppleHvNativeArguments(plan, command, 'vfkit')).not.toThrow();
  for (const changed of [
    command.replace('sharedDir=/stage,', 'sharedDir=/stage-quarantine,'),
    command + ' --device virtio-blk,path=/old.raw',
    command.replace('--cpus 2', '--cpus 8'),
  ])
    expect(() => validateFreshAppleHvNativeArguments(plan, changed, 'vfkit')).toThrow();
});
function ownerFixture() {
  const approvedVmPlan = createFreshAppleHvPlan(freshVmInput()),
    events = [];
  const supervisor = { pid: 42, birth: 'original supervisor birth' },
    vfkit = { pid: 43, birth: 'original vfkit birth' },
    gvproxy = { pid: 44, birth: 'original gvproxy birth' };
  const effects = {
    verifyStopped: vi.fn(async () => {
      events.push('stopped');
      return { observationSha256: '2'.repeat(64) };
    }),
    startSupervisor: vi.fn(async ({ authorize }) => {
      events.push('start');
      await authorize(supervisor);
      return { supervisor, vfkit, gvproxy, startedAt: 1791806400000 };
    }),
    verifyRunning: vi.fn(async (lineage) => {
      events.push('running');
      return { observationSha256: '3'.repeat(64), ...lineage };
    }),
    retain: vi.fn(async () => {
      events.push('retained');
    }),
  };
  const assertGuardCurrent = vi.fn(() => {
      events.push('guard');
    }),
    assertAcceptedSource = vi.fn(async () => {
      events.push('accepted');
    });
  const owner = createFreshAppleHvOwner(
    {
      allocation: {
        allocationUUID: approvedVmPlan.plan.allocationUUID,
        nativeRoot: approvedVmPlan.plan.nativeRoot,
      },
      canonicalRoot: '/stage',
      sourceRoot: approvedVmPlan.plan.sourceRoot,
      approvedVmPlan,
      assertGuardCurrent,
      assertAcceptedSource,
    },
    effects,
  );
  return { owner, effects, events, approvedVmPlan, assertGuardCurrent };
}
it('a saved plan cannot reopen running capability; only one guarded original start establishes lineage', async () => {
  const f = ownerFixture();
  await expect(f.owner.verifyRunning()).rejects.toThrow(/original/);
  await f.owner.verifyStopped();
  await f.owner.startOnce();
  expect(await f.owner.verifyRunning()).toMatchObject({ observationSha256: '3'.repeat(64) });
  await expect(f.owner.startOnce()).rejects.toThrow(/once/);
  expect(f.effects.startSupervisor).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event === 'guard').length).toBeGreaterThan(2);
});
it('uncertain start is retained and cannot be automatically replayed or stopped', async () => {
  const f = ownerFixture();
  f.effects.startSupervisor.mockRejectedValue(Error('launch result uncertain'));
  await f.owner.verifyStopped();
  await expect(f.owner.startOnce()).rejects.toThrow();
  await f.owner.retain();
  await expect(f.owner.startOnce()).rejects.toThrow(/once/);
  await expect(f.owner.verifyRunning()).rejects.toThrow(/original/);
  expect(f.effects.startSupervisor).toHaveBeenCalledTimes(1);
  expect(f.effects.retain).toHaveBeenCalledTimes(1);
});
it('concurrent calls cannot pass the one-start latch while awaiting source verification', async () => {
  const f = ownerFixture();
  await f.owner.verifyStopped();
  const calls = await Promise.allSettled([f.owner.startOnce(), f.owner.startOnce()]);
  expect(calls.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.effects.startSupervisor).toHaveBeenCalledTimes(1);
});
it('stale guard or accepted source cannot cross a native start boundary', async () => {
  const f = ownerFixture();
  f.assertGuardCurrent.mockImplementation(() => {
    throw Error('guard expired');
  });
  await expect(f.owner.verifyStopped()).rejects.toThrow();
  expect(f.effects.startSupervisor).not.toHaveBeenCalled();
});
it('synchronous current capability needs original verified lineage and the live handoff fence', async () => {
  const f = ownerFixture();
  f.effects.assertRunningCurrent = vi.fn(() => ({ vmMemoryMiB: 4096, vmCpus: 2 }));
  expect(() => f.owner.assertRunningCurrent()).toThrow();
  await f.owner.verifyStopped();
  await f.owner.startOnce();
  expect(f.owner.assertRunningCurrent()).toEqual({ vmMemoryMiB: 4096, vmCpus: 2 });
  f.assertGuardCurrent.mockImplementation(() => {
    throw Error('original custodian lost');
  });
  expect(() => f.owner.assertRunningCurrent()).toThrow();
  await f.owner.retain();
  expect(() => f.owner.assertRunningCurrent()).toThrow();
});
