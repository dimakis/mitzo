import { afterEach, expect, it, vi } from 'vitest';
const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => child);
vi.mock('node:os', () => ({ platform: () => 'darwin' }));
import { isGitDirectory, readWorkspaceBranch, readSshAuthSock } from '../chat-metadata.js';
afterEach(() => {
  vi.clearAllMocks();
});
it('lets other requests run while a bounded git metadata child is pending', async () => {
  let complete!: (error: Error | null, stdout: string) => void;
  child.execFile.mockImplementation((_program, _args, _options, callback) => {
    complete = callback;
  });
  let finished = false;
  const branch = readWorkspaceBranch('/workspace/account-one').then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  expect(child.execFile).toHaveBeenCalledWith(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    expect.objectContaining({
      cwd: '/workspace/account-one',
      timeout: expect.any(Number),
      maxBuffer: 8192,
      encoding: 'utf8',
    }),
    expect.any(Function),
  );
  complete(null, ' feature\n');
  expect(await branch).toBe('feature');
});
it('reads fresh metadata for different workspaces and successive calls', async () => {
  child.execFile.mockImplementation((_program, _args, options, callback) =>
    callback(null, options.cwd),
  );
  expect(await readWorkspaceBranch('/one')).toBe('/one');
  expect(await readWorkspaceBranch('/two')).toBe('/two');
  expect(await readWorkspaceBranch('/one')).toBe('/one');
  expect(child.execFile).toHaveBeenCalledTimes(3);
});
it('preserves missing, failed and empty metadata fallbacks', async () => {
  child.execFile.mockImplementation((_program, _args, _options, callback) =>
    callback(Error('timeout or output limit'), ''),
  );
  expect(await isGitDirectory('/missing')).toBe(false);
  expect(await readWorkspaceBranch('/missing')).toBe('unknown');
  expect(await readSshAuthSock()).toBeNull();
  child.execFile.mockImplementation((_program, _args, _options, callback) =>
    callback(null, '  \n'),
  );
  expect(await readSshAuthSock()).toBeNull();
});
it('resolves the current Mac socket without caching it', async () => {
  child.execFile.mockImplementation((_program, _args, _options, callback) =>
    callback(null, ' /private/tmp/socket \n'),
  );
  expect(await readSshAuthSock()).toBe('/private/tmp/socket');
  expect(child.execFile).toHaveBeenCalledWith(
    'launchctl',
    ['getenv', 'SSH_AUTH_SOCK'],
    expect.objectContaining({ timeout: 500, maxBuffer: 8192 }),
    expect.any(Function),
  );
});
it('propagates cancellation rather than returning a successful fallback', async () => {
  const controller = new AbortController();
  child.execFile.mockImplementation((_program, _args, options, callback) => {
    options.signal.addEventListener('abort', () => callback(Error('aborted'), ''));
  });
  const branch = readWorkspaceBranch('/workspace', controller.signal);
  controller.abort(Error('session closed'));
  await expect(branch).rejects.toThrow('session closed');
  child.execFile.mockClear();
  await expect(readWorkspaceBranch('/workspace', controller.signal)).rejects.toThrow(
    'session closed',
  );
  expect(child.execFile).not.toHaveBeenCalled();
});
