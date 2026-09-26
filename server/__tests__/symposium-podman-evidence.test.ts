import { describe, expect, it, vi } from 'vitest';
import { LocalPodmanArtifactEvidence } from '../symposium-podman-evidence.js';

const sandboxId = 'sbx-123';
const sandboxName = 'seat-a';
const physicalId = 'a'.repeat(64);
const labels = {
  'openshell.ai/sandbox-id': sandboxId,
  'openshell.ai/sandbox-name': sandboxName,
  'openshell.ai/sandbox-workspace': 'symposium-1',
  'openshell.ai/sandbox-namespace': 'gateway-local',
  'openshell.ai/isolation-role': 'sandbox',
  'openshell.managed': 'true',
};
const listed = [{ Id: physicalId, Labels: labels }];
const inspected = [
  {
    Id: physicalId,
    Config: { Labels: labels },
    State: { Running: true },
    Mounts: [
      {
        Type: 'volume',
        Name: 'artifacts-1',
        Destination: '/sandbox/symposium-artifacts',
        RW: false,
      },
    ],
  },
];
const config = {
  podman: {
    mounts: [
      {
        type: 'volume' as const,
        source: 'artifacts-1',
        target: '/sandbox/symposium-artifacts',
        read_only: true,
      },
    ],
  },
};

describe('local Podman artifact evidence', () => {
  it('inspects a matching read-only physical mount by sandbox ID label', async () => {
    const run = vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce(inspected);
    const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
    await evidence.verifyMount(sandboxName, sandboxId, config);
    expect(run).toHaveBeenNthCalledWith(1, ['ps', '--all', '--format', 'json']);
    expect(run).toHaveBeenNthCalledWith(2, ['inspect', '--type', 'container', physicalId]);
  });

  it('rejects read-write drift, identity drift, duplicate workloads and stopped containers', async () => {
    const cases = [
      {
        rows: listed,
        details: [{ ...inspected[0], Mounts: [{ ...inspected[0].Mounts[0], RW: true }] }],
        error: 'access differs',
      },
      {
        rows: listed,
        details: [
          {
            ...inspected[0],
            Config: { Labels: { ...labels, 'openshell.ai/sandbox-workspace': 'other' } },
          },
        ],
        error: 'sandbox-workspace',
      },
      { rows: [...listed, listed[0]], details: inspected, error: 'exactly one' },
      {
        rows: listed,
        details: [{ ...inspected[0], State: { Running: false } }],
        error: 'not running',
      },
    ];
    for (const testCase of cases) {
      const run = vi
        .fn()
        .mockResolvedValueOnce(testCase.rows)
        .mockResolvedValueOnce(testCase.details);
      const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
      await expect(evidence.verifyMount(sandboxName, sandboxId, config)).rejects.toThrow(
        testCase.error,
      );
    }
  });

  it('closes gateway admission and rejects any remaining physical sandbox', async () => {
    const run = vi.fn().mockResolvedValue([]);
    const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
    await expect(
      evidence.verifyGateway(
        {
          sessionId: 'session-1',
          workspaceId: 'symposium-1',
          seatId: 'seat-a',
          volumeName: 'artifacts-1',
          volumeGeneration: 'gen-1',
          driver: 'podman',
          access: 'reviewer',
        },
        config,
      ),
    ).rejects.toThrow('not host-attested');
    await expect(evidence.verifyDeleted(sandboxName, sandboxId)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    run.mockResolvedValueOnce(listed);
    await expect(evidence.verifyDeleted(sandboxName, sandboxId)).rejects.toThrow(
      'resources remain',
    );
    run.mockResolvedValueOnce([
      { Id: 'b'.repeat(64), Labels: { ...labels, 'openshell.ai/sandbox-id': 'replacement' } },
    ]);
    await expect(evidence.verifyDeleted(sandboxName, sandboxId)).rejects.toThrow(
      'resources remain',
    );
  });
});
