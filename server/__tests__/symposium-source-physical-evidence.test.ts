import { expect, it, vi } from 'vitest';
import { assertSourceVolume } from '../symposium-source-physical-evidence.js';
import { artifactVolumeLabels } from '../symposium-session-artifacts.js';
const mapping = {
  sessionId: 'session',
  volumeName: 'mitzo-artifacts-test',
  volumeGeneration: 'generation',
};
const owner = { image: 'pinned', uid: 998, gid: 998 };
it.each(['missing', 'generation', 'owner', 'mount'])(
  'rejects %s physical volume evidence before source dispatch',
  async (change) => {
    const volume = {
      Name: mapping.volumeName,
      Driver: 'local',
      Options: {},
      Labels: artifactVolumeLabels('workspace', mapping),
      UID: 998,
      GID: 998,
    };
    if (change === 'generation') volume.Labels['mitzo.symposium.generation'] = 'replacement';
    if (change === 'owner') volume.UID = 0;
    const command = vi.fn(async (args: readonly string[]) =>
      JSON.stringify(
        args[0] === 'volume'
          ? change === 'missing'
            ? []
            : [volume]
          : args[0] === 'ps'
            ? change === 'mount'
              ? [{ Id: 'a'.repeat(64) }]
              : []
            : [{ Id: 'a'.repeat(64), Mounts: [{ Type: 'volume', Name: mapping.volumeName }] }],
      ),
    );
    await expect(
      assertSourceVolume({ mapping, workspace: 'workspace', owner, command }),
    ).rejects.toThrow();
    expect(
      command.mock.calls.every(([args]) => ['volume', 'ps', 'inspect'].includes(args[0])),
    ).toBe(true);
    if (change === 'mount')
      expect(command.mock.calls.find(([args]) => args[0] === 'ps')?.[0]).toContain(
        `volume=${mapping.volumeName}`,
      );
  },
);
it('accepts only original volume and no other mounts, allowing its exact retained helper', async () => {
  const helper = 'a'.repeat(64);
  const command = vi.fn(async (args: readonly string[]) =>
    JSON.stringify(
      args[0] === 'volume'
        ? [
            {
              Name: mapping.volumeName,
              Driver: 'local',
              Options: {},
              Labels: artifactVolumeLabels('workspace', mapping),
              UID: 998,
              GID: 998,
            },
          ]
        : args[0] === 'ps'
          ? [{ Id: helper }]
          : [{ Id: helper, Mounts: [{ Type: 'volume', Name: mapping.volumeName }] }],
    ),
  );
  await expect(
    assertSourceVolume({ mapping, workspace: 'workspace', owner, command, helperId: helper }),
  ).resolves.toBeUndefined();
  expect(command.mock.calls.find(([args]) => args[0] === 'ps')?.[0]).toContain(
    `volume=${mapping.volumeName}`,
  );
});

it('does not inspect an unrelated container deleted after a global census', async () => {
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'volume')
      return JSON.stringify([
        {
          Name: mapping.volumeName,
          Driver: 'local',
          Options: {},
          Labels: artifactVolumeLabels('workspace', mapping),
          UID: 998,
          GID: 998,
        },
      ]);
    if (args[0] === 'ps')
      return JSON.stringify(
        args.includes(`volume=${mapping.volumeName}`) ? [] : [{ Id: 'f'.repeat(64) }],
      );
    throw Error('unrelated container disappeared before inspect');
  });
  await expect(
    assertSourceVolume({ mapping, workspace: 'workspace', owner, command }),
  ).resolves.toBeUndefined();
  expect(command.mock.calls.some(([args]) => args[0] === 'inspect')).toBe(false);
});

it('fails closed when a container selected by exact volume disappears before inspect', async () => {
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'volume')
      return JSON.stringify([
        {
          Name: mapping.volumeName,
          Driver: 'local',
          Options: {},
          Labels: artifactVolumeLabels('workspace', mapping),
          UID: 998,
          GID: 998,
        },
      ]);
    if (args[0] === 'ps') return JSON.stringify([{ Id: 'f'.repeat(64) }]);
    throw Error('same-volume container disappeared before inspect');
  });
  await expect(
    assertSourceVolume({ mapping, workspace: 'workspace', owner, command }),
  ).rejects.toThrow('same-volume container disappeared');
});
