import { afterEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { NativeFileHelperTransport } from '../native-file-operation.js';
import {
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
import { join } from 'node:path';
import {
  captureRepositoryObservation,
  RepositoryObservationMissingError,
  RepositoryObservationReadAccessError,
  verifyRepositoryObservation,
  freezeRepositoryObservationPlan,
  type RepositoryObservationCapture,
} from '../native-repository-observation.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import {
  fixtureReadAnchor,
  fixtureReadDescriptor,
} from './fixtures/local-repository-read-owner.js';

// Synthetic retention owner for aggregate accounting only. Real fixed-helper
// bounds and the signed consumer are qualified in separate controls below.
function queryBudgetFixture() {
  let bytes = 0,
    entries = 1;
  let beforeRetain: (() => Promise<void>) | undefined;
  let afterRetain: (() => void) | undefined;
  const retained = new Set<RepositoryObservationCapture>();
  const capture = vi.fn(async (input, onRetained) => {
    await beforeRetain?.();
    if (bytes > input.limits.maxBytes || entries > input.limits.maxEntries)
      throw Error('Controlled producer budget refusal before allocation');
    const entry = {
      name: 'HEAD',
      identity: { dev: '1', ino: '1' },
      kind: 'file' as const,
      size: bytes,
      mode: 0,
      nlink: 1,
      mtimeNs: '0',
      ctimeNs: '0',
    };
    const value: RepositoryObservationCapture = {
      plan: freezeRepositoryObservationPlan({
        ...input,
        version: 'repository-read-v1',
        readableRoots: ['/'],
        deniedRoots: [],
        excludedNames: [],
      }),
      data: {
        version: 'repository-read-v1',
        mode: 'discovery',
        entries: Array.from({ length: entries }, (_, index) => ({
          path: '/query/' + index,
          entry,
        })),
        directories: [],
        absent: [],
        files: bytes
          ? [{ path: '/query/0', bytes: Buffer.alloc(bytes).toString('base64'), link: false }]
          : [],
      },
      digest: '0'.repeat(64),
    };
    onRetained(value);
    retained.add(value);
    afterRetain?.();
    return value;
  });
  const execute = vi.fn(fixtureReadDescriptor);
  const access = new LocalRepositoryReadAccess({
    deadline: Number.MAX_SAFE_INTEGER,
    deniedRoots: [],
    assertReadable: async () => {},
    captureReadAnchor: fixtureReadAnchor,
    executeReadOperation: execute,
    captureRepositoryObservation: capture,
    verifyRepositoryObservation: async () => {},
  });
  const observe = (limits?: { maxBytes?: number; maxEntries?: number }) =>
    access.forkForRepositoryObservation().captureRepositoryObservation({
      mode: 'discovery',
      sourcePath: '/query',
      ...(limits ? { limits } : {}),
    });
  return {
    access,
    observe,
    capture,
    execute,
    retained,
    size: (nextBytes: number, nextEntries = 1) => {
      bytes = nextBytes;
      entries = nextEntries;
    },
    before: (hook?: () => Promise<void>) => {
      beforeRetain = hook;
    },
    after: (hook?: () => void) => {
      afterRetain = hook;
    },
  };
}

it('shares retained byte and entry bounds across query forks while independent queries retain their own budget', async () => {
  const bytes = queryBudgetFixture();
  bytes.size(32 * 1024 * 1024);
  await bytes.observe();
  await bytes.observe();
  await expect(bytes.observe()).rejects.toMatchObject({ reason: 'snapshot-bytes' });
  expect(bytes.capture).toHaveBeenCalledTimes(2);
  const entries = queryBudgetFixture();
  entries.size(0, 40000);
  await entries.observe();
  await entries.observe();
  await expect(entries.observe()).rejects.toThrow('Controlled producer budget refusal');
  expect(entries.capture.mock.calls[2][0].limits.maxEntries).toBe(20000);
  const independent = queryBudgetFixture();
  await independent.observe();
});

it('reserves in-flight bytes before producer invocation and releases only unretained failures', async () => {
  const fixture = queryBudgetFixture();
  fixture.size(32 * 1024 * 1024);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fixture.before(() => held);
  const first = fixture.observe({ maxEntries: 1 });
  const second = fixture.observe({ maxEntries: 1 });
  await expect(fixture.observe({ maxEntries: 1 })).rejects.toMatchObject({
    reason: 'snapshot-bytes',
  });
  expect(fixture.capture).toHaveBeenCalledTimes(2);
  release();
  await Promise.all([first, second]);
  const failure = queryBudgetFixture();
  let settled!: () => void, entered!: () => void;
  const settlement = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  failure.before(async () => {
    entered();
    await settlement;
    throw Error('Controlled pre-retention failure');
  });
  const failing = failure.observe();
  await entry;
  try {
    await expect(failure.observe()).rejects.toMatchObject({ reason: 'snapshot-entries' });
  } finally {
    settled();
  }
  await expect(failing).rejects.toThrow('Controlled pre-retention failure');
  failure.before();
  failure.size(32 * 1024 * 1024);
  await failure.observe();
  await failure.observe();
});

it.each(['producer', 'consumer'] as const)(
  'keeps native retention charged after a later %s refusal',
  async (phase) => {
    const fixture = queryBudgetFixture();
    fixture.size(32 * 1024 * 1024);
    const input = { mode: 'discovery' as const, sourcePath: '/query' };
    fixture.after(() => {
      if (phase === 'producer') throw Error('Controlled refusal after native retention');
      input.sourcePath = '/changed';
    });
    await expect(
      fixture.access.forkForRepositoryObservation().captureRepositoryObservation(input),
    ).rejects.toThrow();
    fixture.after();
    await fixture.observe();
    await expect(fixture.observe()).rejects.toMatchObject({ reason: 'snapshot-bytes' });
    expect(fixture.retained.size).toBe(2);
  },
);

it('shares entry reservations with generic lists and an awaiting atomic preload', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-query-budget-')));
  roots.push(root);
  await writeFile(join(root, 'entry'), 'fixture');
  const fixture = queryBudgetFixture();
  await fixture.access.pinRoot(root);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  fixture.execute.mockImplementation(async (...args) => {
    started();
    await held;
    return fixtureReadDescriptor(...args);
  });
  const preload = fixture.access.preloadDirectories([root]);
  await observed;
  fixture.size(0, 95000);
  try {
    await expect(fixture.observe()).rejects.toThrow('Controlled producer budget refusal');
    expect(fixture.capture.mock.calls[0][0].limits.maxEntries).toBe(90000);
  } finally {
    release();
  }
  await preload;
  fixture.before(() => held);
  fixture.size(0, 1);
  let finish!: () => void, entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const beginning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixture.before(async () => {
    entered();
    await holding;
  });
  const capture = fixture.observe();
  await beginning;
  try {
    await expect(fixture.access.forkForRepositoryObservation().list(root)).rejects.toMatchObject({
      reason: 'snapshot-entries',
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  } finally {
    finish();
  }
  await capture;
});

it('enforces narrowed byte and entry ceilings in the actual fixed physical helper', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-limits-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  const transport: NativeFileHelperTransport = vi.fn(async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  });
  const plan = {
    version: 'repository-read-v1',
    mode: 'discovery',
    sourcePath: root,
    readableRoots: [root],
    deniedRoots: [],
    excludedNames: [],
  };
  const signal = new AbortController().signal;
  await expect(
    captureRepositoryObservation({ ...plan, limits: { maxBytes: 0 } }, signal, 10000, transport),
  ).rejects.toThrow();
  await expect(
    captureRepositoryObservation({ ...plan, limits: { maxEntries: 1 } }, signal, 10000, transport),
  ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(2); // Refusal came from the physical operation, not schema rejection.
  const captured = await captureRepositoryObservation(
    { ...plan, limits: { maxBytes: 65536, maxEntries: 100 } },
    signal,
    10000,
    transport,
  );
  expect(captured.data.files.some((file) => file.path === join(root, '.git', 'HEAD'))).toBe(true);
  await verifyRepositoryObservation(captured.plan, captured.digest, signal, 10000, transport);
  for (const limits of [{ maxBytes: 32 * 1024 * 1024 + 1 }, { maxEntries: 100001 }])
    await expect(
      captureRepositoryObservation({ ...plan, limits }, signal, 10000, transport),
    ).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(4); // A narrowing field cannot raise fixed defaults.
});

it('rejects forged over-budget capture data before decoded buffers or entry maps are retained', async () => {
  const buffers = vi.spyOn(Buffer, 'from');
  const data = {
    version: 'repository-read-v1',
    mode: 'discovery',
    entries: [
      {
        path: '/query/HEAD',
        entry: {
          name: 'HEAD',
          identity: { dev: '1', ino: '1' },
          kind: 'file',
          size: 2,
          mode: 0,
          nlink: 1,
          mtimeNs: '0',
          ctimeNs: '0',
        },
      },
    ],
    files: [{ path: '/query/HEAD', bytes: 'YWI=', link: false }],
    directories: [],
    absent: [],
  };
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(data)))
    .digest('hex');
  const transport: NativeFileHelperTransport = async () => ({
    stdout: `{"content": ${JSON.stringify(JSON.stringify({ data, digest }))}, "is_error": false}\n`,
    isError: false,
  });
  const plan = {
    version: 'repository-read-v1',
    mode: 'discovery',
    sourcePath: '/query',
    readableRoots: ['/'],
    deniedRoots: [],
    excludedNames: [],
  };
  await expect(
    captureRepositoryObservation(
      { ...plan, limits: { maxBytes: 1 } },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toThrow('Repository observation unavailable');
  await expect(
    captureRepositoryObservation(
      { ...plan, limits: { maxEntries: 0 } },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toThrow('Repository observation unavailable');
  expect(
    buffers.mock.calls.filter(([value, encoding]) => value === 'YWI=' && encoding === 'base64'),
  ).toHaveLength(0);
  expect(
    (
      await captureRepositoryObservation(
        { ...plan, limits: { maxBytes: 2, maxEntries: 1 } },
        new AbortController().signal,
        10000,
        transport,
      )
    ).digest,
  ).toBe(digest);
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('captures one bounded repository observation and detects changed bytes before return', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-repository-observation-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'AGENTS.md'), 'Original instructions');
  const request = {
    version: 'repository-read-v1' as const,
    mode: 'orientation' as const,
    sourcePath: root,
    readableRoots: ['/'],
    deniedRoots: [],
    excludedNames: [],
  };
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  // Physical helper integration uses its actual fixed Python program without inference.
  const held = await captureRepositoryObservation(
    request,
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((file) => file.path === join(root, 'AGENTS.md'))).toBe(true);
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
  await writeFile(join(root, 'AGENTS.md'), 'Changed instructions');
  await expect(
    verifyRepositoryObservation(
      held.plan,
      held.digest,
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toThrow();
  expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('Changed instructions');
});

it('restricts the physical batch to the projected roots before reading Git indirection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-scope-')));
  roots.push(root);
  const source = join(root, 'source'),
    outside = join(root, 'outside');
  await mkdir(source);
  await mkdir(outside);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', source]);
  await writeFile(join(root, 'AGENTS.md'), 'OUTSIDE SCOPE');
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const plan = {
    version: 'repository-read-v1',
    mode: 'orientation',
    sourcePath: source,
    readableRoots: [source],
    deniedRoots: [],
    excludedNames: [],
  };
  const held = await captureRepositoryObservation(
    plan,
    new AbortController().signal,
    10000,
    transport,
  );
  expect(
    held.data.entries.every((item) => item.path === source || item.path.startsWith(source + '/')),
  ).toBe(true);
  expect(held.data.files.some((item) => item.path === join(root, 'AGENTS.md'))).toBe(false);
  await rm(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git'), 'gitdir: ' + outside + '\n');
  await expect(
    captureRepositoryObservation(plan, new AbortController().signal, 10000, transport),
  ).rejects.toThrow();
});

it('captures an enclosing repository from a nested cwd and tolerates a missing optional objects/info directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-nested-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  const nested = join(root, 'src', 'nested');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'AGENTS.md'), 'nested instructions');
  await rm(join(root, '.git', 'objects', 'info'), { recursive: true, force: true });
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: nested,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(root, '.git', 'HEAD'))).toBe(true);
  expect(held.data.files.some((item) => item.path === join(nested, 'AGENTS.md'))).toBe(true);
  expect(held.data.absent).toContain(join(root, '.git', 'objects', 'info'));
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('captures the exact published task metadata in one adoption observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-adoption-')));
  roots.push(root);
  const source = join(root, 'source'),
    tasks = join(root, 'tasks');
  await mkdir(source);
  await mkdir(tasks);
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      ['-C', source, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
        stdio: 'ignore',
      },
    );
  git('init', '--template=', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline');
  git('config', 'user.email', 'offline@example.invalid');
  await writeFile(join(source, 'tracked.txt'), 'tracked');
  git('add', '.');
  git('commit', '-qm', 'base');
  const workspaceId = '12345678-1234-4234-8234-123456789abc',
    task = join(tasks, 'repo-' + workspaceId);
  git('worktree', 'add', '-q', '-b', 'mitzo/repo-' + workspaceId, task);
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'adoption',
      sourcePath: source,
      taskRoot: tasks,
      workspaceId,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  for (const path of [
    join(task, '.git'),
    join(source, '.git', 'worktrees', 'repo-' + workspaceId, 'index'),
    join(source, '.git', 'refs', 'heads', 'mitzo', 'repo-' + workspaceId),
  ])
    expect(
      held.data.files.some((file) => file.path === path),
      path,
    ).toBe(true);
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('keeps HEAD inspection available when an optional worktree registry cannot be read safely', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-optional-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await symlink('/unavailable-offline-fixture', join(root, '.git', 'worktrees'));
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: root,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(root, '.git', 'HEAD'))).toBe(true);
  expect(held.data.directories.some((item) => item.path === join(root, '.git', 'worktrees'))).toBe(
    false,
  );
  expect(held.data.absent).not.toContain(join(root, '.git', 'worktrees'));
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('rolls back merged sibling reference names after a later optional worktree read fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-rollback-')));
  roots.push(root);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  const common = join(root, '.git'),
    sibling = join(common, 'worktrees', 'sibling');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(common, 'refs', 'heads', 'other'), 'a'.repeat(40) + '\n');
  await writeFile(join(sibling, 'HEAD'), 'ref: refs/heads/other\n');
  await symlink('/unavailable-offline-fixture', join(sibling, 'gitdir'));
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'orientation',
      sourcePath: root,
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(held.data.files.some((item) => item.path === join(common, 'HEAD'))).toBe(true);
  expect(held.data.files.some((item) => item.path === join(common, 'refs', 'heads', 'other'))).toBe(
    false,
  );
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
});

