import { afterEach, expect, it, vi } from 'vitest';
const execute = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execute }));
import { knowledgeHostCommand } from '../knowledge-host-command.js';
import { GithubNotFoundError } from '../connections/capabilities/github-publish-pr-transport.js';
afterEach(() => {
  vi.unstubAllEnvs();
  execute.mockReset();
});
function succeed(stdout = 'safe result') {
  execute.mockImplementation((_command, _args, _options, callback) => callback(null, stdout, ''));
}
it('only permits controller Git and GitHub CLI commands', async () => {
  succeed();
  await expect(
    knowledgeHostCommand('sh', ['-c', 'whoami'], AbortSignal.timeout(1000)),
  ).rejects.toThrow('not allowed');
  expect(execute).not.toHaveBeenCalled();
  expect(await knowledgeHostCommand('git', ['--version'], AbortSignal.timeout(1000))).toEqual({
    stdout: 'safe result',
    stderr: '',
  });
  expect(await knowledgeHostCommand('gh', ['api', 'user'], AbortSignal.timeout(1000))).toEqual({
    stdout: 'safe result',
    stderr: '',
  });
});
it('uses bounded sterile execution and keeps host credential only in the fixed environment helper', async () => {
  vi.stubEnv('GH_TOKEN', 'TEST-HOST-SECRET');
  vi.stubEnv('GITHUB_TOKEN', 'ignored-secret');
  vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', '/untrusted/objects');
  vi.stubEnv('GIT_CONFIG_PARAMETERS', 'untrusted');
  vi.stubEnv('GIT_SSH_COMMAND', 'untrusted');
  vi.stubEnv('OPENAI_API_KEY', 'model-secret');
  succeed();
  await knowledgeHostCommand(
    'git',
    ['fetch', 'https://github.com/owner/repo.git'],
    AbortSignal.timeout(1000),
  );
  const [program, args, options] = execute.mock.calls[0];
  expect(program).toBe('git');
  expect(args.join(' ')).not.toContain('TEST-HOST-SECRET');
  expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true });
  expect(options.env).toMatchObject({
    GH_TOKEN: 'TEST-HOST-SECRET',
    GITHUB_TOKEN: 'TEST-HOST-SECRET',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper',
  });
  expect(options.env.GIT_CONFIG_VALUE_2).toContain('"$GITHUB_TOKEN"');
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_PARAMETERS',
    'GIT_SSH_COMMAND',
    'OPENAI_API_KEY',
  ])
    expect(options.env[key]).toBeUndefined();
});
it('uses the same enrolled GitHub CLI account for tokenless API and private Git authentication', async () => {
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('HOME', '/fixture/service-account-home');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/untrusted/user-settings');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'credential.helper');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'untrusted-user-credential-helper');
  succeed();
  await knowledgeHostCommand('gh', ['api', 'user'], AbortSignal.timeout(1000));
  await knowledgeHostCommand(
    'git',
    ['fetch', 'https://github.com/owner/private-source.git'],
    AbortSignal.timeout(1000),
  );
  await knowledgeHostCommand(
    'git',
    [
      'clone',
      '--no-checkout',
      'https://github.com/owner/private-source.git',
      '/fixture/private/checkout',
    ],
    AbortSignal.timeout(1000),
  );
  const apiEnvironment = execute.mock.calls[0][2].env;
  for (const [, args, options] of execute.mock.calls) {
    expect(options.env).toEqual(apiEnvironment);
    expect(options.env).toMatchObject({
      HOME: '/fixture/service-account-home',
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_2: '!gh auth git-credential',
    });
    expect(options.env.GH_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.stringify(options.env)).not.toContain('untrusted-user-credential-helper');
    expect(args).not.toContain('untrusted-user-credential-helper');
  }
});
it('sanitizes command errors and diagnostic output while retaining a safe cause', async () => {
  execute.mockImplementation((_command, _args, _options, callback) =>
    callback(
      Object.assign(new Error('TEST-HOST-SECRET'), { stderr: 'Bearer TEST-HOST-SECRET', code: 1 }),
      '',
      'TEST-HOST-SECRET',
    ),
  );
  const error = await knowledgeHostCommand('gh', ['api', 'user'], AbortSignal.timeout(1000)).catch(
    (error: unknown) => error,
  );
  if (!(error instanceof Error)) throw new Error('Expected the host command to reject');
  expect(error.message).toBe('GitHub host operation failed');
  expect(error.cause).toBeDefined();
  expect(String(error.cause)).not.toContain('TEST-HOST-SECRET');
  expect(JSON.stringify(error)).not.toContain('TEST-HOST-SECRET');
});
it('preserves the typed not-found boundary used by branch policy', async () => {
  execute.mockImplementation((_command, _args, _options, callback) =>
    callback(Object.assign(new Error('private URL'), { stderr: 'HTTP 404 private URL' }), '', ''),
  );
  await expect(
    knowledgeHostCommand('gh', ['api', 'repos/owner/repo'], AbortSignal.timeout(1000)),
  ).rejects.toBeInstanceOf(GithubNotFoundError);
});
it('rejects a revoked signal before starting a command', async () => {
  const controller = new AbortController();
  controller.abort();
  succeed();
  await expect(knowledgeHostCommand('gh', ['api', 'user'], controller.signal)).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
