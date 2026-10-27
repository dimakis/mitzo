import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreparedRepositoryWorkspaceOwner } from '../prepared-repository-workspace-owner.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

const probes = vi.hoisted(() => ({ enabled: false, paths: [] as string[] }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (probes.enabled) probes.paths.push(String(args[0]));
      return Reflect.apply(actual.lstatSync, actual, args);
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      if (probes.enabled) probes.paths.push(String(args[0]));
      return Reflect.apply(actual.realpathSync, actual, args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  probes.enabled = false;
  probes.paths.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['narrow', 'denied'] as const)(
  'defers every external source/common/admin host probe to the fresh %s read authority',
  async (mode) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'prepared-sync-scope-')));
    roots.push(root);
    const task = join(root, 'repo-task'),
      source = join(root, 'external-source'),
      common = join(source, '.git'),
      linked = join(common, 'worktrees', 'repo-task');
    mkdirSync(task);
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(task, '.git'), `gitdir: ${linked}\n`);
    const identity = (path: string) => {
      const s = lstatSync(path);
      return { dev: s.dev, ino: s.ino };
    };
    const taskIdentity = {
      directory: task,
      featureBranch: 'mitzo/fixture',
      root: identity(task),
      git: identity(join(task, '.git')),
      localSource: {
        path: source,
        root: identity(source),
        commonDirectory: common,
        commonRoot: identity(common),
      },
      linkedGit: { directory: linked, identity: identity(linked) },
    };
    const facts = {
      request: { conversationId: 'conversation', binding: { accountId: 'offline' } },
      newWorkspace: {
        kind: 'repository',
        id: 'workspace',
        directory: task,
        featureBranch: 'mitzo/fixture',
        taskIdentity,
      },
    } as unknown as import('../prepared-repository-transition.js').PreparedRepositoryTransitionFacts;
    const record = {
      id: 'workspace',
      conversationId: 'conversation',
      state: 'claimed',
      binding: facts.request.binding,
      directory: task,
      featureBranch: 'mitzo/fixture',
      taskIdentity,
      qualifiedLocalPreparation: { allocationFacts: { source: { gitDirectory: common } } },
    };
    const external = () => probes.paths.filter((p) => p === source || p.startsWith(source + '/'));
    const assertReadable = vi.fn(async (path: string) => {
      if (path !== task && !path.startsWith(task + '/'))
        throw Error('Selected read scope denies source');
    });
    const withReadAccess = vi.fn(
      async (
        _signal: AbortSignal,
        action: (access: LocalRepositoryReadAccess) => Promise<void>,
      ) => {
        expect(external()).toEqual([]);
        await action(
          new LocalRepositoryReadAccess({
            deadline: Date.now() + 30000,
            deniedRoots: mode === 'denied' ? [source] : [],
            assertReadable,
            captureReadAnchor: fixtureReadAnchor,
          }),
        );
      },
    );
    const owner = new PreparedRepositoryWorkspaceOwner(
      { getForConversation: () => record, assertPreparedRepositoryTransitionAdopted() {} } as never,
      facts,
      'child',
      { assertCurrentSync() {}, withReadAccess },
    );
    probes.enabled = true;
    owner.assertCurrentSync(task);
    expect(external()).toEqual([]);
    expect(withReadAccess).not.toHaveBeenCalled();
    await expect(owner.validate(task)).rejects.toThrow();
    expect(withReadAccess).toHaveBeenCalledOnce();
    expect(external()).toEqual([]);
    if (mode === 'narrow')
      expect(assertReadable.mock.calls.some(([path]) => path === source)).toBe(true);
  },
);

it('retains ordinary repository custody for an independent task after its historical source disappears', async () => {
  const { OrdinaryLocalWorkspaceOwner } = await import('../ordinary-local-workspace-owner.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'independent-ordinary-owner-')));
  roots.push(root);
  const task = join(root, 'repo-task');
  mkdirSync(task);
  mkdirSync(join(task, '.git'));
  const identity = (path: string) => {
    const info = lstatSync(path);
    return { dev: info.dev, ino: info.ino };
  };
  const binding = {
    accountId: 'offline',
    provider: 'openai-codex',
    profileRevision: 'profile',
    model: 'fixture',
  };
  const localSource = {
    path: join(root, 'retained-history-only'),
    commonDirectory: join(root, 'retained-history-only', '.git'),
    root: { dev: 1, ino: 1 },
    commonRoot: { dev: 1, ino: 2 },
  };
  const record = {
    id: 'workspace',
    state: 'claimed',
    conversationId: 'conversation',
    directory: task,
    binding,
    featureBranch: 'mitzo/fixture',
    localSource,
    taskIdentity: {
      directory: task,
      featureBranch: 'mitzo/fixture',
      root: identity(task),
      git: identity(join(task, '.git')),
      localSource,
    },
    hostReservation: { taskRoot: root, rootIdentity: identity(root) },
  };
  const validateHostTask = vi.fn(async () => {});
  const service = {
    getHostReservation: () => record,
    getForConversation: () => record,
    validateHostTask,
  };
  const owner = new OrdinaryLocalWorkspaceOwner(service as never, 'repository', {
    id: record.id,
    binding,
    conversationId: 'conversation',
    taskRoot: root,
  } as never);
  await owner.validate(task);
  expect(validateHostTask).toHaveBeenCalledWith('conversation', task);
});
