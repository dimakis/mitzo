import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireSymposiumArtifactLease,
  artifactDriverConfigForLease,
  type ArtifactLeaseRequest,
} from '../symposium-artifact-lease.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const request: ArtifactLeaseRequest = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  seatId: 'writer',
  volumeName: 'artifacts-1',
  volumeGeneration: 'gen-1',
  driver: 'podman',
  access: 'writer',
};
const volume = {
  Name: request.volumeName,
  Driver: 'local',
  Options: {},
  Labels: {
    'openshell.ai/sandbox-attachable': 'true',
    'openshell.ai/sandbox-attachable-workspace': request.workspaceId,
    'mitzo.symposium.purpose': 'artifacts',
    'mitzo.symposium.session': request.sessionId,
    'mitzo.symposium.workspace': request.workspaceId,
    'mitzo.symposium.generation': request.volumeGeneration,
  },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'symposium-artifact-host-'));
  roots.push(root);
  const path = join(root, 'leases.sqlite');
  const verifyGateway = vi.fn(async () => {});
  const verifyMount = vi.fn(async () => {});
  const verifyDeleted = vi.fn(async () => {});
  const runner = vi.fn(async () => [volume]);
  const evidence = { verifyGateway, verifyMount, verifyDeleted };
  const a = new SqliteArtifactLeaseHost(path, evidence, runner);
  const b = new SqliteArtifactLeaseHost(path, evidence, runner);
  return { a, b, evidence, runner };
}

