import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, version as compilerVersion } from 'esbuild';
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
import * as operations from '../native-file-operation.js';
import { executePrivateNativeFileHelper } from '../sandboxed-command.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(
    (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn,
  ),
}));

let root: string, scratch: string, common: string;
const id = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-file-batch-')));
  scratch = join(root, 'owned');
  common = join(root, 'common');
  await mkdir(scratch);
  await mkdir(common);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const deniedRoots = Object.freeze([] as string[]);
  const anchor = { rootPath: common, identity: await id(common) },
    payloadAnchor = { rootPath: scratch, identity: await id(scratch) };
  const items = [];
  for (let index = 0; index < 6; index++) {
    const bytes = Buffer.from('fixed ' + index + '\n'),
      payload = join(scratch, 'payload-' + index);
    await writeFile(payload, bytes);
    items.push({
      file_path: join(common, 'target-' + index),
      rootAnchor: anchor,
      parentIdentity: anchor.identity,
      expectedAbsent: true as const,
      deniedRoots,
      payload: {
        file_path: payload,
        rootAnchor: payloadAnchor,
        parentIdentity: payloadAnchor.identity,
        identity: await id(payload),
        size: bytes.length,
        sha256: digest(bytes),
      },
    });
  }
  return { items, deniedRoots };
}
async function run(
  input: Awaited<ReturnType<typeof fixture>>,
  callbacks = { assertCurrentSync() {}, async revalidate() {} },
) {
  const launches = vi.fn<operations.NativeFileHelperTransport>(async (invocation) => {
    const result = await executePrivateNativeFileHelper({
      requestJson: invocation.requestJson,
      cwd: scratch,
      writableRoots: [
        { path: scratch, parentAnchor: { rootPath: scratch, identity: await id(scratch) } },
        ...input.items.map((item) => ({
          path: item.file_path,
          parentAnchor: { rootPath: dirname(item.file_path), identity: item.parentIdentity },
        })),
      ],
      deniedRoots: input.deniedRoots,
      signal: invocation.signal,
      timeoutMs: invocation.timeoutMs,
      maxOutputBytes: invocation.maxOutputBytes,
      ...callbacks,
    });
    return { stdout: result.stdout ?? '', isError: result.isError };
  });
  const result = await operations.createNativeExclusiveFileBatch(
    input,
    new AbortController().signal,
    15000,
    launches,
  );
  return { result, launches };
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'publishes six exact files with one launch and three original full-owner checks',
  async () => {
    const input = await fixture(),
      revalidate = vi.fn(async () => {});
    const { result, launches } = await run(input, { assertCurrentSync() {}, revalidate });
    expect(launches).toHaveBeenCalledOnce();
    expect(revalidate).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(6);
    for (let n = 0; n < 6; n++) {
      expect(await readFile(input.items[n].file_path)).toEqual(Buffer.from('fixed ' + n + '\n'));
      expect(result[n]).toMatchObject({
        file_path: input.items[n].file_path,
        sha256: input.items[n].payload.sha256,
      });
    }
  },
  30000,
);
actual.each(['occupied', 'payload', 'parent'] as const)(
  'whole preflight refuses last %s item before any target write',
  async (change) => {
    const input = await fixture(),
      last = input.items[5];
    if (change === 'occupied') await writeFile(last.file_path, 'foreign');
    if (change === 'payload') await writeFile(last.payload.file_path, 'changed');
    if (change === 'parent') {
      const nested = join(common, 'nested');
      await mkdir(nested);
      last.file_path = join(nested, 'target');
      last.parentIdentity = await id(nested);
      await rename(nested, nested + '-retained');
      await mkdir(nested);
    }
    await expect(run(input)).rejects.toThrow();
    for (const item of input.items.slice(0, 5))
      await expect(lstat(item.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    if (change === 'occupied') expect(await readFile(last.file_path, 'utf8')).toBe('foreign');
  },
  30000,
);
it('rejects duplicate, ancestor, overlimit, accessor and missing-transport batches without launch', async () => {
  const input = await fixture(),
    launch = vi.fn();
  for (const items of [
    [...input.items, input.items[0]],
    [input.items[0], input.items[0]],
    [input.items[0], { ...input.items[1], file_path: join(input.items[0].file_path, 'child') }],
    [],
  ])
    await expect(
      operations.createNativeExclusiveFileBatch(
        { items, deniedRoots: [] },
        new AbortController().signal,
        15000,
        launch,
      ),
    ).rejects.toThrow();
  const oversizedReceipts = input.items.map((item, index) => ({
    ...item,
    file_path: common + '/' + 'n'.repeat(3500) + index,
  }));
  await expect(
    operations.createNativeExclusiveFileBatch(
      { items: oversizedReceipts, deniedRoots: [] },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  const elementGetter = vi.fn();
  const accessorItems = [...input.items];
  Object.defineProperty(accessorItems, '5', { get: elementGetter });
  await expect(
    operations.createNativeExclusiveFileBatch(
      { items: accessorItems, deniedRoots: [] },
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  expect(elementGetter).not.toHaveBeenCalled();
  const getter = vi.fn();
  const invalid = Object.defineProperty({}, 'items', { get: getter });
  await expect(
    operations.createNativeExclusiveFileBatch(
      invalid as never,
      new AbortController().signal,
      15000,
      launch,
    ),
  ).rejects.toThrow();
  await expect(
    operations.createNativeExclusiveFileBatch(
      input,
      new AbortController().signal,
      15000,
      undefined as never,
    ),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
it('withholds batch effects from the legacy direct host dispatcher', async () => {
  const input = await fixture();
  await expect(
    operations.executeNativeFileOperation(
      {
        ...input,
        operation: 'CreateFileBatch',
        identity: null,
        limit: 1,
        file_path: '',
        parentIdentity: { dev: '0', ino: '0' },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Private helper transport unavailable');
});

actual.each([1, 2, 3])(
  'retains original full-owner refusal at batch gate %s without replay',
  async (gate) => {
    const input = await fixture();
    let count = 0;
    await expect(
      run(input, {
        assertCurrentSync() {},
        async revalidate() {
          if (++count === gate) throw Error('original source owner revoked');
        },
      }),
    ).rejects.toThrow();
    expect(count).toBe(gate === 1 ? 1 : 3);
    for (const item of input.items) {
      if (gate < 3) await expect(lstat(item.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(item.file_path)).toEqual(await readFile(item.payload.file_path));
    }
    if (gate === 3) await expect(run(input)).rejects.toThrow();
  },
  30000,
);
actual(
  'refuses a denied last target before any target publication',
  async () => {
    const input = await fixture();
    const deniedRoots = Object.freeze([input.items[5].file_path]);
    const denied = { items: input.items.map((item) => ({ ...item, deniedRoots })), deniedRoots };
    await expect(run(denied)).rejects.toThrow();
    for (const item of input.items)
      await expect(lstat(item.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
  },
  30000,
);
actual(
  'retains actual partial bytes after a bounded child file-size failure and refuses replay',
  async () => {
    const input = await fixture(),
      bytes = Buffer.alloc(4 * 1024 * 1024, 97);
    await writeFile(input.items[0].payload.file_path, bytes);
    Object.assign(input.items[0].payload, { size: bytes.length, sha256: digest(bytes) });
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
    const compiled = await build({
      entryPoints: sources,
      outdir: artifacts,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      bundle: false,
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
    const evidencePath =
      '/private/tmp/mitzo-file-batch-phase-compiled-worker-' +
      digest(await readFile(sources[2])).slice(0, 16) +
      '.json';
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          compiler: 'esbuild ' + compilerVersion,
          config: { platform: 'node', format: 'esm', target: 'es2022', bundle: false },
          inputs: Object.fromEntries(
            await Promise.all(
              sources.map(async (path, index) => [names[index], digest(await readFile(path))]),
            ),
          ),
          outputs: Object.fromEntries(
            await Promise.all(
              names.map(async (name) => [
                name.replace(/\.ts$/, '.js'),
                digest(await readFile(join(artifacts, name.replace(/\.ts$/, '.js')))),
              ]),
            ),
          ),
          executed: false,
          purpose: 'offline private batch partial-write control; child-only file-size ceiling',
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
          // Test-only child resource ceiling creates a deterministic real partial
          // write. Production policy/request/command bytes remain unchanged.
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
      await expect(run(input)).rejects.toThrow();
    } finally {
      boundary.mockImplementation(realSpawn);
    }
    const retained = await id(input.items[0].file_path),
      partial = await readFile(input.items[0].file_path);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(bytes.length);
    for (const item of input.items.slice(1))
      await expect(lstat(item.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(run(input)).rejects.toThrow();
    expect(await id(input.items[0].file_path)).toEqual(retained);
    const preserved = await readFile(input.items[0].file_path);
    expect(preserved.length).toBe(partial.length);
    expect(digest(preserved)).toBe(digest(partial));
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          ...evidence,
          executed: true,
          outcome: 'actual SRT partial publication retained; replay refused',
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
  'whole preflight rejects an equivalent last target alias before any publication',
  async (context) => {
    const input = await fixture(),
      last = input.items[5];
    const alias = last.file_path.toUpperCase().replace(common.toUpperCase(), common);
    await writeFile(alias, 'FOREIGN');
    if (!(await lstat(last.file_path).catch(() => undefined)))
      context.skip('Fixture volume is case sensitive; no equivalent target alias');
    expect(await id(alias)).toEqual(await id(last.file_path));
    await expect(run(input)).rejects.toThrow();
    for (const item of input.items.slice(0, 5))
      await expect(lstat(item.file_path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(alias, 'utf8')).toBe('FOREIGN');
  },
  30000,
);