it('preserves typed source absence without exposing denied paths or storage failures as missing', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-missing-')));
  roots.push(root);
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const source = join(root, 'missing');
  const plan = {
    version: 'repository-read-v1',
    mode: 'discovery',
    sourcePath: source,
    readableRoots: [root],
    deniedRoots: [],
    excludedNames: [],
  };
  await expect(
    captureRepositoryObservation(plan, new AbortController().signal, 10000, transport),
  ).rejects.toBeInstanceOf(RepositoryObservationMissingError);
  await expect(
    captureRepositoryObservation(
      { ...plan, deniedRoots: [source] },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toBeInstanceOf(RepositoryObservationReadAccessError);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
  await rm(join(root, '.git', 'objects'), { recursive: true });
  await symlink('/unavailable-offline-fixture', join(root, '.git', 'objects'));
  await expect(
    captureRepositoryObservation(
      { ...plan, sourcePath: root },
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.not.toBeInstanceOf(RepositoryObservationMissingError);
});

it('captures shallow boundary bytes in the fixed allocation observation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-observation-shallow-')));
  roots.push(root);
  const source = join(root, 'source'),
    tasks = join(root, 'tasks');
  await mkdir(source);
  await mkdir(tasks);
  execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', source]);
  const shallow = 'a'.repeat(40) + '\n';
  await writeFile(join(source, '.git', 'shallow'), shallow);
  const transport: NativeFileHelperTransport = async (invocation) => {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
      cwd: root,
      env: { PATH: '/usr/bin:/bin' },
      signal: invocation.signal,
      timeout: invocation.timeoutMs,
      maxBuffer: invocation.maxOutputBytes,
    });
    return { stdout, isError: false };
  };
  const held = await captureRepositoryObservation(
    {
      version: 'repository-read-v1',
      mode: 'allocation',
      sourcePath: source,
      taskRoot: tasks,
      workspaceId: '12345678-1234-4234-8234-123456789abc',
      readableRoots: [root],
      deniedRoots: [],
      excludedNames: [],
    },
    new AbortController().signal,
    10000,
    transport,
  );
  expect(
    held.data.files.find((file) => file.path === join(source, '.git', 'shallow')),
  ).toBeDefined();
  await verifyRepositoryObservation(
    held.plan,
    held.digest,
    new AbortController().signal,
    10000,
    transport,
  );
  await writeFile(join(source, '.git', 'shallow'), 'b'.repeat(40) + '\n');
  await expect(
    verifyRepositoryObservation(
      held.plan,
      held.digest,
      new AbortController().signal,
      10000,
      transport,
    ),
  ).rejects.toThrow();
});

