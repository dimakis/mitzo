import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteArtifactLeaseHost, ArtifactPodmanContext } from '../symposium-artifact-host.js';
import {
  acquireSymposiumArtifactLease,
  type ArtifactLeaseRequest,
} from '../symposium-artifact-lease.js';
import { ArtifactSnapshotObserver } from '../symposium-artifact-snapshot.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-observe-'));
  roots.push(root);
  const request: ArtifactLeaseRequest = {
    sessionId: 's',
    workspaceId: 'w',
    seatId: 'a',
    volumeName: 'v',
    volumeGeneration: 'g',
    driver: 'podman',
    access: 'writer',
  };
  const command = vi.fn(async (args: readonly string[]): Promise<string> =>
    args[0] === 'start'
      ? '[]'
      : args[0] === 'inspect'
        ? '[{"State":{"Running":false,"ExitCode":0}}]'
        : '',
  );
  const host = new SqliteArtifactLeaseHost(
    join(root, 'leases'),
    { verifyGateway: async () => {}, verifyMount: async () => {} },
    new ArtifactPodmanContext(async (args) =>
      args[0] === 'volume'
        ? JSON.stringify({
            Name: 'v',
            Driver: 'local',
            Options: {},
            Labels: {
              'openshell.ai/sandbox-attachable': 'true',
              'openshell.ai/sandbox-attachable-workspace': 'w',
              'mitzo.symposium.purpose': 'artifacts',
              'mitzo.symposium.session': 's',
              'mitzo.symposium.workspace': 'w',
              'mitzo.symposium.generation': 'g',
            },
          })
        : command(args),
    ),
  );
  const lease = await acquireSymposiumArtifactLease(host, request);
  host.markCreationStarted(lease.token, lease.revision, 'seat');
  host.bindSandbox(lease.token, lease.revision, 'seat', 'physical');
  const verifyCustody = vi.fn(async () => {});
  const options = {
    databasePath: join(root, 'snapshots'),
    gateway: {
      name: 'gateway',
      workspace: 'w',
      endpoint: 'https://localhost:18800',
      launchDirectoryHash: 'a'.repeat(64),
    },
    leaseHost: host,
    verifyCustody,
  };
  const observer = new ArtifactSnapshotObserver(options);
  return {
    host,
    lease,
    request,
    command,
    verifyCustody,
    observer,
    options,
    input: { request, sandboxName: 'seat', sandboxId: 'physical' },
  };
}
it('records an empty observation only after exact verifier cleanup and preserves it across restart', async () => {
  const f = await fixture();
  const receipt = await f.observer.observe(f.input);
  expect(receipt).toMatchObject({
    kind: 'artifact_snapshot_observation',
    consistency: 'unfenced_observation',
    manifest: [],
    leaseRevision: f.lease.revision,
  });
  const create = f.command.mock.calls.find(([args]) => args[0] === 'create')![0];
  expect(create).toContain('--network=none');
  expect(create).toContain('--read-only');
  expect(create.some((arg) => arg.startsWith('--user'))).toBe(false);
  expect(create).toContain('--cap-drop=ALL');
  expect(create).toContain('--pull=never');
  expect(create).toContain(
    'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
  );
  expect(create).toContain('type=volume,src=v,dst=/sandbox/symposium-artifacts,readonly');
  expect(create).not.toContain('git');
  const name = create[create.indexOf('--name') + 1];
  expect(f.command.mock.calls.at(-1)![0]).toEqual(['rm', '--force', '--ignore', name]);
  f.observer.close();
  const reopened = new ArtifactSnapshotObserver(f.options);
  expect(reopened.read(receipt.revision)).toEqual(receipt);
  reopened.close();
  f.host.close();
});
it('cleans an uncertain create and records no receipt', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (args) => {
    if (args[0] === 'create') throw Error('ambiguous');
    return '';
  });
  await expect(f.observer.observe(f.input)).rejects.toThrow();
  expect(f.command.mock.calls.at(-1)![0][0]).toBe('rm');
  expect(f.observer.list()).toEqual([]);
  f.observer.close();
  f.host.close();
});
it('retains ambiguous create reservation after successful removal and a late create', async () => {
  const f = await fixture();
  let lateVerifierExists = false;
  f.command.mockImplementation(async (args) => {
    if (args[0] === 'create') throw Error('transport lost before response');
    if (args[0] === 'rm') expect(lateVerifierExists).toBe(false);
    return '';
  });
  await expect(f.observer.observe(f.input)).rejects.toThrow();
  lateVerifierExists = true;
  f.observer.close();
  const restarted = new ArtifactSnapshotObserver(f.options);
  f.command.mockClear();
  await expect(restarted.observe(f.input)).rejects.toThrow('reconciliation');
  expect(f.command).not.toHaveBeenCalled();
  expect(restarted.list()).toEqual([]);
  restarted.close();
  f.host.close();
});
it('quarantines failed cleanup durably across restart', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (args) => {
    if (args[0] === 'rm') throw Error('uncertain');
    return args[0] === 'start'
      ? '[]'
      : args[0] === 'inspect'
        ? '[{"State":{"Running":false,"ExitCode":0}}]'
        : '';
  });
  await expect(f.observer.observe(f.input)).rejects.toThrow('cleanup');
  f.observer.close();
  const restarted = new ArtifactSnapshotObserver(f.options);
  f.command.mockClear();
  await expect(restarted.observe(f.input)).rejects.toThrow('reconciliation');
  expect(f.command).not.toHaveBeenCalled();
  restarted.close();
  f.host.close();
});
it('rejects malformed verifier paths and custody loss without persistence', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (args) =>
    args[0] === 'start'
      ? '[{"path":"../escape","executable":false,"bytes":0,"sha256":"' + 'a'.repeat(64) + '"}]'
      : '',
  );
  await expect(f.observer.observe(f.input)).rejects.toThrow();
  expect(f.observer.list()).toEqual([]);
  f.verifyCustody.mockRejectedValue(Error('custody lost'));
  f.command.mockClear();
  await expect(f.observer.observe(f.input)).rejects.toThrow();
  expect(f.command).not.toHaveBeenCalled();
  f.observer.close();
  f.host.close();
});
it('rejects a nonzero verifier exit even when stdout is a valid empty manifest', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (args) =>
    args[0] === 'start'
      ? '[]'
      : args[0] === 'inspect'
        ? '[{"State":{"Running":false,"ExitCode":2}}]'
        : '',
  );
  await expect(f.observer.observe(f.input)).rejects.toThrow('exit');
  expect(f.observer.list()).toEqual([]);
  f.observer.close();
  f.host.close();
});
it('rejects lease drift after scanning and removes the verifier', async () => {
  const f = await fixture();
  const original = f.host.requireBoundSandboxLease.bind(f.host);
  let count = 0;
  vi.spyOn(f.host, 'requireBoundSandboxLease').mockImplementation(async (...args) => {
    const lease = await original(...args);
    return ++count > 1 ? { ...lease, revision: 'changed' } : lease;
  });
  await expect(f.observer.observe(f.input)).rejects.toThrow('lease');
  expect(f.observer.list()).toEqual([]);
  expect(f.command.mock.calls.at(-1)![0][0]).toBe('rm');
  f.observer.close();
  f.host.close();
});
it('refuses a legacy lease host with no verifier command context', () => {
  const host = new SqliteArtifactLeaseHost(':memory:', {
    verifyGateway: async () => {},
    verifyMount: async () => {},
  });
  try {
    expect(
      () =>
        new ArtifactSnapshotObserver({
          databasePath: ':memory:',
          leaseHost: host,
          verifyCustody: async () => {},
          gateway: {
            name: 'g',
            workspace: 'w',
            endpoint: 'https://localhost:1',
            launchDirectoryHash: 'a'.repeat(64),
          },
        }),
    ).toThrow('context');
  } finally {
    host.close();
  }
});

it.each(['😀.txt', 'nested/𐐀.txt'])(
  'persists valid supplementary Unicode path %s',
  async (path) => {
    const f = await fixture();
    const manifest = [{ path, executable: false, bytes: 0, sha256: 'a'.repeat(64) }];
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args) =>
      args[0] === 'start' ? JSON.stringify(manifest) : original(args),
    );
    const receipt = await f.observer.observe(f.input);
    expect(receipt.manifest).toEqual(manifest);
    expect(f.observer.read(receipt.revision)?.manifest).toEqual(manifest);
    f.observer.close();
    f.host.close();
  },
);
it('still rejects an unpaired surrogate in a verifier path', async () => {
  const f = await fixture();
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (args) =>
    args[0] === 'start'
      ? JSON.stringify([
          {
            path: String.fromCharCode(0xd800),
            executable: false,
            bytes: 0,
            sha256: 'a'.repeat(64),
          },
        ])
      : original(args),
  );
  await expect(f.observer.observe(f.input)).rejects.toThrow();
  expect(f.command.mock.calls.at(-1)![0][0]).toBe('rm');
  f.observer.close();
  f.host.close();
});
