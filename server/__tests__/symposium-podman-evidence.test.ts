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
        Destination: '/sandbox/workspaces/mgmt',
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
        target: '/sandbox/workspaces/mgmt',
        read_only: true,
      },
    ],
  },
};

describe('local Podman artifact evidence', () => {
  it.each([
    ['', '', true],
    ['', undefined, false],
    ['', 'gateway-local', false],
    ['gateway-local', '', false],
    ['', ' ', false],
  ])(
    'matches configured namespace %j against physical label %j exactly',
    async (expected, actual, allowed) => {
      const actualLabels: Record<string, string> = { ...labels };
      if (actual === undefined) delete actualLabels['openshell.ai/sandbox-namespace'];
      else actualLabels['openshell.ai/sandbox-namespace'] = actual as string;
      const run = vi
        .fn()
        .mockResolvedValueOnce([{ Id: physicalId, Labels: actualLabels }])
        .mockResolvedValueOnce([{ ...inspected[0], Config: { Labels: actualLabels } }]);
      const evidence = new LocalPodmanArtifactEvidence('symposium-1', expected as string, run);
      if (allowed)
        await expect(evidence.verifyMount(sandboxName, sandboxId, config)).resolves.toBeUndefined();
      else
        await expect(evidence.verifyMount(sandboxName, sandboxId, config)).rejects.toThrow(
          'sandbox-namespace',
        );
    },
  );

  it.each([undefined, null, ' ', 'bad/namespace'])(
    'rejects omitted or malformed namespace %j',
    (value) => {
      expect(
        () => new LocalPodmanArtifactEvidence('symposium-1', value as string, vi.fn()),
      ).toThrow('namespace');
    },
  );

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

  it('rejects an older workload for the same stable identity despite a different sandbox ID', async () => {
    const older = {
      Id: 'b'.repeat(64),
      Labels: { ...labels, 'openshell.ai/sandbox-id': 'older-sandbox' },
    };
    const run = vi.fn().mockResolvedValueOnce([...listed, older]);
    const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
    await expect(evidence.verifyMount(sandboxName, sandboxId, config)).rejects.toThrow(
      'exactly one',
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not admit an older workload as the replacement when it is the only match', async () => {
    const olderLabels = { ...labels, 'openshell.ai/sandbox-id': 'older-sandbox' };
    const run = vi
      .fn()
      .mockResolvedValueOnce([{ Id: physicalId, Labels: olderLabels }])
      .mockResolvedValueOnce([{ ...inspected[0], Config: { Labels: olderLabels } }]);
    const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
    await expect(evidence.verifyMount(sandboxName, sandboxId, config)).rejects.toThrow(
      'sandbox-id',
    );
  });

  it.each(['sandbox-name', 'sandbox-workspace', 'sandbox-namespace'] as const)(
    'allows an unrelated workload with a different %s',
    async (field) => {
      const unrelated = {
        Id: 'b'.repeat(64),
        Labels: {
          ...labels,
          'openshell.ai/sandbox-id': 'other-sandbox',
          [`openshell.ai/${field}`]: 'other',
        },
      };
      const run = vi
        .fn()
        .mockResolvedValueOnce([...listed, unrelated])
        .mockResolvedValueOnce(inspected);
      const evidence = new LocalPodmanArtifactEvidence('symposium-1', 'gateway-local', run);
      await expect(evidence.verifyMount(sandboxName, sandboxId, config)).resolves.toBeUndefined();
      expect(run).toHaveBeenLastCalledWith(['inspect', '--type', 'container', physicalId]);
    },
  );

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

describe('reviewed workload artifact ownership', () => {
  const image = 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161';
  const good = {
    uid: 998,
    gid: 998,
    ownerUid: 998,
    ownerGid: 998,
    mode: '755',
    readable: true,
    searchable: true,
    writable: false,
  };
  it.each([
    [{}, true],
    [{ ownerUid: 0 }, false],
    [{ uid: 1000 }, false],
    [{ mode: '777' }, false],
    [{ writable: true }, false],
    [{ readable: false }, false],
    [{ searchable: false }, false],
  ])('requires native read/search and exact owner identity %j', async (delta, allowed) => {
    const details = [{ ...inspected[0], Image: image }];
    const run = vi
      .fn()
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(details)
      .mockResolvedValueOnce(details);
    const native = vi.fn().mockResolvedValue({ ...good, ...delta });
    const evidence = new LocalPodmanArtifactEvidence(
      'symposium-1',
      'gateway-local',
      run,
      undefined,
      image,
      native,
    );
    if (allowed)
      await expect(evidence.verifyMount(sandboxName, sandboxId, config)).resolves.toBeUndefined();
    else
      await expect(evidence.verifyMount(sandboxName, sandboxId, config)).rejects.toThrow(
        'identity or effective access',
      );
    expect(native).toHaveBeenCalledWith(
      sandboxName,
      sandboxId,
      expect.stringContaining('/usr/bin/id -u'),
    );
    expect(run.mock.calls.every(([args]) => args[0] !== 'exec')).toBe(true);
  });
  it('requires successful native writer probe; failure is not read-only proof', async () => {
    const writerConfig = { podman: { mounts: [{ ...config.podman.mounts[0], read_only: false }] } };
    const details = [
      { ...inspected[0], Image: image, Mounts: [{ ...inspected[0].Mounts[0], RW: true }] },
    ];
    const run = vi
      .fn()
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(details)
      .mockResolvedValueOnce(details);
    const native = vi.fn().mockResolvedValue({ ...good, writable: true });
    await expect(
      new LocalPodmanArtifactEvidence(
        'symposium-1',
        'gateway-local',
        run,
        undefined,
        image,
        native,
      ).verifyMount(sandboxName, sandboxId, writerConfig),
    ).resolves.toBeUndefined();
    const failed = vi.fn().mockRejectedValue(new Error('native probe unavailable'));
    const next = vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce(details);
    await expect(
      new LocalPodmanArtifactEvidence(
        'symposium-1',
        'gateway-local',
        next,
        undefined,
        image,
        failed,
      ).verifyMount(sandboxName, sandboxId, writerConfig),
    ).rejects.toThrow('native probe unavailable');
  });
  it('rejects physical identity drift after native probe', async () => {
    const details = [{ ...inspected[0], Image: image }];
    const run = vi
      .fn()
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce(details)
      .mockResolvedValueOnce([{ ...details[0], Id: 'b'.repeat(64) }]);
    await expect(
      new LocalPodmanArtifactEvidence(
        'symposium-1',
        'gateway-local',
        run,
        undefined,
        image,
        vi.fn().mockResolvedValue(good),
      ).verifyMount(sandboxName, sandboxId, config),
    ).rejects.toThrow('physical identity changed');
  });
  it('rejects a different physical image before probing', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(listed)
      .mockResolvedValueOnce([{ ...inspected[0], Image: 'b'.repeat(64) }]);
    await expect(
      new LocalPodmanArtifactEvidence(
        'symposium-1',
        'gateway-local',
        run,
        undefined,
        image,
      ).verifyMount(sandboxName, sandboxId, config),
    ).rejects.toThrow('image differs');
    expect(run).toHaveBeenCalledTimes(2);
  });
});

it('actual mount evidence forwards distinct read-only JSON operations only when original observer is present', async () => {
  const run = vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce(inspected);
  const observer = vi.fn();
  const evidence = new LocalPodmanArtifactEvidence(
    'symposium-1',
    'gateway-local',
    run,
    undefined,
    undefined,
    undefined,
    observer,
  );
  await evidence.verifyMount(sandboxName, sandboxId, config);
  expect(run).toHaveBeenNthCalledWith(1, ['ps', '--all', '--format', 'json'], 'podman-ps');
  expect(run).toHaveBeenNthCalledWith(
    2,
    ['inspect', '--type', 'container', physicalId],
    'podman-inspect',
  );
  expect(observer).not.toHaveBeenCalled(); // actual command owner emits; parsed injected facts confer no observations
});