// The witness is scoped to one physical check, never cached across validations.
it.each(['HEAD', 'config', 'index', 'shallow', 'git-root', 'task-root'] as const)(
  'refuses changed standalone %s after topology capture before verification',
  async (change) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-task-topology-change-')));
    roots.push(root);
    execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
    await writeFile(join(root, '.git', 'index'), 'retained metadata only');
    const transport: NativeFileHelperTransport = async (invocation) => {
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        signal: invocation.signal,
        timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes,
      });
      return { stdout, isError: false };
    };
    const held = await captureRepositoryObservation(
      {
        version: 'repository-read-v1',
        mode: 'task-topology',
        sourcePath: root,
        readableRoots: [root],
        deniedRoots: [],
        excludedNames: [],
      },
      new AbortController().signal,
      10000,
      transport,
    );
    expect(held.data.files.some((file) => file.path === join(root, '.git', 'index'))).toBe(false);
    if (change === 'git-root') {
      await rename(join(root, '.git'), join(root, 'retained-admin'));
      await mkdir(join(root, '.git'));
    } else if (change === 'task-root') {
      await rename(root, root + '-retained');
      roots.push(root + '-retained');
      await mkdir(root);
    } else await writeFile(join(root, '.git', change), 'changed topology bytes');
    await expect(
      verifyRepositoryObservation(
        held.plan,
        held.digest,
        new AbortController().signal,
        10000,
        transport,
      ),
    ).rejects.toThrow();
  },
);

it.each(['ancestor', 'gitfile'] as const)(
  'refuses standalone %s discovery or redirection',
  async (change) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-task-topology-scope-')));
    roots.push(root);
    execFileSync('/usr/bin/git', ['init', '--template=', '-q', '-b', 'main', root]);
    const nested = join(root, 'nested');
    await mkdir(nested);
    if (change === 'gitfile')
      await writeFile(join(nested, '.git'), `gitdir: ${join(root, '.git')}\n`);
    const transport: NativeFileHelperTransport = async (invocation) => {
      const { stdout } = await promisify(execFile)('/bin/sh', ['-c', invocation.command], {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin' },
        signal: invocation.signal,
        timeout: invocation.timeoutMs,
        maxBuffer: invocation.maxOutputBytes,
      });
      return { stdout, isError: false };
    };
    await expect(
      captureRepositoryObservation(
        {
          version: 'repository-read-v1',
          mode: 'task-topology',
          sourcePath: nested,
          readableRoots: [root],
          deniedRoots: [],
          excludedNames: [],
        },
        new AbortController().signal,
        10000,
        transport,
      ),
    ).rejects.toThrow();
  },
);
