import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
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
  const host = new SqliteArtifactLeaseHost(
    join(root, 'leases'),
    { verifyGateway: async () => {}, verifyMount: async () => {} },
    async () => ({
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
    }),
  );
  const lease = await acquireSymposiumArtifactLease(host, request);
  host.markCreationStarted(lease.token, lease.revision, 'seat');
  host.bindSandbox(lease.token, lease.revision, 'seat', 'physical');
  const command = vi.fn(async (args: readonly string[]) => (args[0] === 'start' ? '[]' : ''));
  const verifyCustody = vi.fn(async () => {});
  const options = {
    databasePath: join(root, 'snapshots'),
    leaseHost: host,
    verifyCustody,
    command,
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
it('quarantines failed cleanup durably across restart', async () => {
  const f = await fixture();
  f.command.mockImplementation(async (args) => {
    if (args[0] === 'rm') throw Error('uncertain');
    return args[0] === 'start' ? '[]' : '';
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
