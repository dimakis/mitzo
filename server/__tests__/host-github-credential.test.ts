import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ execFileSync: vi.fn(), accessSync: vi.fn(), warn: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ warn: mocked.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  execFileSync: mocked.execFileSync,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<object>()),
  accessSync: mocked.accessSync,
}));

import {
  HOST_GH_EXECUTABLES,
  hostGithubCommandEnvironment,
  inspectHostGithubCredential,
  resolveHostGithubCredential,
} from '../host-github-credential.js';

const HOST_GH = HOST_GH_EXECUTABLES[0]!;

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

it('classifies unavailable host logins with stable codes', () => {
  mocked.accessSync.mockImplementation(() => {
    throw new Error('missing');
  });
  expect(inspectHostGithubCredential()).toEqual({ status: 'unavailable', code: 'gh_unavailable' });

  mocked.accessSync.mockImplementation(() => undefined);
  mocked.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  });
  expect(inspectHostGithubCredential()).toEqual({
    status: 'unavailable',
    code: 'gh_login_timeout',
  });
  // gh exits 1 ("no oauth token found") when logged out or the keychain is locked.
  mocked.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('Command failed: gh auth token gho_echoedSecret'), {
      status: 1,
    });
  });
  expect(inspectHostGithubCredential()).toEqual({
    status: 'unavailable',
    code: 'gh_login_unavailable',
  });
  mocked.execFileSync.mockReset();
  mocked.execFileSync.mockReturnValue('not a token\n');
  expect(inspectHostGithubCredential()).toEqual({
    status: 'unavailable',
    code: 'gh_token_unusable',
  });
});

it('reports each distinct unavailable reason once, without secrets, and re-arms after success', () => {
  mocked.warn.mockReset();
  mocked.accessSync.mockImplementation(() => undefined);
  const failing = () =>
    mocked.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('gh failed gho_echoedSecret'), { status: 1 });
    });
  failing();
  // Reset any reason retained from earlier cases with one success first.
  mocked.execFileSync.mockReturnValueOnce('gho_hostLogin123\n');
  expect(resolveHostGithubCredential()).toEqual({ token: 'gho_hostLogin123', gh: HOST_GH });
  expect(resolveHostGithubCredential()).toBeUndefined();
  expect(resolveHostGithubCredential()).toBeUndefined();
  expect(mocked.warn).toHaveBeenCalledOnce();
  expect(mocked.warn.mock.calls[0]![1]).toEqual({
    stage: 'host_github_credential',
    code: 'gh_login_unavailable',
  });
  mocked.execFileSync.mockImplementation(() => {
    throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
  });
  expect(resolveHostGithubCredential()).toBeUndefined();
  expect(mocked.warn).toHaveBeenCalledTimes(2);
  mocked.execFileSync.mockReturnValueOnce('gho_hostLogin123\n');
  expect(resolveHostGithubCredential()).toBeDefined();
  failing();
  expect(resolveHostGithubCredential()).toBeUndefined();
  expect(mocked.warn).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(mocked.warn.mock.calls)).not.toMatch(/gho_/);
});

it('builds the native command environment with only the host token as a secret', () => {
  expect(hostGithubCommandEnvironment({ token: 'gho_hostLogin123', gh: HOST_GH })).toEqual({
    GH_TOKEN: 'gho_hostLogin123',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${HOST_GH} auth git-credential`,
    GIT_CONFIG_KEY_2: 'commit.gpgsign',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'tag.gpgsign',
    GIT_CONFIG_VALUE_3: 'false',
  });
});
