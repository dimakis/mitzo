import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
  rename,
  symlink,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import * as sandbox from '../sandboxed-command.js';
import { captureLocalRepositoryReader } from '../local-repository-native-reader.js';
import { repositoryObservationProgram } from '../native-repository-observation.js';
import type { NativeBaseReadScope } from '../codex-conversation.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { assertPreparedRepositoryTaskTopology } from '../prepared-repository-workspace-owner.js';

vi.setConfig({ testTimeout: 20000 }); // Two sequential real descriptor-read checks plus disposable Git setup.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
async function fixture(linkedSource = false, native = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-prepared-owner-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let source = join(root, 'source');
  const seed = source,
    workspaceId = '12345678-1234-4234-8234-123456789abc',
    task = join(root, native ? 'repo-' + workspaceId : 'repo-fixture'),
    branch = native ? 'mitzo/repo-' + workspaceId : 'mitzo/fixture';
  await mkdir(source);
  git(source, 'init', '--template=', '-q', '-b', 'main');
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'task.txt'), 'Original source');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  if (linkedSource) {
    source = join(root, 'selected-source');
    git(seed, 'worktree', 'add', '-qb', 'selected-source', source);
  }
  git(source, 'worktree', 'add', '-qb', branch, task);
  const identity = await snapshotRepositoryTaskCheckout(task, branch, {
    repositoryId: 'fixture',
    path: source,
    root: numeric((await fixtureReadAnchor(source)).identity),
    commonDirectory: join(seed, '.git'),
    commonRoot: numeric((await fixtureReadAnchor(join(seed, '.git'))).identity),
  });
  let live = true;
  const access = (deniedRoots: string[] = []) =>
    new LocalRepositoryReadAccess({
      deadline: Date.now() + 30000,
      deniedRoots,
      assertReadable: async (path) => {
        if (!live || deniedRoots.some((root) => path === root || path.startsWith(root + '/')))
          throw Error('Current read authority refused');
      },
      captureReadAnchor: fixtureReadAnchor,
    });
  return {
    root,
    source,
    task,
    identity,
    sourceGitDirectory: git(source, 'rev-parse', '--absolute-git-dir'),
    access,
    revoke: () => {
      live = false;
    },
  };
}
function numeric(identity: { dev: string; ino: string }) {
  return { dev: Number(identity.dev), ino: Number(identity.ino) };
}

// Controlled descriptor-relative Python fixture I/O only. Production must use
// the original native factory; setup Git above is never the validator executor.
it('validates fresh task topology and permits dirty work plus later real add/commit without creation-hash locks', async () => {
  const f = await fixture();
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  await writeFile(join(f.task, 'task.txt'), 'New task work');
  git(f.task, 'add', '.');
  git(f.task, 'commit', '-qm', 'task commit');
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  expect(await readFile(join(f.source, 'task.txt'), 'utf8')).toBe('Original source');
});
it.each(['redirect', 'commondir', 'head', 'root', 'denied', 'revoked'] as const)(
  'refuses changed qualified task %s topology or read owner',
  async (change) => {
    const f = await fixture();
    if (change === 'redirect')
      await writeFile(join(f.task, '.git'), `gitdir: ${join(f.root, 'outside')}\n`);
    if (change === 'commondir')
      await writeFile(join(f.identity.linkedGit!.directory, 'commondir'), '/outside\n');
    if (change === 'head')
      await writeFile(join(f.identity.linkedGit!.directory, 'HEAD'), 'ref: refs/heads/main\n');
    if (change === 'root') {
      await rename(f.task, f.task + '-retained');
      await symlink(f.task + '-retained', f.task);
    }
    if (change === 'revoked') f.revoke();
    await expect(
      assertPreparedRepositoryTaskTopology(
        f.access(change === 'denied' ? [f.identity.linkedGit!.directory] : []),
        f.identity,
        f.sourceGitDirectory,
      ),
    ).rejects.toThrow();
  },
);

