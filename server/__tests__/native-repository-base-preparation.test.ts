import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  mkdir,
  readFile,
  readdir,
  lstat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import type { LocalRepositoryReadAuthority } from '../local-repository-read-access.js';
import { captureLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import { materializeQualifiedLocalRepositoryTask } from '../qualified-local-repository-actor.js';
import { repositorySourceIdentity } from '../local-repository-base.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { captureQualifiedLocalRepositoryTask } from '../qualified-local-repository-task.js';
import { nativeFileHelperProgram } from '../native-file-operation.js';
import { executeTrustedGitCommit } from '../trusted-native-operation.js';
import {
  preparationObjectStoreCommand,
  parsePreparationObjectStoreCapture,
} from '../native-repository-object-store.js';
const nativeContainerContexts = new WeakSet<NativeHostToolContext>();

// Current native owner/transport is synthetic here; Git stores, source changes,
// object closure and the fixed publication helper operate on real offline data.
vi.mock('../native-host-tool-context.js', () => ({
  captureNativeHostReadOwner: (context: NativeHostToolContext) => ({
    context,
    scope: context.nativeBaseReadScope,
    signal: context.signal,
    assertCurrentSync: context.assertCurrentSync,
    assertCurrent: context.assertCurrent,
  }),
  assertNativeHostReadCurrentSync() {},
}));
vi.mock('../local-repository-native-read.js', () => ({
  captureNativeLocalRepositoryReader: async (
    context: NativeHostToolContext,
    options: { deadline: number },
  ) =>
    ({
      deniedRoots: [],
      signal: context.signal,
      deadline: options.deadline,
      assertCurrentSync: context.assertCurrentSync,
      async assertReadable() {},
      async revalidate() {
        await context.assertCurrent();
      },
      captureReadAnchor: fixtureReadAnchor,
      ...(nativeContainerContexts.has(context)
        ? (() => {
            const captures = new WeakMap<object, object>();
            return {
              async capturePreparationObjectStore(
                source: import('../native-file-operation.js').NativeReadAnchor,
                objectFormat: 'sha1' | 'sha256',
              ) {
                const directory = await realpath(
                  await mkdtemp(join(tmpdir(), 'native-container-capture-')),
                );
                roots.push(directory);
                const target = await fixtureReadAnchor(directory);
                const plan = {
                  version: 'preparation-object-store-v1',
                  source,
                  target,
                  objectFormat,
                  deniedRoots: [],
                };
                const result = await execute(
                  '/bin/sh',
                  ['-c', preparationObjectStoreCommand({ operation: 'capture', plan })],
                  { env, signal: context.signal, maxBuffer: 4 * 1024 * 1024 },
                );
                const captured = parsePreparationObjectStoreCapture(
                  JSON.parse(result.stdout),
                  target,
                );
                captures.set(captured, plan);
                return captured;
              },
              async verifyPreparationObjectStore(
                captured: import('../native-repository-object-store.js').PreparationObjectStoreCapture,
              ) {
                const plan = captures.get(captured);
                if (!plan) throw Error('Unknown captured store');
                const verified = await execute(
                  '/bin/sh',
                  [
                    '-c',
                    preparationObjectStoreCommand({
                      operation: 'verify',
                      plan,
                      digest: captured.digest,
                    }),
                  ],
                  { env, signal: context.signal, maxBuffer: 4096 },
                );
                if (JSON.parse(verified.stdout).verified !== true)
                  throw Error('Object store verification refused');
              },
            };
          })()
        : {}),
      async dispose() {},
    }) satisfies LocalRepositoryReadAuthority & { dispose(): Promise<void> },
}));
vi.mock('../sandboxed-command.js', async (original) => ({
  ...(await original<typeof import('../sandboxed-command.js')>()),
  executePrivateNativeFileHelper: async (input: {
    requestJson: string;
    signal: AbortSignal;
    timeoutMs: number;
  }) => {
    const pending = execute('/usr/bin/python3', ['-I', '-c', nativeFileHelperProgram], {
      signal: input.signal,
      maxBuffer: 32768,
    });
    pending.child.stdin?.end(input.requestJson);
    const result = await pending;
    return { stdout: result.stdout, isError: false };
  },
  executePrivateRepositoryStagingCheckout: async (input: {
    scratchAnchor: { rootPath: string };
    signal: AbortSignal;
    baseOid: string;
  }) => {
    const directory = input.scratchAnchor.rootPath;
    await execute(
      '/usr/bin/git',
      [
        '--git-dir',
        join(directory, 'git-admin'),
        '--work-tree',
        join(directory, 'checkout'),
        '-c',
        'core.bare=false',
        'read-tree',
        input.baseOid,
      ],
      { env, signal: input.signal },
    );
    await execute(
      '/usr/bin/git',
      [
        '--git-dir',
        join(directory, 'git-admin'),
        '--work-tree',
        join(directory, 'checkout'),
        '-c',
        'core.bare=false',
        'checkout-index',
        '--all',
      ],
      { env, signal: input.signal },
    );
  },
}));
const execute = promisify(execFile),
  roots: string[] = [];
const env = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const git = async (cwd: string, ...args: string[]) =>
  (await execute('/usr/bin/git', ['-C', cwd, ...args], { env })).stdout.trim();
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-fresh-base-')));
  roots.push(root);
  const source = join(root, 'source'),
    tasks = join(root, 'tasks'),
    remote = join(root, 'remote.git');
  await mkdir(tasks);
  await git(root, 'init', '-q', '-b', 'main', source);
  await git(source, 'config', 'user.name', 'Offline');
  await git(source, 'config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'code.txt'), 'previous');
  await git(source, 'add', '.');
  await git(source, 'commit', '-qm', 'first');
  const previous = await git(source, 'rev-parse', 'HEAD');
  await git(root, 'clone', '-q', '--bare', source, remote);
  await git(source, 'remote', 'add', 'origin', remote);
  await writeFile(join(source, 'code.txt'), 'fresh main');
  await git(source, 'commit', '-qam', 'advance');
  await git(source, 'push', '-q', 'origin', 'main');
  const latest = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'checkout', '-qb', 'feature', previous);
  await writeFile(join(source, 'unfinished.txt'), 'keep');
  await git(source, 'remote', 'set-url', 'origin', 'https://example.invalid/team/repo.git');
  const context = {
    signal: new AbortController().signal,
    nativeBaseReadScope: { deniedRoots: [] },
    assertCurrentSync() {},
    async assertCurrent() {},
  } as unknown as NativeHostToolContext;
  const authorizeRemote = vi.fn(
    async () => async (args: readonly string[], signal: AbortSignal) =>
      execute(
        '/usr/bin/git',
        args.map((arg) =>
          arg === 'https://example.invalid/team/repo.git'
            ? remote
            : arg === 'protocol.allow=never'
              ? 'protocol.allow=always'
              : arg,
        ),
        { env, signal },
      ),
  );
  return { root, source, tasks, previous, latest, context, authorizeRemote };
}

