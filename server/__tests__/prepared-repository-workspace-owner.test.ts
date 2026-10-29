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
  lstat,
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
import { captureNativeTopologyAssertion } from '../local-repository-native-reader.js';

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

async function nativePhase(
  kind: 'linked' | 'standalone',
  gate?: { entered: string; release: string },
  linkedSource = false,
) {
  const f = await fixture(linkedSource, true);
  let task = f.task,
    identity = f.identity;
  if (kind === 'standalone') {
    task = join(f.root, 'independent');
    git(f.root, 'clone', '--no-hardlinks', '-q', f.source, task);
    git(task, 'checkout', '-qb', 'mitzo/independent');
    identity = {
      ...(await snapshotRepositoryTaskCheckout(task, 'mitzo/independent')),
      localSource: f.identity.localSource,
    };
  }
  let credential = true;
  const abort = new AbortController();
  const revalidate = vi.fn(async () => {
    abort.signal.throwIfAborted();
    if (!credential) throw Error('Current credential/account was revoked');
  });
  const spawns = vi.fn();
  const helper = vi
    .spyOn(sandbox, 'executePrivateRepositoryObservation')
    .mockImplementation(async (options) => {
      await options.beforeSpawnAsync?.();
      options.beforeSpawn?.();
      spawns();
      // Test-only scheduling hook wraps the fixed Git grammar parser. The exact
      // production helper and all of its anchored postconditions still execute.
      const prelude = gate
        ? `import subprocess, os, time\n_original = subprocess.run\ndef _gate(*args, **kwargs):\n    open(${JSON.stringify(gate.entered)}, 'w').close()\n    while not os.path.exists(${JSON.stringify(gate.release)}): time.sleep(.005)\n    return _original(*args, **kwargs)\nsubprocess.run = _gate\n`
        : '';
      const pending = promisify(execFile)(
        '/usr/bin/python3',
        ['-I', '-c', prelude + repositoryObservationProgram],
        {
          env: { PATH: '/usr/bin:/bin' },
          signal: options.signal,
          maxBuffer: options.maxOutputBytes,
        },
      );
      pending.child.stdin?.end(options.requestJson);
      const stdout = (await pending).stdout;
      onHelperResult();
      return { content: '', stdout, stderr: '', isError: false };
    });
  let onHelperResult = () => {};
  const scope = Object.freeze({
    readableRoots: Object.freeze(['/']),
    workspaceRoots: Object.freeze([task]),
    deniedRoots: Object.freeze([]),
  }) as unknown as NativeBaseReadScope;
  const reader = await captureLocalRepositoryReader(
    scope,
    abort.signal,
    () => abort.signal.throwIfAborted(),
    revalidate,
    { deadline: Date.now() + 30000 },
  );
  cleanups.push(() => reader.dispose());
  return {
    ...f,
    task,
    identity,
    helper,
    spawns,
    revalidate,
    reader,
    validate: () =>
      assertPreparedRepositoryTaskTopology(
        new LocalRepositoryReadAccess(reader),
        identity,
        f.sourceGitDirectory,
      ),
    afterResult(action: () => void) {
      onHelperResult = action;
    },
    revokeCredential() {
      credential = false;
    },
    cancel: () => abort.abort(),
  };
}

it.runIf(process.platform === 'darwin').each(['linked', 'standalone'] as const)(
  'owns one %s topology helper and exactly entry/post-effect credential checks',
  async (kind) => {
    const f = await nativePhase(kind);
    await f.validate();
    expect(f.helper).toHaveBeenCalledTimes(1);
    expect(f.revalidate).toHaveBeenCalledTimes(3); // Scratch, helper entry, helper result.
    const assertion = captureNativeTopologyAssertion(f.reader);
    expect(assertion).toBeDefined();
    expect(captureNativeTopologyAssertion(new Proxy(f.reader, {}))).toBeUndefined();
    expect(
      captureNativeTopologyAssertion(
        Object.freeze(
          Object.defineProperties({}, Object.getOwnPropertyDescriptors(f.reader)),
        ) as typeof f.reader,
      ),
    ).toBeUndefined();
    f.revokeCredential();
    await expect(f.validate()).rejects.toThrow();
    expect(f.helper).toHaveBeenCalledTimes(2); // Its pre-spawn credential check refuses.
    expect(f.spawns).toHaveBeenCalledTimes(1);
    expect(f.revalidate).toHaveBeenCalledTimes(4);
  },
);

it.runIf(process.platform === 'darwin').each(['credential', 'cancel'] as const)(
  'withholds topology success after %s changes during the owned helper effect',
  async (change) => {
    const f = await nativePhase('standalone');
    f.afterResult(change === 'credential' ? f.revokeCredential : f.cancel);
    await expect(f.validate()).rejects.toThrow();
    expect(f.helper).toHaveBeenCalledTimes(1);
  },
);

