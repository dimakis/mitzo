import { build, version as compilerVersion } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as childProcess from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  publishNativePreparedRepository,
  projectNativePreparationPublicationPlan,
  nativePreparationPublicationWriteRoots,
  type NativePreparationPublicationPlan,
} from '../native-preparation-publication.js';
import { executePrivateNativeFileHelper } from '../sandboxed-command.js';
import { executeNativeFileOperation } from '../native-file-operation.js';
import type { NativeFileHelperTransport } from '../native-file-operation.js';
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(
    (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn,
  ),
}));
let root: string;
const id = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-prepared-phase-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const workspaceId = randomUUID(),
    sourcePath = join(root, 'source'),
    scratch = join(root, 'owned'),
    common = join(sourcePath, '.git'),
    tasks = join(root, 'tasks');
  await mkdir(join(common, 'refs', 'heads', 'mitzo'), { recursive: true });
  await mkdir(scratch);
  await mkdir(tasks);
  const commonAnchor = { rootPath: common, identity: await id(common) },
    taskRoot = { rootPath: tasks, identity: await id(tasks) },
    scratchAnchor = { rootPath: scratch, identity: await id(scratch) };
  const staging = join(scratch, 'checkout');
  await mkdir(staging);
  await writeFile(join(staging, 'task.txt'), 'TRACKED\n', { mode: 0o644 });
  const admin = join(common, 'worktrees', `repo-${workspaceId}`),
    task = join(tasks, `repo-${workspaceId}`),
    reference = join(common, 'refs', 'heads', 'mitzo', `repo-${workspaceId}`);
  const contents = [
    `ref: refs/heads/mitzo/repo-${workspaceId}\n`,
    '../..\n',
    join(task, '.git') + '\n',
    'INDEX\n',
    'a'.repeat(40) + '\n',
    `gitdir: ${admin}\n`,
  ];
  const metadata = [];
  for (let n = 0; n < 6; n++) {
    const path = join(scratch, 'payload-' + n);
    await writeFile(path, contents[n]);
    metadata.push({
      file_path: path,
      rootAnchor: scratchAnchor,
      parentIdentity: scratchAnchor.identity,
      identity: await id(path),
      size: Buffer.byteLength(contents[n]),
      sha256: sha(contents[n]),
    });
  }
  const existingDirectories = [];
  for (const directory of [
    tasks,
    common,
    join(common, 'refs'),
    join(common, 'refs', 'heads'),
    join(common, 'refs', 'heads', 'mitzo'),
  ])
    existingDirectories.push({ directory, identity: await id(directory) });
  const plan: NativePreparationPublicationPlan = {
    version: 'prepared-repository-publication-v1',
    requestSha256: '1'.repeat(64),
    allocationFactsSha256: '2'.repeat(64),
    scopeSha256: '3'.repeat(64),
    workspaceId,
    baseOid: 'a'.repeat(40),
    sourcePath,
    sourceAnchor: { rootPath: sourcePath, identity: await id(sourcePath) },
    commonAnchor,
    taskRoot,
    directories: [
      {
        directory: task,
        rootAnchor: taskRoot,
        parent: { kind: 'existing', directory: tasks, identity: taskRoot.identity },
      },
      {
        directory: join(common, 'worktrees'),
        rootAnchor: commonAnchor,
        parent: { kind: 'existing', directory: common, identity: commonAnchor.identity },
      },
    ],
    existingDirectories,
    packedRefs: { kind: 'absent' },
    tree: {
      payload: {
        file_path: staging,
        rootAnchor: scratchAnchor,
        parentIdentity: scratchAnchor.identity,
        identity: await id(staging),
      },
      entries: [
        {
          path: 'task.txt',
          mode: '100644',
          identity: await id(join(staging, 'task.txt')),
          size: 8,
          sha256: sha('TRACKED\n'),
        },
      ],
    },
    metadata,
    deniedRoots: [],
  };
  const owner = { assertCurrentSync() {}, async revalidate() {} };
  const launches = vi.fn<NativeFileHelperTransport>(async (invocation) => {
    const result = await executePrivateNativeFileHelper({
      requestJson: invocation.requestJson,
      cwd: scratch,
      writableRoots: nativePreparationPublicationWriteRoots(plan),
      deniedRoots: plan.deniedRoots,
      signal: invocation.signal,
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
      ...owner,
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
  return { plan, launches, owner, task, admin, reference, scratch, common, contents };
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'publishes planned directories, task tree and six metadata files in ONE fixed phase',
  async () => {
    const f = await fixture();
    const receipt = await publishNativePreparedRepository(
      f.plan,
      new AbortController().signal,
      15000,
      f.launches,
    );
    expect(f.launches).toHaveBeenCalledOnce();
    expect(receipt.directories).toHaveLength(3);
    expect(receipt.files).toHaveLength(6);
    expect(await readFile(join(f.task, 'task.txt'), 'utf8')).toBe('TRACKED\n');
    expect(await readFile(f.reference, 'utf8')).toBe(f.contents[4]);
    expect(await readFile(join(f.admin, 'index'), 'utf8')).toBe('INDEX\n');
    expect(await readFile(join(f.task, '.git'), 'utf8')).toBe(f.contents[5]);
  },
  30000,
);
actual.each(['last-occupied', 'last-payload', 'existing-parent', 'packed-shadow'] as const)(
  'whole fixed phase preflight refuses %s before ANY directory creation',
  async (change) => {
    const f = await fixture();
    if (change === 'last-occupied') await writeFile(f.reference, 'FOREIGN');
    if (change === 'last-payload') await writeFile(f.plan.metadata[5].file_path, 'CHANGED');
    if (change === 'existing-parent') {
      const parent = dirname(f.reference);
      await rename(parent, parent + '-retained');
      await mkdir(parent);
    }
    if (change === 'packed-shadow')
      await writeFile(
        join(f.common, 'packed-refs'),
        `${'b'.repeat(40)} refs/heads/mitzo/repo-${f.plan.workspaceId}\n`,
      );
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.common, 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (change === 'last-occupied') expect(await readFile(f.reference, 'utf8')).toBe('FOREIGN');
  },
  30000,
);
it('rejects coercion/accessors, directory adoption, mixed paths, malformed correlation and overlimit whole plans before transport', async () => {
  const f = await fixture(),
    launch = vi.fn();
  for (const change of [
    { ...f.plan, scopeSha256: 'invalid' },
    { ...f.plan, metadata: f.plan.metadata.slice(0, 5) },
    { ...f.plan, directories: [...f.plan.directories, f.plan.directories[0]] },
    {
      ...f.plan,
      tree: { ...f.plan.tree, entries: [{ ...f.plan.tree.entries[0], path: '../escape' }] },
    },
    {
      ...f.plan,
      directories: f.plan.directories.map((step) => ({
        ...step,
        directory: join(root, 'foreign'),
      })),
    },
  ])
    await expect(
      publishNativePreparedRepository(change as never, new AbortController().signal, 15000, launch),
    ).rejects.toThrow();
  const getter = vi.fn();
  const bad = Object.defineProperty({ ...f.plan }, 'metadata', { get: getter });
  expect(() => projectNativePreparationPublicationPlan(bad)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
it('keeps exact original grants and refuses missing private transport', async () => {
  const f = await fixture();
  const roots = nativePreparationPublicationWriteRoots(f.plan);
  expect(roots.map((item) => item.path)).toEqual([
    f.scratch,
    f.task,
    join(f.common, 'worktrees'),
    f.reference,
  ]);
  expect(roots.some((item) => item.path === f.common || item.path === dirname(f.reference))).toBe(
    false,
  );
  await expect(
    publishNativePreparedRepository(
      f.plan,
      new AbortController().signal,
      15000,
      undefined as never,
    ),
  ).rejects.toThrow();
});

actual.each([1, 2, 3])(
  'retains the full original async owner at fixed phase gate %s',
  async (gate) => {
    const f = await fixture();
    let checks = 0;
    f.owner.revalidate = async () => {
      if (++checks === gate) throw Error('original source owner revoked');
    };
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    expect(checks).toBe(gate === 1 ? 1 : 3);
    if (gate < 3) {
      await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(f.common, 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(f.reference, 'utf8')).toBe(f.contents[4]);
      await expect(
        publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
      ).rejects.toThrow();
    }
  },
  30000,
);
actual(
  'refuses an unchanged phase-parent inode moved beneath a replaced original common root before creation',
  async () => {
    const f = await fixture(),
      parent = dirname(f.reference),
      retained = f.common + '-retained';
    const before = await id(parent);
    await rename(f.common, retained);
    await mkdir(join(f.common, 'refs', 'heads'), { recursive: true });
    await rename(join(retained, 'refs', 'heads', 'mitzo'), parent);
    expect(await id(parent)).toEqual(before);
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.common, 'worktrees'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
actual(
  'refuses a differently spelled existing namespace parent even when the volume resolves the same inode',
  async ({ skip }) => {
    const f = await fixture(),
      parent = dirname(f.reference),
      alias = join(dirname(parent), 'MITZO');
    await rename(parent, alias);
    const physical = await id(parent).catch(() => undefined);
    if (!physical) skip('Fixture volume has distinct case-sensitive paths');
    expect(physical).toEqual(await id(alias));
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await id(alias)).toEqual(physical);
  },
  30000,
);
actual(
  'refuses a changed originally present packed file before any planned directory',
  async () => {
    const f = await fixture(),
      path = join(f.common, 'packed-refs'),
      before = `${'b'.repeat(40)} refs/heads/other\n`;
    await writeFile(path, before);
    const plan = {
      ...f.plan,
      packedRefs: {
        kind: 'file' as const,
        identity: await id(path),
        size: Buffer.byteLength(before),
        sha256: sha(before),
      },
    };
    await writeFile(
      path,
      before + `${'a'.repeat(40)} refs/heads/mitzo/repo-${f.plan.workspaceId}\n`,
    );
    await expect(
      publishNativePreparedRepository(plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
it('refuses denied decoded trees, overlimit whole plans and raw accessors before transport', async () => {
  const f = await fixture(),
    launch = vi.fn();
  await expect(
    publishNativePreparedRepository(
      { ...f.plan, deniedRoots: [join(f.plan.sourcePath.toUpperCase(), 'task.txt')] },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  const entries = Array.from({ length: 1000 }, (_, n) => ({
    ...f.plan.tree.entries[0],
    path: 'n'.repeat(250) + n,
  }));
  await expect(
    publishNativePreparedRepository(
      { ...f.plan, tree: { ...f.plan.tree, entries } },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  const getter = vi.fn();
  const raw = Object.defineProperty(
    {
      operation: 'PublishPreparedRepository',
      preparationPlan: f.plan,
      file_path: f.task,
      parentIdentity: f.plan.taskRoot.identity,
      identity: null,
      limit: 1,
      timeoutMs: 15000,
    },
    'preparationPlan',
    { get: getter },
  );
  await expect(
    executeNativeFileOperation(raw, new AbortController().signal, 15000, launch),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

actual(
  'retains genuine partial tree bytes and every created directory on child resource failure, refusing replay',
  async () => {
    const f = await fixture(),
      bytes = Buffer.alloc(4 * 1024 * 1024, 97),
      staged = join(f.plan.tree.payload.file_path, 'task.txt');
    await writeFile(staged, bytes, { mode: 0o644 });
    const plan = {
      ...f.plan,
      tree: {
        ...f.plan.tree,
        entries: [
          {
            ...f.plan.tree.entries[0],
            identity: await id(staged),
            size: bytes.length,
            sha256: sha(bytes),
          },
        ],
      },
    };
    const artifacts = join(root, 'compiled');
    await mkdir(artifacts);
    const names = [
      'sandboxed-command-worker.ts',
      'sandbox-authority.ts',
      'native-file-operation.ts',
      'native-tree-publication.ts',
      'native-preparation-observation.ts',
      'native-preparation-publication.ts',
      'private-repository-checkout.ts',
    ];
    const sources = names.map((name) => fileURLToPath(new URL('../' + name, import.meta.url)));
    const config = {
      platform: 'node' as const,
      format: 'esm' as const,
      target: 'es2022',
      bundle: false,
    };
    const compiled = await build({
      entryPoints: sources,
      outdir: artifacts,
      ...config,
      metafile: true,
      logLevel: 'silent',
    });
    expect(
      Object.keys(compiled.metafile!.inputs)
        .map((path) => path.split('/').at(-1))
        .sort(),
    ).toEqual([...names].sort());
    await writeFile(join(artifacts, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(await realpath('node_modules'), join(artifacts, 'node_modules'));
    const inputs = Object.fromEntries(
      await Promise.all(sources.map(async (path, n) => [names[n], sha(await readFile(path))])),
    );
    const outputs = Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [
          name.replace(/\.ts$/, '.js'),
          sha(await readFile(join(artifacts, name.replace(/\.ts$/, '.js')))),
        ]),
      ),
    );
    const producerInputs = {
      'sandboxed-command.ts': sha(
        await readFile(fileURLToPath(new URL('../sandboxed-command.ts', import.meta.url))),
      ),
    };
    const identity = sha(JSON.stringify({ inputs, producerInputs }));
    const evidencePath = `/private/tmp/mitzo-preparation-phase-compiled-worker-${identity.slice(0, 16)}.json`;
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          compiler: 'esbuild ' + compilerVersion,
          config,
          inputs,
          outputs,
          producerInputs,
          identity,
          executed: false,
        },
        null,
        2,
      ),
    );
    const realSpawn = (
      await vi.importActual<typeof import('node:child_process')>('node:child_process')
    ).spawn;
    const boundary = vi
      .mocked(childProcess.spawn)
      .mockImplementation((...args: Parameters<typeof realSpawn>) => {
        const argv = args[1];
        if (Array.isArray(argv) && argv.includes(sources[0])) {
          expect(args[0]).toBe(process.execPath);
          expect(argv).toHaveLength(4);
          // Test-only resource ceiling in the real child: fixed production command,
          // scope, helper and owner callbacks are unchanged.
          return realSpawn(
            '/bin/sh',
            [
              '-c',
              'ulimit -f 512; exec "$@"',
              'offline-limited-worker',
              process.execPath,
              join(artifacts, 'sandboxed-command-worker.js'),
              argv[3],
            ],
            args[2],
          );
        }
        return realSpawn(...args);
      });
    try {
      await expect(
        publishNativePreparedRepository(plan, new AbortController().signal, 15000, f.launches),
      ).rejects.toThrow();
    } finally {
      boundary.mockImplementation(realSpawn);
    }
    const partialPath = join(f.task, 'task.txt'),
      partial = await readFile(partialPath),
      retainedRoot = await id(f.task),
      retainedFile = await id(partialPath);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(bytes.length);
    await expect(lstat(f.reference)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      publishNativePreparedRepository(plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    expect(await id(f.task)).toEqual(retainedRoot);
    expect(await id(partialPath)).toEqual(retainedFile);
    expect(sha(await readFile(partialPath))).toBe(sha(partial));
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          compiler: 'esbuild ' + compilerVersion,
          config,
          inputs,
          outputs,
          producerInputs,
          identity,
          executed: true,
          outcome: 'actual SRT partial fixed-phase tree retained; replay refused',
          partialBytes: partial.length,
        },
        null,
        2,
      ),
    );
  },
  30000,
);

actual(
  'treats lost complete output as uncertainty and retains every publication on refused replay',
  async () => {
    const f = await fixture(),
      original = f.launches.getMockImplementation()!;
    f.launches.mockImplementationOnce(async (request) => {
      await original(request);
      return { stdout: 'lost response', isError: false };
    });
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow('Prepared repository publication unavailable');
    const retained = await id(f.task),
      bytes = await readFile(f.reference);
    await expect(
      publishNativePreparedRepository(f.plan, new AbortController().signal, 15000, f.launches),
    ).rejects.toThrow();
    expect(await id(f.task)).toEqual(retained);
    expect(await readFile(f.reference)).toEqual(bytes);
  },
  30000,
);
it('rejects a widened existing common-directory grant before invoking the original owner or worker', async () => {
  const f = await fixture(),
    owner = vi.fn(async () => {});
  await expect(
    publishNativePreparedRepository(
      f.plan,
      new AbortController().signal,
      15000,
      async (request) => {
        const result = await executePrivateNativeFileHelper({
          requestJson: request.requestJson,
          cwd: f.scratch,
          writableRoots: [
            ...nativePreparationPublicationWriteRoots(f.plan),
            { path: f.common, parentAnchor: f.plan.commonAnchor },
          ],
          deniedRoots: [],
          signal: request.signal,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          assertCurrentSync() {},
          revalidate: owner,
        });
        return { stdout: result.stdout ?? '', isError: result.isError };
      },
    ),
  ).rejects.toThrow();
  expect(owner).not.toHaveBeenCalled();
  await expect(lstat(f.task)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains a complete ordinary repository manifest larger than the former inline-shell ceiling', async () => {
  const f = await fixture();
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    ...f.plan.tree.entries[0],
    path: `source-file-${index.toString().padStart(4, '0')}.ts`,
  }));
  const plan = { ...f.plan, tree: { ...f.plan.tree, entries } };
  expect(Buffer.byteLength(JSON.stringify(plan))).toBeGreaterThan(120 * 1024);
  expect(projectNativePreparationPublicationPlan(plan).tree.entries).toHaveLength(1000);
});
