import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import type { SessionRegistry } from '@mitzo/harness';
import { authorizeNativeLocalRepositoryRemote } from '../native-local-repository-remote.js';

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  identity: vi.fn(async () => 'fixture-operator'),
  run: vi.fn(),
  runtime: vi.fn(() => null as unknown),
}));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.permission,
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: mocks.runtime }));
vi.mock('../local-repository-host-git.js', () => ({
  captureRepositoryHostGit: () => ({
    identity: mocks.identity,
    run: mocks.run,
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.runtime.mockReturnValue(null);
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-remote-owner-')));
  roots.push(root);
  let current = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('revoked');
  };
  const context = Object.freeze({
    clientId: 'client',
    callId: 'call',
    toolName: 'PrepareLocalRepository',
    signal: new AbortController().signal,
    accountBinding: { accountId: 'account' },
    assertCurrentSync,
    assertCurrent: async () => assertCurrentSync(),
  }) as unknown as NativeHostToolContext;
  const request = {
    url: 'ssh://git@github.com/fixture/project.git',
    directory: join(root, 'acquire'),
    base: { kind: 'default' as const },
    signal: context.signal,
    deadline: Date.now() + 30000,
  };
  mocks.permission.mockImplementation(async (_tool, input) => ({
    behavior: 'allow',
    updatedInput: input,
    decisionClassification: 'user_temporary',
  }));
  mocks.run.mockResolvedValue({ stdout: 'fixture', stderr: '' });
  return {
    context,
    request,
    registry: {} as SessionRegistry,
    revoke: () => {
      current = false;
    },
  };
}
it('binds explicit host acquisition approval to the repository and isolated directory', async () => {
  const f = await fixture();
  const run = await authorizeNativeLocalRepositoryRemote(f.context, f.request, f.registry);
  expect(mocks.permission).toHaveBeenCalledWith(
    'PrepareLocalRepository',
    expect.objectContaining({
      operation: 'acquire-repository-base',
      repository: 'fixture/project',
      identity: 'current host GitHub account',
      directory: f.request.directory,
    }),
    expect.objectContaining({ allowSessionGrant: false, approvalScope: 'request' }),
  );
  await run(['ls-remote', '--symref', '--', f.request.url, 'HEAD'], f.context.signal);
  expect(mocks.run).toHaveBeenCalledWith(
    expect.arrayContaining(['https://github.com/fixture/project.git']),
    expect.objectContaining({ directory: f.request.directory }),
  );
  f.revoke();
  await expect(
    run(['ls-remote', '--symref', '--', f.request.url, 'HEAD'], f.context.signal),
  ).rejects.toThrow();
  expect(mocks.run).toHaveBeenCalledOnce();
});
it('does not acquire on denied approval or an unsupported credential destination', async () => {
  const f = await fixture();
  mocks.permission.mockResolvedValue({ behavior: 'deny' });
  await expect(
    authorizeNativeLocalRepositoryRemote(f.context, f.request, f.registry),
  ).rejects.toThrow();
  await expect(
    authorizeNativeLocalRepositoryRemote(
      f.context,
      { ...f.request, url: 'ext::untrusted-command' },
      f.registry,
    ),
  ).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.identity).not.toHaveBeenCalled();
});

it.each(
  [
    ['ls-remote', '--symref', '--', 'https://github.com/other/repository.git', 'HEAD'],
    ['--git-dir', '/another/task/.git', 'update-ref', 'refs/heads/mitzo-acquire', 'a'.repeat(40)],
    [
      '-c',
      'core.sshCommand=untrusted',
      'ls-remote',
      '--symref',
      '--',
      'ssh://git@github.com/fixture/project.git',
      'HEAD',
    ],
  ].map((args) => ({ args })),
)('refuses commands outside the approved repository capability: %j', async ({ args }) => {
  const f = await fixture();
  const run = await authorizeNativeLocalRepositoryRemote(f.context, f.request, f.registry);
  mocks.identity.mockClear();
  await expect(run(args, f.context.signal)).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.identity).not.toHaveBeenCalled();
});
it('uses an unambiguous existing account connection and revokes it when its revision changes', async () => {
  const f = await fixture();
  const connection = {
    id: 'github',
    revision: 1,
    templateId: 'github-readonly',
    status: 'active',
    identity: 'fixture-operator',
    desiredAccountIds: ['account'],
    publicConfig: { allowedRepositories: ['fixture/project'] },
  };
  mocks.runtime.mockReturnValue({
    store: { list: () => [connection], get: () => connection },
    verifyGithubPublishingIdentity: async () => true,
  });
  const run = await authorizeNativeLocalRepositoryRemote(f.context, f.request, f.registry);
  expect(mocks.permission).not.toHaveBeenCalled();
  connection.revision++;
  await expect(
    run(['ls-remote', '--symref', '--', f.request.url, 'HEAD'], f.context.signal),
  ).rejects.toThrow();
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each([
  'https://git.example.test/team/project.git',
  'ssh://git@git.example.test/team/project.git',
])('acquires an explicitly requested remote on any supported host: %s', async (url) => {
  const f = await fixture();
  const run = await authorizeNativeLocalRepositoryRemote(
    f.context,
    { ...f.request, url },
    f.registry,
  );
  await run(['ls-remote', '--symref', '--', url, 'HEAD'], f.context.signal);
  expect(mocks.permission).toHaveBeenCalledWith(
    'PrepareLocalRepository',
    expect.objectContaining({ remote: url }),
    expect.any(Object),
  );
  expect(mocks.run).toHaveBeenCalledWith(expect.arrayContaining([url]), expect.any(Object));
  expect(mocks.identity).not.toHaveBeenCalled();
});

it('permits only the bounded acquisition command sequence in its own directory', async () => {
  const f = await fixture();
  const run = await authorizeNativeLocalRepositoryRemote(f.context, f.request, f.registry);
  const gitDir = join(f.request.directory, '.git');
  const commands = [
    ['init', '--quiet', '--template=', '--initial-branch=mitzo-acquire', f.request.directory],
    [
      '--git-dir',
      gitDir,
      'fetch',
      '--no-tags',
      '--depth=1',
      '--no-write-fetch-head',
      '--',
      f.request.url,
      '+refs/heads/main:refs/mitzo/base',
    ],
    ['--git-dir', gitDir, 'rev-parse', '--verify', '--end-of-options', 'refs/mitzo/base^{commit}'],
    ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', 'refs/heads/mitzo-acquire'],
    ['--git-dir', gitDir, 'update-ref', 'refs/heads/mitzo-acquire', 'b'.repeat(40)],
  ];
  for (const command of commands)
    await run(['-c', 'core.hooksPath=/dev/null', ...command], f.context.signal);
  expect(mocks.run).toHaveBeenCalledTimes(commands.length);
});