it
  .runIf(process.platform === 'darwin')
  .each(['config', 'head', 'gitfile', 'root', 'commondir'] as const)(
  'refuses %s substitution during the owned configuration parser wait',
  async (change) => {
    const schedule = await realpath(await mkdtemp(join(tmpdir(), 'topology-parser-gate-')));
    cleanups.push(() => rm(schedule, { recursive: true, force: true }));
    const entered = join(schedule, 'entered'),
      release = join(schedule, 'release');
    const f = await nativePhase(
      change === 'gitfile' || change === 'commondir' ? 'linked' : 'standalone',
      { entered, release },
    );
    const validation = f.validate();
    const settled = validation.then(
      () => ({ success: true }),
      () => ({ success: false }),
    );
    try {
      await vi.waitFor(async () =>
        expect(
          await lstat(entered).then(
            () => true,
            () => false,
          ),
        ).toBe(true),
      );
      if (change === 'config')
        await writeFile(join(f.task, '.git', 'config'), '[include]\npath=/outside\n');
      if (change === 'head')
        await writeFile(join(f.task, '.git', 'HEAD'), 'ref: refs/heads/changed\n');
      if (change === 'gitfile') await writeFile(join(f.task, '.git'), 'gitdir: /outside\n');
      if (change === 'commondir')
        await writeFile(join(f.identity.linkedGit!.directory, 'commondir'), '/outside\n');
      if (change === 'root') {
        await rename(f.task, f.task + '-retained');
        await symlink(f.task + '-retained', f.task);
      }
    } finally {
      await writeFile(release, 'release');
    }
    expect(await settled).toEqual({ success: false });
    expect(f.helper).toHaveBeenCalledTimes(1);
  },
);

it
  .runIf(process.platform === 'darwin')
  .each([
    '[include]\npath=/outside\n',
    '[includeIf "gitdir:/"]\npath=/outside\n',
    '[extensions]\nunknown=true\n',
    '[core]\nbare=true\n',
    '[core]\nworktree=/outside\n',
    '[extensions]\nobjectFormat=unknown\n',
    '[malformed\n',
  ])('retains Git grammar and unsafe topology configuration refusal: %s', async (config) => {
  const f = await nativePhase('standalone');
  await writeFile(join(f.task, '.git', 'config'), config);
  await expect(f.validate()).rejects.toThrow();
  expect(f.helper).toHaveBeenCalledTimes(1);
});

it
  .runIf(process.platform === 'darwin')
  .each(['packed-duplicate', 'packed-malformed', 'loose-unicode'] as const)(
  'retains bounded reference grammar refusal (%s)',
  async (change) => {
    const f = await nativePhase('standalone');
    const name = `refs/heads/${f.identity.featureBranch}`;
    const reference = join(f.task, '.git', name),
      oid = (await readFile(reference, 'utf8')).trim();
    if (change === 'loose-unicode') await writeFile(reference, '\u0085' + oid + '\u0085\n');
    else
      await writeFile(
        join(f.task, '.git', 'packed-refs'),
        change === 'packed-duplicate'
          ? `${oid} ${name}\n${oid} ${name}\n`
          : 'malformed packed reference\n',
      );
    await expect(f.validate()).rejects.toThrow();
    expect(f.helper).toHaveBeenCalledTimes(1);
  },
);

it.runIf(process.platform === 'darwin').each(['gitfile', 'commondir'] as const)(
  'preserves exact retained source %s newline grammar',
  async (change) => {
    const f = await nativePhase('linked', undefined, true);
    const path =
      change === 'gitfile' ? join(f.source, '.git') : join(f.sourceGitDirectory, 'commondir');
    const original = await readFile(path, 'utf8');
    for (const ending of ['\n\n', '\r\r\n']) {
      await writeFile(path, original.replace(/\n$/, ending));
      await expect(f.validate()).rejects.toThrow();
    }
    await writeFile(path, original.replace(/\n$/, '\r\n'));
    await f.validate(); // The existing one-CRLF form remains accepted.
    expect(f.spawns).toHaveBeenCalledTimes(3);
  },
);

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
  'validates standalone topology in one owned physical helper phase',
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
    expect(observation).toHaveBeenCalledTimes(1);
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
    expect(observation).toHaveBeenCalledTimes(2);
    await writeFile(join(task, '.git', 'commondir'), f.sourceGitDirectory + '\n');
    await expect(validate()).rejects.toThrow();
    expect(individual).not.toHaveBeenCalled();
  },
);
