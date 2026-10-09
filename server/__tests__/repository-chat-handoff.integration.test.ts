import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { SessionRegistry } from '@mitzo/harness';
import { afterEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  enabled: vi.fn(),
  binding: vi.fn(),
  catalog: vi.fn(),
  service: vi.fn(),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  repositoryWorkspacesEnabled: runtime.enabled,
  repositoryWorkspaceBinding: runtime.binding,
  repositoryWorkspaceCatalog: runtime.catalog,
  getRepositoryWorkspaces: runtime.service,
}));
import {
  prepareGithubRepositorySource,
  type GithubRepositoryCommand,
} from '../github-repository-source.js';
import { RepositoryWorkspaces, type RepositoryChatPreparation } from '../repository-workspaces.js';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';

const roots: string[] = [];
const services = new Set<RepositoryWorkspaces>();
const registries: SessionRegistry[] = [];
afterEach(async () => {
  registries.splice(0).forEach((registry) => registry.dispose());
  services.forEach((service) => service.close());
  services.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.resetAllMocks();
});

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (directory: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { encoding: 'utf8', env: gitEnv },
  ).trim();

it('recovers and launches a durable tool handoff into a separate repository chat without changing its source chat', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-chat-handoff-')));
  roots.push(root);
  const origin = join(root, 'original-workspace');
  const upstream = join(root, 'upstream');
  for (const directory of [origin, upstream]) {
    execFileSync('git', ['init', '-q', '--template=', '-b', 'main', directory], { env: gitEnv });
    git(directory, 'config', 'user.name', 'Offline fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(
      join(directory, 'file.txt'),
      directory === origin ? 'original chat\n' : 'repository baseline\n',
    );
    git(directory, 'add', '.');
    git(directory, 'commit', '-qm', 'baseline');
  }
  git(origin, 'checkout', '-qb', 'existing-chat');
  const originalOid = git(origin, 'rev-parse', 'HEAD');
  const baseOid = git(upstream, 'rev-parse', 'HEAD');
  const binding = {
    accountId: 'offline-account',
    provider: 'openai',
    model: 'offline-fixture-no-model-calls',
    profileRevision: 'profile-1',
  } as AccountBinding;
  const run: GithubRepositoryCommand = vi.fn(
    async (command: string, args: readonly string[], signal: AbortSignal) => {
      signal.throwIfAborted();
      if (command !== 'git') throw new Error('Only local Git acquisition is permitted');
      const local = args.map((arg) =>
        args[0] === 'clone' && arg === 'https://github.com/example/repo.git' ? upstream : arg,
      );
      return {
        stdout: execFileSync('git', ['-c', 'commit.gpgsign=false', ...local], {
          encoding: 'utf8',
          env: gitEnv,
        }),
        stderr: '',
      };
    },
  );
  const inspect = vi.fn(async (repository: string) => ({
    repository,
    baseBranch: 'main',
    baseOid,
  }));
  const dependencies = {
    authorize: async (
      selected: AccountBinding,
      connectionId: string,
      repository: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      expect(selected).toEqual(binding);
      expect(connectionId).toBe('github-fixture');
      expect(repository).toBe('example/repo');
      return { revision: 1, allowedBaseBranches: ['main'] };
    },
    inspect,
    prepare: (
      preview: Parameters<typeof prepareGithubRepositorySource>[0],
      directory: string,
      branch: string,
      signal: AbortSignal,
    ) => prepareGithubRepositorySource(preview, directory, branch, signal, run),
  };
  const privateRoot = join(root, 'private');
  let service = new RepositoryWorkspaces(privateRoot, dependencies);
  services.add(service);
  const restart = () => {
    service.close();
    services.delete(service);
    service = new RepositoryWorkspaces(privateRoot, dependencies);
    services.add(service);
  };
  runtime.enabled.mockReturnValue(true);
  runtime.binding.mockImplementation((accountId, model) => {
    expect({ accountId, model }).toEqual({ accountId: binding.accountId, model: binding.model });
    return { ...binding };
  });
  const catalog = {
    available: true,
    repositories: [
      {
        connectionId: 'github-fixture',
        label: 'Offline GitHub fixture',
        repository: 'example/repo',
      },
    ],
  };
  runtime.catalog.mockReturnValue(catalog);
  runtime.service.mockImplementation(() => service);
  const registry = new SessionRegistry();
  registries.push(registry);
  registry.register('source-client', {
    sessionId: 'source-chat',
    cwd: origin,
    branch: 'existing-chat',
    accountBinding: { ...binding },
    model: binding.model,
    mode: 'agent',
    abortController: new AbortController(),
    activeSkillPolicy: new Set([
      'mcp__connections__ListRepositories',
      'mcp__connections__PrepareRepositoryChat',
      'mcp__connections__GetRepositoryChatPreparation',
    ]),
  } as never);
  const sourceSession = registry.get('source-client')!;
  const tools = sessionCredentialTools(
    'source-chat',
    sourceSession,
    registry,
    'mcp__connections__',
  );
  const signal = new AbortController().signal;
  const listed = await tools.execute('ListRepositories', {}, signal);
  expect(listed?.isError).toBe(false);
  expect(JSON.parse(listed!.content)).toEqual(catalog);
  const input = {
    repository: 'https://github.com/Example/Repo.git',
    prompt: 'Update file.txt in a separate repository chat',
  };
  const prepared = await tools.execute('PrepareRepositoryChat', input, signal);
  expect(prepared?.isError).toBe(false);
  const draft = (JSON.parse(prepared!.content) as { repositoryChat: RepositoryChatPreparation })
    .repositoryChat;
  expect(draft).toMatchObject({
    repository: 'example/repo',
    state: 'ready',
    baseOid,
    sourceConversationId: 'source-chat',
    accountId: binding.accountId,
    model: binding.model,
    prompt: input.prompt,
    setupUrl: `/chat?repositoryPreparation=${draft.id}`,
  });
  expect(Object.keys(draft).sort()).toEqual(
    [
      'accountId',
      'baseBranch',
      'baseOid',
      'featureBranch',
      'id',
      'model',
      'prompt',
      'repository',
      'setupUrl',
      'sourceConversationId',
      'state',
    ].sort(),
  );
  expect(prepared!.content).not.toContain(root);
  const clones = () => vi.mocked(run).mock.calls.filter(([, args]) => args[0] === 'clone').length;
  expect(clones()).toBe(1);
  expect(inspect).toHaveBeenCalledOnce();

  // Simulate a lost tool receipt: the source chat recovers without an ID after restart.
  restart();
  const recovered = await tools.execute('GetRepositoryChatPreparation', {}, signal);
  expect(recovered?.isError).toBe(false);
  expect(JSON.parse(recovered!.content)).toEqual({ repositoryChat: draft });
  expect(clones()).toBe(1);
  expect(inspect).toHaveBeenCalledOnce();

  // The user starts the reviewed draft in another conversation; no live provider starts.
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot);
  const claimed = await service.claim(draft.id, binding, 'target-chat', taskRoot, false);
  const target = claimed.directory!;
  expect(target).not.toBe(origin);
  expect(git(target, 'branch', '--show-current')).toBe(draft.featureBranch);
  await writeFile(join(target, 'file.txt'), 'repository task change\n');
  await executeTrustedGitCommit(
    target,
    ['file.txt'],
    'task change',
    signal,
    undefined,
    undefined,
    undefined,
    await service.validateHostTask('target-chat', target),
  );
  const taskOid = git(target, 'rev-parse', 'HEAD');
  expect(taskOid).not.toBe(baseOid);
  expect(git(target, 'rev-list', '--count', 'origin/main..HEAD')).toBe('1');
  await service.releaseSource(draft.id, binding, 'target-chat');
  restart();

  const launched = await tools.execute('GetRepositoryChatPreparation', {}, signal);
  expect(launched?.isError).toBe(false);
  const claimedDraft = { ...draft, state: 'claimed', conversationId: 'target-chat' };
  expect(JSON.parse(launched!.content)).toEqual({ repositoryChat: claimedDraft });
  expect((await tools.execute('PrepareRepositoryChat', input, signal))?.content).toBe(
    launched!.content,
  );
  expect(clones()).toBe(1);
  expect(inspect).toHaveBeenCalledOnce();
  expect(await service.validateHostTask('target-chat', target)).toMatchObject({
    directory: target,
    featureBranch: draft.featureBranch,
  });
  expect(git(target, 'rev-parse', 'HEAD')).toBe(taskOid);

  expect(registry.findBySessionId('source-chat')?.session).toBe(sourceSession);
  expect(sourceSession).toMatchObject({
    sessionId: 'source-chat',
    cwd: origin,
    branch: 'existing-chat',
    accountBinding: binding,
    model: binding.model,
    mode: 'agent',
  });
  expect(sourceSession.abortController.signal.aborted).toBe(false);
  expect(git(origin, 'branch', '--show-current')).toBe('existing-chat');
  expect(git(origin, 'rev-parse', 'HEAD')).toBe(originalOid);
  expect(await readFile(join(origin, 'file.txt'), 'utf8')).toBe('original chat\n');
  expect(await readFile(join(upstream, 'file.txt'), 'utf8')).toBe('repository baseline\n');

  registry.register('other-client', {
    sessionId: 'other-source-chat',
    accountBinding: { ...binding },
    model: binding.model,
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const other = sessionCredentialTools(
    'other-source-chat',
    registry.get('other-client')!,
    registry,
  );
  for (const input of [{}, { preparationId: draft.id }]) {
    const denied = await other.execute('GetRepositoryChatPreparation', input, signal);
    expect(denied?.isError).toBe(true);
    expect(denied?.content).not.toContain(draft.setupUrl);
  }
  expect(clones()).toBe(1);
});
