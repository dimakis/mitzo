import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { probeOwnedArtifactAccess } from '../symposium-artifact-native-access.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const gateway = () => ({
  cli: '/private/cli',
  gateway: 'owned',
  workspace: 'work',
  managementEnvironment: {
    PATH: '/usr/bin:/bin',
    HOME: '/private/home',
    XDG_CONFIG_HOME: '/private/config',
    XDG_STATE_HOME: '/private/state',
    XDG_CACHE_HOME: '/private/cache',
  },
  verifyCustody: vi.fn(),
});
const identity = { id: 'sandbox-id', name: 'seat-name', workspace: 'work', phase: 'Ready' };
it('uses native SSH resolution without numeric user override and checks identity before and after', async () => {
  const g = gateway();
  const outputs = [identity, { uid: 998, gid: 998 }, identity];
  vi.mocked(execFile).mockImplementation(((cmd, args, options, callback) =>
    callback(null, JSON.stringify(outputs.shift()), '')) as never);
  await expect(
    probeOwnedArtifactAccess(g as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).resolves.toEqual({ uid: 998, gid: 998 });
  expect(vi.mocked(execFile).mock.calls[1][0]).toBe('ssh');
  expect(vi.mocked(execFile).mock.calls[1][1]).toContain('sandbox@openshell-seat-name.work');
  expect(vi.mocked(execFile).mock.calls[1][1]).not.toContain('--user');
  expect(g.verifyCustody).toHaveBeenCalledTimes(4);
});
it.each([0, 2])('rejects changed immutable gateway identity at step %i', async (step) => {
  const outputs = [identity, { uid: 998, gid: 998 }, identity];
  outputs[step] = { ...identity, id: 'replacement' };
  vi.mocked(execFile).mockImplementation(((cmd, args, options, callback) =>
    callback(null, JSON.stringify(outputs.shift()), '')) as never);
  await expect(
    probeOwnedArtifactAccess(gateway() as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).rejects.toThrow('identity changed');
});
it('does not accept failed SSH as read-only evidence', async () => {
  let count = 0;
  vi.mocked(execFile).mockImplementation(((cmd, args, options, callback) => {
    count++;
    callback(count === 2 ? new Error('private error') : null, JSON.stringify(identity), '');
  }) as never);
  await expect(
    probeOwnedArtifactAccess(gateway() as never, 'seat-name', 'sandbox-id', '/usr/bin/id -u'),
  ).rejects.toThrow('probe failed');
});
