import process from 'node:process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OFFLINE_CONTAINMENT_TARGET } from '../../../scripts/lib/staging-offline-containment-contract.mjs';
import { freshAppleHvConfiguration } from '../../../scripts/lib/staging-fresh-applehv.mjs';

export function freshVmInput(
  canonicalRoot = '/stage',
  allocationUUID = '11111111-2222-4333-8444-555555555555',
) {
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