it('refuses a retargeted linked source .git while the original source and common roots remain', async () => {
  const f = await fixture(true);
  await assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory);
  const other = join(f.root, 'other');
  await mkdir(other);
  git(other, 'init', '--template=', '-q', '-b', 'main');
  await writeFile(join(f.source, '.git'), `gitdir: ${join(other, '.git')}\n`);
  await expect(
    assertPreparedRepositoryTaskTopology(f.access(), f.identity, f.sourceGitDirectory),
  ).rejects.toThrow();
});

it('retains persisted adoption and current owner around fresh physical validation without creation ref locks', async () => {
  const f = await fixture();
  const { PreparedRepositoryWorkspaceOwner } =
    await import('../prepared-repository-workspace-owner.js');
  const facts = {
    request: { conversationId: 'conversation', binding: { accountId: 'offline' } },
    newWorkspace: {
      kind: 'repository',
      id: 'workspace',
      directory: f.task,
      featureBranch: 'mitzo/fixture',
      taskIdentity: f.identity,
    },
  } as unknown as import('../prepared-repository-transition.js').PreparedRepositoryTransitionFacts;
  const record = {
    id: 'workspace',
    conversationId: 'conversation',
    binding: facts.request.binding,
    state: 'claimed',
    directory: f.task,
    featureBranch: 'mitzo/fixture',
    taskIdentity: f.identity,
    qualifiedLocalPreparation: {
      allocationFacts: { source: { gitDirectory: f.sourceGitDirectory } },
    },
  };
  let adopted = true,
    live = true;
  const service = {
    observePreparedRepositoryTransitionAdopted: vi.fn(() => {
      if (!adopted) throw Error('witness unavailable');
      return record;
    }),
  };
  const ports = {
    assertCurrentSync() {
      expect(this).toBe(ports);
      if (!live) throw Error('owner unavailable');
    },
    async withReadAccess(
      signal: AbortSignal,
      action: (access: LocalRepositoryReadAccess) => Promise<void>,
    ) {
      expect(this).toBe(ports);
      signal.throwIfAborted();
      await action(f.access());
    },
  };
  // Synthetic owner ports qualify only this component, not native authority.
  const owner = new PreparedRepositoryWorkspaceOwner(service as never, facts, 'child', ports);
  await owner.validate(f.task);
  expect(service.observePreparedRepositoryTransitionAdopted).toHaveBeenCalledWith(facts, 'child');
  await writeFile(join(f.task, 'task.txt'), 'New work');
  git(f.task, 'add', '.');
  git(f.task, 'commit', '-qm', 'new');
  await owner.revalidate(new AbortController().signal);
  adopted = false;
  expect(() => owner.assertCurrentSync(f.task)).toThrow();
  adopted = true;
  live = false;
  await expect(owner.validate(f.task)).rejects.toThrow();
});
it('withholds physical success if original current owner changes or returns malformed proof during validation', async () => {
  const f = await fixture();
  const { PreparedRepositoryWorkspaceOwner } =
    await import('../prepared-repository-workspace-owner.js');
  const facts = {
    request: { conversationId: 'conversation', binding: {} },
    newWorkspace: {
      kind: 'repository',
      id: 'workspace',
      directory: f.task,
      featureBranch: 'mitzo/fixture',
      taskIdentity: f.identity,
    },
  } as unknown as import('../prepared-repository-transition.js').PreparedRepositoryTransitionFacts;
  const record = {
    id: 'workspace',
    conversationId: 'conversation',
    binding: {},
    state: 'claimed',
    directory: f.task,
    featureBranch: 'mitzo/fixture',
    taskIdentity: f.identity,
    qualifiedLocalPreparation: {
      allocationFacts: { source: { gitDirectory: f.sourceGitDirectory } },
    },
  };
  const ports = {
    assertCurrentSync: () => {},
    async withReadAccess(
      _signal: AbortSignal,
      action: (access: LocalRepositoryReadAccess) => Promise<void>,
    ) {
      await action(f.access());
      ports.assertCurrentSync = () => {};
    },
  };
  const owner = new PreparedRepositoryWorkspaceOwner(
    {
      observePreparedRepositoryTransitionAdopted: () => record,
    } as never,
    facts,
    'child',
    ports,
  );
  await expect(owner.validate(f.task)).rejects.toThrow();
});

