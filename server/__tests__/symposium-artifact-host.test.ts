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
  return { a, b, evidence, runner, path };
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

  it('requires an existing exact bound lease for reuse without reserving', async () => {
    const { a, b } = fixture();
    try {
      const reserve = vi.spyOn(a, 'reserve');
      await expect(
        a.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).rejects.toThrow('identity is unavailable');
      expect(reserve).not.toHaveBeenCalled();
      const writer = await b.reserve(request);
      await expect(
        a.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).rejects.toThrow('identity is unavailable');
      b.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      await expect(
        a.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).rejects.toThrow('identity is unavailable');
      b.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      await expect(
        a.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).resolves.toEqual(writer);
      for (const [changed, name, id] of [
        [{ ...request, volumeGeneration: 'other' }, 'seat-writer', 'physical-1'],
        [request, 'other-seat', 'physical-1'],
        [request, 'seat-writer', 'other-physical'],
      ] as const)
        await expect(a.requireBoundSandboxLease(changed, name, id)).rejects.toThrow(
          'identity is unavailable',
        );
      expect(reserve).not.toHaveBeenCalled();
    } finally {
      a.close();
      b.close();
    }
  });

  it('reports released Ready identities as cleanup-required after restart without reacquiring', async () => {
    const { a, b, path, evidence, runner } = fixture();
    const writer = await a.reserve(request);
    a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
    a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
    await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
    a.close();
    b.close();
    const reopened = new SqliteArtifactLeaseHost(path, evidence, runner);
    try {
      await expect(
        reopened.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).rejects.toThrow('seat cleanup is required');
      // A read failed; the exact prior release can still finish lifecycle cleanup.
      await expect(
        reopened.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {}),
      ).resolves.toBeUndefined();
      const replacement = await reopened.reserve(request);
      await expect(
        reopened.requireBoundSandboxLease(request, 'seat-writer', 'physical-1'),
      ).rejects.toThrow('seat cleanup is required');
      expect(await reopened.inspectLease(replacement.token)).toEqual(replacement);
    } finally {
      reopened.close();
    }
  });

  it('replays an exact release after host restart with fresh gateway and physical proof', async () => {
    const { a, b, evidence, runner, path } = fixture();
    const writer = await acquireSymposiumArtifactLease(a, request);
    a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
    a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
    await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
    // Crash after the lease transaction but before the seat's stopped marker.
    a.close();
    b.close();
    const reopened = new SqliteArtifactLeaseHost(path, evidence, runner);
    const gatewayAbsent = vi.fn(async () => {});
    try {
      evidence.verifyDeleted.mockClear();
      await reopened.releaseBoundSandbox(request, 'seat-writer', 'physical-1', gatewayAbsent);
      expect(gatewayAbsent).toHaveBeenCalledTimes(2);
      expect(evidence.verifyDeleted).toHaveBeenCalledExactlyOnceWith('seat-writer', 'physical-1');
      expect(await reopened.inspectLease(writer.token)).toBeNull();
      for (const [changed, name, id] of [
        [{ ...request, seatId: 'other' }, 'seat-writer', 'physical-1'],
        [request, 'other-sandbox', 'physical-1'],
        [request, 'seat-writer', 'physical-2'],
      ] as const) {
        await expect(
          reopened.releaseBoundSandbox(changed, name, id, gatewayAbsent),
        ).rejects.toThrow('identity is unavailable');
      }
      evidence.verifyDeleted.mockRejectedValueOnce(new Error('Physical proof unavailable'));
      await expect(
        reopened.releaseBoundSandbox(request, 'seat-writer', 'physical-1', gatewayAbsent),
      ).rejects.toThrow('Physical proof unavailable');
      const appeared = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Gateway replacement appeared'));
      await expect(
        reopened.releaseBoundSandbox(request, 'seat-writer', 'physical-1', appeared),
      ).rejects.toThrow('Gateway replacement appeared');
      await reopened.releaseBoundSandbox(request, 'seat-writer', 'physical-1', gatewayAbsent);
    } finally {
      reopened.close();
    }
  });

  it('does not release a replacement lease when replaying a previous release', async () => {
    const { a, b } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
      const replacement = await acquireSymposiumArtifactLease(b, request);
      expect(replacement.token).not.toBe(writer.token);
      await expect(
        a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {}),
      ).rejects.toThrow('changed after deletion proof');
      expect(await b.inspectLease(replacement.token)).toEqual(replacement);
      await b.release(replacement.token);
      const other = await acquireSymposiumArtifactLease(b, { ...request, seatId: 'other' });
      b.markCreationStarted(other.token, other.revision, 'seat-writer');
      b.bindSandbox(other.token, other.revision, 'seat-writer', 'physical-2');
      await expect(
        a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {}),
      ).rejects.toThrow('changed after deletion proof');
      expect(await b.inspectLease(other.token)).toEqual(other);
    } finally {
      a.close();
      b.close();
    }
  });

  it('rechecks replacement leases after asynchronous replay evidence', async () => {
    const { a, b } = fixture();
    try {
      const writer = await acquireSymposiumArtifactLease(a, request);
      a.markCreationStarted(writer.token, writer.revision, 'seat-writer');
      a.bindSandbox(writer.token, writer.revision, 'seat-writer', 'physical-1');
      await a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', async () => {});
      let replacementToken = '';
      const absent = vi.fn(async () => {
        if (!replacementToken) replacementToken = (await b.reserve(request)).token;
      });
      await expect(
        a.releaseBoundSandbox(request, 'seat-writer', 'physical-1', absent),
      ).rejects.toThrow('changed after deletion proof');
      expect(await b.inspectLease(replacementToken)).not.toBeNull();
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
