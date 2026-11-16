import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ execFileSync: vi.fn(), accessSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execFileSync: mocked.execFileSync,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<object>()),
  accessSync: mocked.accessSync,
}));

import { resolveHostGithubCredential } from '../host-github-credential.js';

beforeEach(() => {
  mocked.execFileSync.mockReset();
  mocked.accessSync.mockReset();
  mocked.accessSync.mockImplementation((path: string) => {
    if (path !== '/opt/homebrew/bin/gh')
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  vi.stubEnv('GH_TOKEN', 'controller-publisher-token');
  vi.stubEnv('GITHUB_TOKEN', 'controller-publisher-token');
  vi.stubEnv('GH_CONFIG_DIR', '/private/controller/gh');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('reads the host github.com login through an absolute gh without controller tokens', () => {
  mocked.execFileSync.mockReturnValue('gho_hostLogin123\n');
  expect(resolveHostGithubCredential()).toEqual({
    token: 'gho_hostLogin123',
    gh: '/opt/homebrew/bin/gh',
  });
  const [command, args, options] = mocked.execFileSync.mock.calls[0]!;
  expect(command).toBe('/opt/homebrew/bin/gh');
  expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
  expect(options.env).not.toHaveProperty('GH_TOKEN');
  expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
  expect(options.env).not.toHaveProperty('GH_CONFIG_DIR');
  expect(options.env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' });
  expect(options.timeout).toBeGreaterThan(0);
  expect(options.timeout).toBeLessThanOrEqual(5000);
  expect(options.stdio).toEqual(['ignore', 'pipe', 'ignore']);
});

it('returns undefined when gh is missing, fails, times out or prints no usable token', () => {
  mocked.accessSync.mockImplementation(() => {
    throw new Error('missing');
  });
  expect(resolveHostGithubCredential()).toBeUndefined();
  expect(mocked.execFileSync).not.toHaveBeenCalled();

  mocked.accessSync.mockImplementation(() => undefined);
  mocked.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  });
  expect(resolveHostGithubCredential()).toBeUndefined();

  for (const output of ['', '\n', 'two words\n', 'line1\nline2\n', 'x'.repeat(1000)]) {
    mocked.execFileSync.mockReset();
    mocked.execFileSync.mockReturnValue(output);
    expect(resolveHostGithubCredential()).toBeUndefined();
  }
});