it.skipIf(process.platform !== 'darwin')(
  'uses a genuine factory topology observation after commits without consuming large index or reflog bytes',
  async () => {
    const f = await fixture(false, true);
    vi.spyOn(sandbox, 'executePrivateRepositoryObservation').mockImplementation(async (options) => {
      const pending = promisify(execFile)(
        '/usr/bin/python3',
        ['-I', '-c', repositoryObservationProgram],
        {
          env: { PATH: '/usr/bin:/bin' },
          signal: options.signal,
          maxBuffer: options.maxOutputBytes,
        },
      );
      pending.child.stdin?.end(options.requestJson);
      return { content: '', stdout: (await pending).stdout, stderr: '', isError: false };
    });
    const abort = new AbortController();
    const scope = Object.freeze({
      readableRoots: Object.freeze(['/']),
      workspaceRoots: Object.freeze([f.task]),
      deniedRoots: Object.freeze([]),
    }) as unknown as NativeBaseReadScope;
    const validate = async () => {
      const reader = await captureLocalRepositoryReader(
        scope,
        abort.signal,
        () => abort.signal.throwIfAborted(),
        async () => abort.signal.throwIfAborted(),
        { deadline: Date.now() + 30000 },
      );
      try {
        await assertPreparedRepositoryTaskTopology(
          new LocalRepositoryReadAccess(reader),
          f.identity,
          f.sourceGitDirectory,
        );
      } finally {
        await reader.dispose();
      }
    };
    await validate();
    await writeFile(join(f.task, 'task.txt'), 'Later task commit');
    git(f.task, 'add', '.');
    git(f.task, 'commit', '-qm', 'later');
    const indexPath = join(f.identity.linkedGit!.directory, 'index');
    const original = await readFile(indexPath),
      extension = Buffer.alloc(17 * 1024 * 1024 + 8);
    extension.write('XMIT', 0);
    extension.writeUInt32BE(extension.length - 8, 4);
    const content = Buffer.concat([original.subarray(0, -20), extension]);
    await writeFile(
      indexPath,
      Buffer.concat([content, createHash('sha1').update(content).digest()]),
    );
    // Git accepts uppercase optional index extensions; this remains a valid index.
    expect(git(f.task, 'ls-files', '--stage')).toContain('task.txt');
    const log = join(
      f.identity.localSource!.commonDirectory,
      'logs',
      'refs',
      'heads',
      f.identity.featureBranch,
    );
    const line = await readFile(log);
    await writeFile(
      log,
      Buffer.concat(Array.from({ length: Math.ceil((128 * 1024) / line.length) }, () => line)),
    );
    await validate();
    abort.abort();
    await expect(validate()).rejects.toThrow();
  },
);

it('keeps an independent task usable after source disposal and refuses shallow metadata redirection', async () => {
  const f = await fixture();
  const task = join(f.root, 'independent');
  git(f.root, 'clone', '--no-hardlinks', '-q', f.source, task);
  git(task, 'checkout', '-qb', 'mitzo/independent');
  const identity = {
    ...(await snapshotRepositoryTaskCheckout(task, 'mitzo/independent')),
    localSource: f.identity.localSource,
  };
  await rm(f.task, { recursive: true });
  await rm(f.source, { recursive: true });
  await assertPreparedRepositoryTaskTopology(f.access(), identity, f.sourceGitDirectory);
  const outside = join(f.root, 'outside-shallow');
  await writeFile(outside, git(task, 'rev-parse', 'HEAD') + '\n');
  await symlink(outside, join(task, '.git', 'shallow'));
  await expect(
    assertPreparedRepositoryTaskTopology(f.access(), identity, f.sourceGitDirectory),
  ).rejects.toThrow();
});