describe('durable artifact host', () => {
  it('serializes one writer across processes while allowing a read-only reviewer', async () => {
    const { a, b, evidence } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).rejects.toThrow('already has a writer');
      const reviewer = await acquireSymposiumArtifactLease(b, {
        ...request,
        seatId: 'reviewer',
        access: 'reviewer',
      });
      expect(await artifactDriverConfigForLease(b, reviewer)).toMatchObject({
        podman: { mounts: [{ read_only: true }] },
      });
      expect(evidence.verifyGateway).toHaveBeenCalledOnce();
      expect(await b.inspectLease(writer.token)).toEqual(writer);
      a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      expect(await acquireSymposiumArtifactLease(b, request)).toEqual(writer);
      expect(() =>
        b.markCreationStarted(writer.token, writer.revision, 'seat-writer'),
      ).not.toThrow();
      expect(() =>
        b.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1'),
      ).not.toThrow();
      await expect(
        Promise.resolve().then(() =>
          a.bindSandbox(writer.token, writer.revision, 'other', 'physical-2'),
        ),
      ).rejects.toThrow('cannot be rebound');
      evidence.verifyDeleted.mockRejectedValueOnce(new Error('still present'));
      await expect(
        a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {}),
      ).rejects.toThrow('still present');
      expect(await b.inspectLease(writer.token)).toEqual(writer);
      await expect(a.release(writer.token)).rejects.toThrow('gateway and physical');
      await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
      expect(evidence.verifyDeleted).toHaveBeenCalledWith('seat-writer', 'physical-1');
      expect(await b.inspectLease(writer.token)).toBeNull();
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).resolves.toMatchObject({ request: { seatId: 'writer-2' } });
    } finally {
      a.close();
      b.close();
    }
  });

  it('rejects volume bind options and gateway denial before a mount can be used', async () => {
    const { a, b, evidence, runner } = fixture();
    try {
      runner.mockResolvedValueOnce([{ ...volume, Options: { device: '/host' } }]);
      await expect(acquireSymposiumArtifactLease(a, request)).rejects.toThrow('host-backed');
      const lease = await acquireSymposiumArtifactLease(a, request);
      evidence.verifyGateway.mockRejectedValueOnce(new Error('driver config disabled'));
      await expect(artifactDriverConfigForLease(a, lease)).rejects.toThrow(
        'driver config disabled',
      );
    } finally {
      a.close();
      b.close();
    }
  });

  it('retains a writer across a crash after create starts but before physical binding', async () => {
    const { a, b, evidence } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      a.close(); // Process dies before the create response and bindSandbox.

      await expect(b.release(writer.token)).rejects.toThrow('may be in flight');
      expect(await acquireSymposiumArtifactLease(b, request)).toEqual(writer);
      expect(() => b.markCreationStarted(writer.token, writer.revision, 'seat-writer')).toThrow(
        'cannot be changed',
      );
      expect(evidence.verifyDeleted).not.toHaveBeenCalled();
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).rejects.toThrow('already has a writer');
      expect(await b.inspectLease(writer.token)).toEqual(writer);

      // A recovered create can bind only the reserved target, then release only
      // after exact physical deletion is attested.
      expect(() =>
        b.bindSandbox(writer.token, writer.revision, 'other-seat', 'physical-1'),
      ).toThrow('cannot be rebound');
      b.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      evidence.verifyDeleted.mockRejectedValueOnce(new Error('still present'));
      await expect(
        b.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {}),
      ).rejects.toThrow('still present');
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).rejects.toThrow('already has a writer');
      await b.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
      expect(evidence.verifyDeleted).toHaveBeenCalledWith('seat-writer', 'physical-1');
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).resolves.toMatchObject({ request: { seatId: 'writer-2' } });
    } finally {
      b.close();
    }
  });

  it('releases a reservation safely before any create intent and forbids an unmarked bind', async () => {
    const { a, b } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      expect(() =>
        a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1'),
      ).toThrow('cannot be rebound');
      await b.release(writer.token);
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'writer-2' }),
      ).resolves.toMatchObject({ request: { seatId: 'writer-2' } });
    } finally {
      a.close();
      b.close();
    }
  });

  it('keeps an unstarted writer until exact request and repeat gateway absence are proven', async () => {
    const { a, b } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      const absent = vi.fn(async () => {});
      await expect(
        b.releaseUnstartedForAbsentSeat({ ...request, workspaceId: 'other' }, absent),
      ).rejects.toThrow('request changed');
      expect(absent).not.toHaveBeenCalled();
      const replaced = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('sandbox appeared'));
      await expect(b.releaseUnstartedForAbsentSeat(request, replaced)).rejects.toThrow(
        'sandbox appeared',
      );
      expect(await a.inspectLease(writer.token)).toEqual(writer);
      await b.releaseUnstartedForAbsentSeat(request, absent);
      expect(absent).toHaveBeenCalledTimes(2);
      expect(await a.inspectLease(writer.token)).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  it('retains a writer when gateway absence is ambiguous and permits exact rotation after both proofs', async () => {
    const { a, b, evidence } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      const verifyGatewayAbsent = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('gateway replacement appeared'));
      await expect(
        a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', verifyGatewayAbsent),
      ).rejects.toThrow('gateway replacement appeared');
      expect(evidence.verifyDeleted).toHaveBeenCalledOnce();
      expect(await b.inspectLease(writer.token)).toEqual(writer);
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'next' }),
      ).rejects.toThrow('already has a writer');
      await expect(
        a.releaseBoundSandbox(
          { ...request, seatId: 'other' },
          'seat-writer',
          'physical-1',
          async () => {},
        ),
      ).rejects.toThrow('identity is unavailable');
      await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
      await expect(
        acquireSymposiumArtifactLease(b, { ...request, seatId: 'next' }),
      ).resolves.toMatchObject({ request: { seatId: 'next' } });
    } finally {
      a.close();
      b.close();
    }
  });

  it('retains a stopped sandbox lease without deletion evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'symposium-artifact-stop-'));
    roots.push(root);
    const host = new SqliteArtifactLeaseHost(
      join(root, 'leases.sqlite'),
      {
        verifyGateway: async () => undefined,
        verifyMount: async () => undefined,
      },
      async () => [volume],
    );
    try {
      const lease = await acquireSymposiumArtifactLease(host, request);
      host.markCreationStarted(lease.token, lease.revision, 'seat-writer');
      host.bindSandbox(lease.token, lease.revision, 'seat-writer', 'physical-1');
      await expect(host.release(lease.token)).rejects.toThrow('gateway and physical deletion');
      expect(await host.inspectLease(lease.token)).toEqual(lease);
    } finally {
      host.close();
    }
  });

  it('fails closed for a pre-migration unbound reservation of unknown create state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'symposium-legacy-lease-'));
    roots.push(root);
    const path = join(root, 'leases.sqlite');
    const old = new Database(path);
    old.exec(`CREATE TABLE symposium_artifact_leases (
      token TEXT PRIMARY KEY, revision TEXT NOT NULL, driver TEXT NOT NULL,
      volume_name TEXT NOT NULL, access TEXT NOT NULL, request_json TEXT NOT NULL,
      sandbox_name TEXT, sandbox_id TEXT, created_at INTEGER NOT NULL,
      CHECK ((sandbox_name IS NULL) = (sandbox_id IS NULL))
    );`);
    old
      .prepare(
        `INSERT INTO symposium_artifact_leases
      (token, revision, driver, volume_name, access, request_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-token',
        'legacy-revision',
        request.driver,
        request.volumeName,
        request.access,
        JSON.stringify(request),
        Date.now(),
      );
    old.close();
    const evidence = {
      verifyGateway: vi.fn(async () => {}),
      verifyMount: vi.fn(async () => {}),
      verifyDeleted: vi.fn(async () => {}),
    };
    const host = new SqliteArtifactLeaseHost(path, evidence, async () => [volume]);
    try {
      await expect(host.release('legacy-token')).rejects.toThrow('may be in flight');
      await expect(
        acquireSymposiumArtifactLease(host, { ...request, seatId: 'writer-2' }),
      ).rejects.toThrow('already has a writer');
    } finally {
      host.close();
    }
  });
});
