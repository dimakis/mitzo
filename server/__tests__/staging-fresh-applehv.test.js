import process from 'node:process';
import { Buffer } from 'node:buffer';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { OFFLINE_CONTAINMENT_TARGET } from '../../scripts/lib/staging-offline-containment-contract.mjs';
import {
  createFreshAppleHvPlan,
  createFreshAppleHvOwner,
  freshAppleHvConfiguration,
} from '../../scripts/lib/staging-fresh-applehv.mjs';
import { createHash } from 'node:crypto';

export function freshVmInput() {
  const allocationUUID = '11111111-2222-4333-8444-555555555555',
    canonicalRoot = '/stage';
  const nativeRoot = join(canonicalRoot, 'symposium/allocations', allocationUUID),
    home = join(nativeRoot, 'home');
  const machineName = 'mitzo-staging-' + allocationUUID.replaceAll('-', '');
  const data = join(home, '.local/share/containers/podman/machine/applehv');
  const sourceCommit = 'a'.repeat(40),
    sourceRoot = join(canonicalRoot, 'releases', sourceCommit.slice(0, 12));
  const identity = (path, ino, size = 100, mode = 0o644) => ({
    path,
    dev: 1,
    ino,
    uid: process.getuid(),
    mode,
    nlink: 1,
    size,
    sha256: 'b'.repeat(64),
  });
  const disk = identity(join(data, machineName + '-arm64.raw'), 1, 16 * 1073741824);
  const efi = identity(join(data, 'efi-bl-' + machineName), 2);
  const ssh = identity(join(home, '.local/share/containers/podman/machine/machine'), 3, 100, 0o600);
  const configuration = identity(
    join(nativeRoot, 'settings/containers.conf'),
    4,
    Buffer.byteLength(freshAppleHvConfiguration()),
    0o600,
  );
  configuration.sha256 = createHash('sha256').update(freshAppleHvConfiguration()).digest('hex');
  const definition = {
    Name: machineName,
    Version: 1,
    Created: '2026-10-12T12:00:00Z',
    LastUp: '0001-01-01T00:00:00Z',
    Starting: false,
    Resources: { CPUs: 2, Memory: 4096, DiskSize: 16, USBs: [] },
    Swap: 0,
    Rosetta: false,
    Ansible: null,
    GvProxy: { Debug: false, MTU: 0, LogFile: '', PidFile: '', SSHPort: 0 },
    HostUser: { Rootful: false, UID: process.getuid(), HostUserModified: false },
    SSH: { IdentityPath: ssh.path, Port: 62501, RemoteUsername: 'core' },
    ImagePath: { Path: disk.path },
    Mounts: [
      {
        OriginalInput: '',
        ReadOnly: false,
        Source: canonicalRoot,
        Target: canonicalRoot,
        Tag: 'c'.repeat(32),
        Type: 'virtiofs',
        VSockNumber: null,
      },
    ],
    AppleHypervisor: {
      Vfkit: {
        LogLevel: '',
        Endpoint: 'http://localhost:62502',
        BinaryPath: null,
        Rosetta: false,
        VirtualMachine: {
          vcpus: 2,
          memoryBytes: 4294967296,
          bootloader: {
            kind: 'efiBootloader',
            efiVariableStorePath: efi.path,
            createVariableStore: true,
          },
        },
      },
    },
  };
  const node = { path: '/usr/bin/node', sha256: 'd'.repeat(64) };
  return {
    version: 1,
    allocationUUID,
    canonicalRoot,
    nativeRoot,
    sourceRoot,
    sourceCommit,
    sourceTree: 'e'.repeat(40),
    sourceInventory: [
      'scripts/start-staging-allocation-vm.mjs',
      'scripts/lib/staging-fresh-applehv.mjs',
      'scripts/lib/staging-offline-containment-contract.mjs',
      'scripts/lib/staging-resource-budget.mjs',
    ].map((path) => ({ path, sha256: 'f'.repeat(64) })),
    bootUUID: '77C8989D-6420-42B0-BDC5-ACA8A065D98F',
    node,
    helpers: OFFLINE_CONTAINMENT_TARGET.nativeHelpers.map((h) => ({ ...h })),
    machine: {
      path: join(home, '.config/containers/podman/machine/applehv', machineName + '.json'),
      sha256: 'b'.repeat(64),
      definition,
    },
    files: { disk, efi, ssh, configuration },
    oldIdentities: [
      { dev: 1, ino: 20 },
      { dev: 1, ino: 21 },
      { dev: 1, ino: 22 },
    ],
    resourcePolicy: {
      path: 'scripts/lib/staging-resource-budget.mjs',
      sha256: 'f'.repeat(64),
      aggregateGiBLimit: 32,
      minFreeGiB: 20,
    },
    supervisor: {
      plistPath: join(nativeRoot, 'service/com.mitzo.staging.vm.plist'),
      plistSha256: '1'.repeat(64),
      programArguments: [
        node.path,
        join(sourceRoot, 'scripts/start-staging-allocation-vm.mjs'),
        '--plan',
        join(nativeRoot, 'service/fresh-vm-plan.json'),
        '--guard',
        '/private/tmp/mitzo-vm-' + allocationUUID + '.sock',
      ],
      workingDirectory: nativeRoot,
      label: 'com.mitzo.staging.vm',
      keepAlive: false,
      runAtLoad: false,
      initialRuns: 0,
    },
    budget: {
      aggregateGiBLimit: 32,
      minFreeGiB: 20,
      stageGiB: 8,
      quarantineGiB: 2,
      inflightGiB: 1,
      candidateAllocatedGiB: 0,
      releaseGrowthGiB: 2,
      scratchGrowthGiB: 0,
      additionalGrowthGiB: 0,
      diskFreeGiB: 50,
    },
  };
}
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
it('stale guard or accepted source cannot cross a native start boundary', async () => {
  const f = ownerFixture();
  f.assertGuardCurrent.mockImplementation(() => {
    throw Error('guard expired');
  });
  await expect(f.owner.verifyStopped()).rejects.toThrow();
  expect(f.effects.startSupervisor).not.toHaveBeenCalled();
});