it('pins fresh remote main before approval, then independently materializes it without source Git effects', async () => {
  const f = await fixture(),
    workspaceId = randomUUID();
  const held = await captureNativeLocalRepositoryPreparationSource(
    f.context,
    { workspaceId, sourcePath: f.source, taskRoot: f.tasks, base: { kind: 'default' } },
    { deadline: Date.now() + 60000, authorizeRemote: f.authorizeRemote },
  );
  try {
    expect(held.baseOid).toBe(f.latest);
    expect(held.baseBranch).toBe('main');
    expect(held.allocationFacts.layout).toBe('standalone');
    expect(held.allocationFacts.directories.map((entry) => entry.directory)).toEqual([
      join(f.tasks, `repo-${workspaceId}`),
    ]);
    await held.assertCurrent();
    const request = { id: workspaceId } as never;
    const objects = await captureLocalRepositoryPreparationObjectData(
      f.context,
      request,
      held.allocationFacts,
      held.allocationFactsSha256,
      Date.now() + 60000,
      held.publicationPackedRefs,
      held.objectSource,
    );
    try {
      const result = await materializeQualifiedLocalRepositoryTask({
        context: f.context,
        facts: held.allocationFacts,
        factsSha256: held.allocationFactsSha256,
        requestSha256: (await import('../pending-host-task.js')).pendingHostTaskDecisionHash(
          request,
        ),
        scopeSha256: 'b'.repeat(64),
        expiresAt: Date.now() + 60000,
        objects,
        publicationPackedRefs: held.publicationPackedRefs,
        assertCurrentSync() {},
        async assertCurrent() {
          await held.assertCurrent();
        },
      });
      expect(result.taskIdentity.linkedGit).toBeUndefined();
      expect(await git(result.taskIdentity.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
      expect(await readFile(join(result.taskIdentity.directory, 'code.txt'), 'utf8')).toBe(
        'fresh main',
      );
      // Exercise the first approved commit against the actual independently
      // prepared metadata. No Git command or privileged mkdir repairs it first.
      const task = result.taskIdentity;
      await writeFile(join(task.directory, 'code.txt'), 'prepared task change');
      await writeFile(join(task.directory, 'unselected.txt'), 'retain unrelated work');
      await executeTrustedGitCommit(
        task.directory,
        ['code.txt'],
        'fix: first prepared task change',
        f.context.signal,
        undefined,
        undefined,
        undefined,
        task,
      );
      expect(await git(task.directory, 'show', '--format=', '--name-only', 'HEAD')).toBe(
        'code.txt',
      );
      expect(await git(task.directory, 'status', '--porcelain')).toBe('?? unselected.txt');
      expect(
        (await lstat(join(task.directory, '.git', 'logs', 'refs', 'heads', 'mitzo'))).isDirectory(),
      ).toBe(true);
      expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.previous);
      expect(await git(f.source, 'status', '--porcelain')).toContain('unfinished.txt');
    } finally {
      await objects.dispose();
    }
  } finally {
    await held.dispose?.();
  }
}, 60000);

it('selects explicit local HEAD with no network acquisition', async () => {
  const f = await fixture();
  const held = await captureNativeLocalRepositoryPreparationSource(
    f.context,
    {
      workspaceId: randomUUID(),
      sourcePath: f.source,
      taskRoot: f.tasks,
      base: { kind: 'ref', ref: 'HEAD' },
    },
    { deadline: Date.now() + 30000, authorizeRemote: f.authorizeRemote },
  );
  expect(held.baseOid).toBe(f.previous);
  expect(f.authorizeRemote).not.toHaveBeenCalled();
  await held.assertCurrent();
}, 15000);

it.each(['clone', 'new'] as const)(
  'materializes a %s source through the same independent actor and remains adoptable after source disposal',
  async (kind) => {
    const f = await fixture(),
      workspaceId = randomUUID();
    const source =
      kind === 'clone'
        ? { kind: 'clone' as const, url: 'https://example.invalid/team/repo.git' }
        : { kind: 'new' as const, name: 'unrelated-project' };
    const held = await captureNativeLocalRepositoryPreparationSource(
      f.context,
      {
        workspaceId,
        sourcePath: repositorySourceIdentity(source),
        source,
        taskRoot: f.tasks,
        base: { kind: 'default' },
      },
      { deadline: Date.now() + 120000, authorizeRemote: f.authorizeRemote },
    );
    const request = { id: workspaceId } as never;
    const objects = await captureLocalRepositoryPreparationObjectData(
      f.context,
      request,
      held.allocationFacts,
      held.allocationFactsSha256,
      Date.now() + 120000,
      held.publicationPackedRefs,
      held.objectSource,
    );
    const result = await materializeQualifiedLocalRepositoryTask({
      context: f.context,
      facts: held.allocationFacts,
      factsSha256: held.allocationFactsSha256,
      requestSha256: (await import('../pending-host-task.js')).pendingHostTaskDecisionHash(request),
      scopeSha256: 'b'.repeat(64),
      expiresAt: Date.now() + 120000,
      objects,
      publicationPackedRefs: held.publicationPackedRefs,
      assertCurrentSync() {},
      async assertCurrent() {
        f.context.assertCurrentSync();
      },
    });
    await objects.dispose();
    await held.dispose?.();
    const access = new LocalRepositoryReadAccess({
      deniedRoots: [],
      deadline: Date.now() + 30000,
      async assertReadable() {},
      captureReadAnchor: fixtureReadAnchor,
    });
    expect(
      await captureQualifiedLocalRepositoryTask(access, held.allocationFacts, result.publication),
    ).toEqual(result.taskIdentity);
    expect(result.taskIdentity.linkedGit).toBeUndefined();
    expect(await git(result.taskIdentity.directory, 'rev-parse', '--git-common-dir')).toBe('.git');
    if (kind === 'clone') {
      expect(await git(result.taskIdentity.directory, 'rev-parse', 'HEAD')).toBe(f.latest);
      expect(await git(result.taskIdentity.directory, 'config', 'remote.origin.url')).toBe(
        source.kind === 'clone' ? source.url : '',
      );
    } else {
      expect(await git(result.taskIdentity.directory, 'remote')).toBe('');
      expect(f.authorizeRemote).not.toHaveBeenCalled();
    }
  },
  120000,
);

it.each([1, 2])(
  'preserves depth%s shallow local HEAD history in an independent task without touching dirty source',
  async (depth) => {
    const f = await fixture();
    const source = join(f.root, 'shallow-source');
    await git(
      f.root,
      'clone',
      `--depth=${depth}`,
      '-q',
      `file://${join(f.root, 'remote.git')}`,
      source,
    );
    await writeFile(join(source, 'unfinished.txt'), 'Retain shallow source work');
    const originalStatus = await git(source, 'status', '--porcelain');
    const originalLog = await git(source, 'log', '--format=%H');
    const originalShallow = await readFile(join(source, '.git', 'shallow'), 'utf8');
    const workspaceId = randomUUID();
    const held = await captureNativeLocalRepositoryPreparationSource(
      f.context,
      {
        workspaceId,
        sourcePath: source,
        taskRoot: f.tasks,
        base: { kind: 'ref', ref: 'HEAD' },
      },
      { deadline: Date.now() + 120000, authorizeRemote: f.authorizeRemote },
    );
    const request = { id: workspaceId } as never;
    const objects = await captureLocalRepositoryPreparationObjectData(
      f.context,
      request,
      held.allocationFacts,
      held.allocationFactsSha256,
      Date.now() + 120000,
      held.publicationPackedRefs,
      held.objectSource,
    );
    try {
      const result = await materializeQualifiedLocalRepositoryTask({
        context: f.context,
        facts: held.allocationFacts,
        factsSha256: held.allocationFactsSha256,
        requestSha256: (await import('../pending-host-task.js')).pendingHostTaskDecisionHash(
          request,
        ),
        scopeSha256: 'b'.repeat(64),
        expiresAt: Date.now() + 120000,
        objects,
        publicationPackedRefs: held.publicationPackedRefs,
        assertCurrentSync() {},
        async assertCurrent() {
          await held.assertCurrent();
        },
      });
      expect(await git(result.taskIdentity.directory, 'log', '--format=%H')).toBe(originalLog);
      expect(await git(result.taskIdentity.directory, 'rev-parse', '--is-shallow-repository')).toBe(
        'true',
      );
      expect(await readFile(join(result.taskIdentity.directory, '.git', 'shallow'), 'utf8')).toBe(
        originalShallow,
      );
      expect(await git(source, 'status', '--porcelain')).toBe(originalStatus);
      expect(await readFile(join(source, '.git', 'shallow'), 'utf8')).toBe(originalShallow);
      expect(await readFile(join(source, 'unfinished.txt'), 'utf8')).toBe(
        'Retain shallow source work',
      );
      expect(f.authorizeRemote).not.toHaveBeenCalled();
    } finally {
      await objects.dispose();
      await held.dispose?.();
    }
  },
  120000,
);

it('publishes a valid historical Git pack over16MiB while keeping selected tracked leaves small', async () => {
  const f = await fixture();
  nativeContainerContexts.add(f.context);
  await git(f.source, 'checkout', 'main');
  for (let n = 0; n < 3; n++)
    await writeFile(join(f.source, `history-${n}.bin`), randomBytes(6 * 1024 * 1024));
  await git(f.source, 'add', 'history-0.bin', 'history-1.bin', 'history-2.bin');
  await git(f.source, 'commit', '-qm', 'historical objects');
  const historical = await git(f.source, 'rev-parse', 'HEAD');
  await git(f.source, 'rm', '-q', 'history-0.bin', 'history-1.bin', 'history-2.bin');
  await git(f.source, 'commit', '-qm', 'small selected tree');
  await git(f.source, 'repack', '-ad');
  const selected = await git(f.source, 'rev-parse', 'HEAD'),
    originalStatus = await git(f.source, 'status', '--porcelain');
  const pack = (await readdir(join(f.source, '.git', 'objects', 'pack'))).find((name) =>
    name.endsWith('.pack'),
  )!;
  expect((await lstat(join(f.source, '.git', 'objects', 'pack', pack))).size).toBeGreaterThan(
    16 * 1024 * 1024,
  );
  const workspaceId = randomUUID();
  const held = await captureNativeLocalRepositoryPreparationSource(
    f.context,
    { workspaceId, sourcePath: f.source, taskRoot: f.tasks, base: { kind: 'ref', ref: 'HEAD' } },
    { deadline: Date.now() + 120000 },
  );
  const request = { id: workspaceId } as never;
  const objects = await captureLocalRepositoryPreparationObjectData(
    f.context,
    request,
    held.allocationFacts,
    held.allocationFactsSha256,
    Date.now() + 120000,
    held.publicationPackedRefs,
    held.objectSource,
  );
  try {
    const result = await materializeQualifiedLocalRepositoryTask({
      context: f.context,
      facts: held.allocationFacts,
      factsSha256: held.allocationFactsSha256,
      requestSha256: (await import('../pending-host-task.js')).pendingHostTaskDecisionHash(request),
      scopeSha256: 'b'.repeat(64),
      expiresAt: Date.now() + 120000,
      objects,
      publicationPackedRefs: held.publicationPackedRefs,
      assertCurrentSync() {},
      async assertCurrent() {
        await held.assertCurrent();
      },
    });
    expect(await git(result.taskIdentity.directory, 'rev-parse', 'HEAD')).toBe(selected);
    expect(await git(result.taskIdentity.directory, 'log', '--format=%H')).toContain(historical);
    expect(
      await git(result.taskIdentity.directory, 'cat-file', '-s', `${historical}:history-0.bin`),
    ).toBe(String(6 * 1024 * 1024));
    expect(await readFile(join(result.taskIdentity.directory, 'code.txt'), 'utf8')).toBe(
      'fresh main',
    );
    expect(await git(f.source, 'status', '--porcelain')).toBe(originalStatus);
  } finally {
    await objects.dispose();
    await held.dispose?.();
  }
}, 120000);