it.skipIf(process.platform !== 'darwin')(
  'validates standalone topology with one fresh bounded native observation and verification',
  async () => {
    const f = await fixture();
    const task = join(f.root, 'independent');
    git(f.root, 'clone', '--no-hardlinks', '-q', f.source, task);
    git(task, 'checkout', '-qb', 'mitzo/independent');
    git(task, 'config', 'user.name', 'Offline');
    git(task, 'config', 'user.email', 'offline@example.invalid');
    const identity = {
      ...(await snapshotRepositoryTaskCheckout(task, 'mitzo/independent')),
      localSource: f.identity.localSource,
    };
    await rm(f.task, { recursive: true });
    await rm(f.source, { recursive: true });
    await writeFile(join(task, 'untracked-large'), Buffer.alloc(17 * 1024 * 1024));
    const indexPath = join(task, '.git', 'index'),
      original = await readFile(indexPath),
      extension = Buffer.alloc(17 * 1024 * 1024 + 8);
    extension.write('XMIT', 0);
    extension.writeUInt32BE(extension.length - 8, 4);
    const indexContent = Buffer.concat([original.subarray(0, -20), extension]);
    await writeFile(
      indexPath,
      Buffer.concat([indexContent, createHash('sha1').update(indexContent).digest()]),
    );

    const observation = vi
      .spyOn(sandbox, 'executePrivateRepositoryObservation')
      .mockImplementation(async (options) => {
        const pending = promisify(execFile)(
          '/usr/bin/python3',
          ['-I', '-c', repositoryObservationProgram],
          {
            env: { PATH: '/usr/bin:/bin' },
            signal: options.signal,
            maxBuffer: options.maxOutputBytes,
          },
        );
        pending.child.stdin?.end(options.requestJson);
        return { content: '', stdout: (await pending).stdout, stderr: '', isError: false };
      });
    const individual = vi
      .spyOn(sandbox, 'executePrivateNativeFileHelper')
      .mockImplementation(async () => {
        throw Error('Standalone topology must use its bounded native observation');
      });
    const abort = new AbortController();
    const scope = Object.freeze({
      readableRoots: Object.freeze(['/']),
      workspaceRoots: Object.freeze([task]),
      deniedRoots: Object.freeze([]),
    }) as unknown as NativeBaseReadScope;
    const validate = async () => {
      const reader = await captureLocalRepositoryReader(
        scope,
        abort.signal,
        () => abort.signal.throwIfAborted(),
        async () => abort.signal.throwIfAborted(),
        { deadline: Date.now() + 30000 },
      );
      try {
        await assertPreparedRepositoryTaskTopology(
          new LocalRepositoryReadAccess(reader),
          identity,
          f.sourceGitDirectory,
        );
      } finally {
        await reader.dispose();
      }
    };
    await validate();
    expect(observation).toHaveBeenCalledTimes(2);
    const captured = JSON.parse(
      JSON.parse((await observation.mock.results[0].value).stdout!).content,
    ).data;
    expect(
      captured.entries.every(
        (item: { path: string }) => item.path === task || item.path.startsWith(task + '/'),
      ),
    ).toBe(true);
    expect(
      captured.files.some(
        (item: { path: string }) =>
          item.path === indexPath || item.path === join(task, 'untracked-large'),
      ),
    ).toBe(false);
    expect(individual).not.toHaveBeenCalled();
    await writeFile(join(task, 'task.txt'), 'Later commit');
    git(task, 'add', 'task.txt');
    git(task, 'commit', '-qm', 'advance independent task');
    await validate();
    expect(observation).toHaveBeenCalledTimes(4);
    await writeFile(join(task, '.git', 'commondir'), f.sourceGitDirectory + '\n');
    await expect(validate()).rejects.toThrow();
    expect(individual).not.toHaveBeenCalled();
  },
);
