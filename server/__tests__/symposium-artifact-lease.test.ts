import { describe, expect, it, vi } from 'vitest';
import {
  acquireSymposiumArtifactLease,
  artifactDriverConfigForLease,
  SYMPOSIUM_ARTIFACT_TARGET,
  type ArtifactLease,
  type ArtifactLeaseHost,
  type ArtifactLeaseRequest,
  type ArtifactVolumeEvidence,
} from '../symposium-artifact-lease.js';

const request: ArtifactLeaseRequest = {
  sessionId: 'chat-1',
  workspaceId: 'symposium-1',
  seatId: 'implementer',
  volumeName: 'mitzo-artifacts-1',
  volumeGeneration: 'g1',
  driver: 'docker',
  access: 'writer',
};

function fixture() {
  const volume: ArtifactVolumeEvidence = {
    name: request.volumeName,
    driver: 'local',
    options: {},
    labels: {
      'openshell.ai/sandbox-attachable': 'true',
      'openshell.ai/sandbox-attachable-workspace': request.workspaceId,
      'mitzo.symposium.purpose': 'artifacts',
      'mitzo.symposium.session': request.sessionId,
      'mitzo.symposium.workspace': request.workspaceId,
      'mitzo.symposium.generation': request.volumeGeneration,
    },
  };
  const lease: ArtifactLease = { token: 'lease-1', request, revision: 'r1' };
  const host: ArtifactLeaseHost = {
    inspectVolume: vi.fn(async () => volume),
    verifyDriverConfig: vi.fn(async () => {}),
    reserve: vi.fn(async () => lease),
    inspectLease: vi.fn(async () => lease),
    release: vi.fn(async () => {}),
  };
  return { volume, lease, host };
}

describe('Symposium artifact lease admission', () => {
  it('mounts one named volume RW for the exclusive writer and RO for a reviewer', async () => {
    const { host } = fixture();
    const writer = await acquireSymposiumArtifactLease(host, request);
    expect(await artifactDriverConfigForLease(host, writer)).toEqual({
      docker: {
        mounts: [
          {
            type: 'volume',
            source: request.volumeName,
            target: SYMPOSIUM_ARTIFACT_TARGET,
            read_only: false,
          },
        ],
      },
    });
    expect(host.verifyDriverConfig).toHaveBeenCalledWith(request, {
      docker: {
        mounts: [
          {
            type: 'volume',
            source: request.volumeName,
            target: SYMPOSIUM_ARTIFACT_TARGET,
            read_only: false,
          },
        ],
      },
    });
    const reviewerRequest = { ...request, seatId: 'reviewer', access: 'reviewer' as const };
    const reviewer = { token: 'lease-2', revision: 'r2', request: reviewerRequest };
    vi.mocked(host.reserve).mockResolvedValue(reviewer);
    vi.mocked(host.inspectLease).mockResolvedValue(reviewer);
    expect(
      await artifactDriverConfigForLease(
        host,
        await acquireSymposiumArtifactLease(host, reviewerRequest),
      ),
    ).toEqual({
      docker: {
        mounts: [
          {
            type: 'volume',
            source: request.volumeName,
            target: SYMPOSIUM_ARTIFACT_TARGET,
            read_only: true,
          },
        ],
      },
    });
  });

  it('rejects wrong labels, host-backed volumes and malformed identities before reserving', async () => {
    for (const mutate of [
      (v: ArtifactVolumeEvidence) => {
        v.labels['mitzo.symposium.session'] = 'other';
      },
      (v: ArtifactVolumeEvidence) => {
        v.options.device = '/host/home';
      },
      (v: ArtifactVolumeEvidence) => {
        v.labels['credential.path'] = '/host/home';
      },
      (v: ArtifactVolumeEvidence) => {
        delete v.labels['openshell.ai/sandbox-attachable'];
      },
      (v: ArtifactVolumeEvidence) => {
        v.labels['openshell.ai/sandbox-attachable-workspace'] = 'other';
      },
    ]) {
      const { host, volume } = fixture();
      mutate(volume);
      await expect(acquireSymposiumArtifactLease(host, request)).rejects.toThrow();
      expect(host.reserve).not.toHaveBeenCalled();
    }
    const { host } = fixture();
    await expect(
      acquireSymposiumArtifactLease(host, { ...request, volumeName: '/host/home' }),
    ).rejects.toThrow('Invalid artifact volume name');
    expect(host.reserve).not.toHaveBeenCalled();
  });

  it('rechecks volume and lease after reservation and retains uncertain state on drift', async () => {
    const { host, volume } = fixture();
    vi.mocked(host.inspectVolume)
      .mockImplementationOnce(async () => ({ ...volume }))
      .mockImplementationOnce(async () => ({
        ...volume,
        labels: { ...volume.labels, 'mitzo.symposium.generation': 'g2' },
      }));
    await expect(acquireSymposiumArtifactLease(host, request)).rejects.toThrow('labels');
    expect(host.release).not.toHaveBeenCalled();
    const second = fixture();
    vi.mocked(second.host.inspectLease).mockResolvedValue(null);
    await expect(acquireSymposiumArtifactLease(second.host, request)).rejects.toThrow(
      'lease drift',
    );
    expect(second.host.release).not.toHaveBeenCalled();
  });

  it('refuses a stale lease at sandbox configuration time', async () => {
    const { host, lease } = fixture();
    vi.mocked(host.inspectLease).mockResolvedValue({ ...lease, revision: 'r2' });
    await expect(artifactDriverConfigForLease(host, lease)).rejects.toThrow('lease drift');
  });

  it('fails closed when the selected gateway rejects the driver config', async () => {
    const { host, lease } = fixture();
    vi.mocked(host.verifyDriverConfig).mockRejectedValue(new Error('driver config disabled'));
    await expect(artifactDriverConfigForLease(host, lease)).rejects.toThrow(
      'driver config disabled',
    );
  });

  it('cannot produce a second RW mount when the host rejects its atomic writer reservation', async () => {
    const { host } = fixture();
    vi.mocked(host.reserve).mockRejectedValue(new Error('writer lease already held'));
    await expect(
      acquireSymposiumArtifactLease(host, { ...request, seatId: 'other-writer' }),
    ).rejects.toThrow('writer lease already held');
    expect(host.inspectLease).not.toHaveBeenCalled();
  });
});
