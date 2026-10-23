import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localRepositoryNativeToolFixture } from './fixtures/local-repository-native-tools.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import * as sandbox from '../sandboxed-command.js';
import * as metadata from '../local-repository-git-inspection.js';
import * as gitFacts from '../local-repository-git-snapshot.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';
import { sessionLocalRepositoryTools } from '../session-local-repository-tools.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
beforeEach(() => vi.stubEnv('TMPDIR', '/private/tmp'));
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
vi.setConfig({ testTimeout: 30000 });

// Exercise the real factory/descriptor helpers with scratch-only fixture bytes.
// Only the lowest sandbox process boundary is replaced; this is lifecycle and
// protocol evidence, not another kernel-enforcement qualification.
function offlineHelper(beforeSpawn?: () => void) {
  const runs: Array<Parameters<typeof sandbox.executeSandboxedCommand>[0]> = [];
  vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(async (request) => {
    runs.push(request);
    beforeSpawn?.();
    await request.beforeSpawnAsync?.();
    request.beforeSpawn?.();
    request.signal.throwIfAborted();
    const result = await promisify(execFile)('/bin/sh', ['-c', request.command], {
      cwd: request.cwd,
      env: request.env,
      signal: request.signal,
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputBytes ?? 8388608,
    });
    return { content: result.stdout, stdout: result.stdout, stderr: result.stderr, isError: false };
  });
  return runs;
}

function owner(context: NativeHostToolContext, root: string) {
  const scope = context.nativeBaseReadScope!;
  return {
    capture: () => context,
    readPolicy: async () => ({
      accessScope: {
        kind: 'roots' as const,
        roots: [root],
        deniedRoots: scope.deniedRoots,
      },
      discoveryRoots: [root],
      orientationHints: [context.workspace.directory],
      assertCurrentSync: () => {
        if (context.nativeBaseReadScope !== scope) throw Error('Original scope changed');
      },
    }),
    captureReader: captureNativeLocalRepositoryReader,
  };
}

async function signedReadPositive(tool: 'DiscoverLocalRepository' | 'InspectLocalRepository') {
  const runs = offlineHelper();
  let failure: unknown;
  const inspect = metadata.inspectLocalRepositoryGitMetadata;
  vi.spyOn(metadata, 'inspectLocalRepositoryGitMetadata').mockImplementation(async (...args) => {
    try {
      return await inspect(...args);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  const facts = gitFacts.readLocalRepositoryGitFacts;
  vi.spyOn(gitFacts, 'readLocalRepositoryGitFacts').mockImplementation(async (...args) => {
    try {
      return await facts(...args);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  let source = '';
  let original: NativeHostToolContext | undefined;
  const f = await localRepositoryNativeToolFixture(cleanups, async (context, input) => {
    original = context;
    const tools = sessionLocalRepositoryTools(owner(context, source));
    const result = await tools.execute(context.toolName, input, context.signal);
    expect(result).toBeDefined();
    return result!;
  });
  source = join(f.f.root, 'read-tools-source');
  await mkdir(source);
  // A disposable, unenrolled source under the additional fixture-only ceiling.
  await writeFile(join(source, 'AGENTS.md'), 'Only controlled fixture bytes');
  const git = (...args: string[]) =>
    execFileSync(
      '/usr/bin/git',
      [
        '-C',
        source,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Offline',
        '-c',
        'user.email=offline@example.invalid',
        ...args,
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    );
  git('init', '--template=', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const result = await f.a.call({ path: source }, { tool });
  expect(original?.nativeBaseReadScope).toBeDefined();
  expect(
    result.response.success,
    JSON.stringify({ value: result.value, helpers: runs.length, metrics: f.a.metrics, failure }),
  ).toBe(true);
  if (tool === 'DiscoverLocalRepository')
    expect(
      result.value,
      JSON.stringify({
        value: result.value,
        helpers: runs.length,
        metrics: f.a.metrics,
        failure,
      }),
    ).toMatchObject({ state: 'selected', candidates: [{ path: source }] });
  else {
    expect(
      result.value,
      JSON.stringify({
        value: result.value,
        helpers: runs.length,
        metrics: f.a.metrics,
        failure,
      }),
    ).toMatchObject({ path: source, branch: 'main', dirty: { state: 'unknown' } });
    expect(result.value.instructions.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(source, 'AGENTS.md'),
          content: 'Only controlled fixture bytes',
        }),
      ]),
    );
  }
  expect(original?.nativeBaseReadScope).toBeDefined();
  expect(runs.length).toBeGreaterThan(0);
  for (const scratch of new Set(runs.map((r) => r.cwd)))
    await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
}
it.runIf(process.platform === 'darwin')(
  'uses the actual signed native reader for discovery and joins cleanup before returning facts',
  () => signedReadPositive('DiscoverLocalRepository'),
);
// Retained diagnostic: full source-mode inspection can exceed the unchanged
// operation deadline. It does not qualify the actual registered SRT path.
it.runIf(
  process.platform === 'darwin' &&
    process.env.MITZO_RUN_NATIVE_READ_TOOLS_SOURCE_DIAGNOSTIC === '1',
)('source-mode signed Inspect positive diagnostic', () =>
  signedReadPositive('InspectLocalRepository'),
);

it.runIf(process.platform === 'darwin')(
  'refuses absent actual native base scope without a fixture or ambient read fallback',
  async () => {
    const runs = offlineHelper();
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async (context, input) => {
        const tools = sessionLocalRepositoryTools({
          ...owner(context, '/fixture-unread'),
          readPolicy: async () => ({
            accessScope: { kind: 'roots' as const, roots: ['/'] },
            discoveryRoots: ['/fixture-unread'],
            assertCurrentSync: () => context.assertCurrentSync(),
          }),
        });
        return (await tools.execute(context.toolName, input, context.signal))!;
      },
      { nativeBaseReads: false },
    );
    const result = await f.a.call({ path: '/fixture-unread' });
    expect(result.response.success).toBe(false);
    expect(runs).toHaveLength(0);
  },
);

it.runIf(process.platform === 'darwin')(
  'withholds facts when original auth expires during joined reader disposal',
  async () => {
    const runs = offlineHelper();
    let source = '';
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async (context, input) =>
        (await sessionLocalRepositoryTools(owner(context, source)).execute(
          context.toolName,
          input,
          context.signal,
        ))!,
    );
    source = join(f.f.root, 'not-a-repository');
    await mkdir(source);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const dispose = vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
      await actual.rm(path, options);
      if (String(path).includes('/mitzo-native-read-')) revokeAuthSession(f.auth);
    });
    const result = await f.a.call({ path: source });
    expect(result.response.success).toBe(false);
    expect(String(result.value)).not.toContain('candidates');
    expect(runs.length).toBeGreaterThan(0);
    expect(dispose.mock.calls.some(([path]) => String(path).includes('/mitzo-native-read-'))).toBe(
      true,
    );
    for (const scratch of new Set(runs.map((r) => r.cwd)))
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.runIf(process.platform === 'darwin')(
  'cancels an actual helper wait and joins reader disposal without a fallback read',
  async () => {
    const abort = new AbortController();
    const runs = offlineHelper(() => abort.abort(Error('Controlled cancellation')));
    let source = '';
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async (context, input) =>
        (await sessionLocalRepositoryTools(owner(context, source)).execute(
          context.toolName,
          input,
          context.signal,
        ))!,
    );
    source = join(f.f.root, 'cancel-source');
    await mkdir(source);
    const result = await f.a.call({ path: source }, undefined, abort.signal);
    expect(result.response.success).toBe(false);
    expect(runs).toHaveLength(1);
    for (const scratch of new Set(runs.map((r) => r.cwd)))
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.runIf(process.platform === 'darwin')(
  'preserves the same complete reader while ANDing an internal-child denial with its broader actual base',
  async () => {
    offlineHelper();
    const fileOperations = await import('../native-file-operation.js');
    const discovery = await import('../local-repository-discovery.js');
    const { LocalRepositoryReadAccess } = await import('../local-repository-read-access.js');
    const read = fileOperations.executeNativeAnchoredReadOperation;
    const paths: string[] = [];
    vi.spyOn(fileOperations, 'executeNativeAnchoredReadOperation').mockImplementation(
      async (request, ...rest) => {
        if (request.operation === 'ReadBytes') paths.push(request.file_path);
        return read(request, ...rest);
      },
    );
    let source = '',
      denied = '';
    let actualReader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>> | undefined;
    const inspect = discovery.inspectLocalRepository;
    vi.spyOn(discovery, 'inspectLocalRepository').mockImplementation(async (request) => {
      const descriptor = Object.getOwnPropertyDescriptor(request, 'nativeReader');
      expect(descriptor?.enumerable).toBe(false);
      expect(descriptor?.value).toBe(actualReader);
      return inspect(request);
    });
    const pin = LocalRepositoryReadAccess.prototype.pinRoot;
    vi.spyOn(LocalRepositoryReadAccess.prototype, 'pinRoot').mockImplementation(function (
      this: InstanceType<typeof LocalRepositoryReadAccess>,
      path,
    ) {
      expect(Object.getOwnPropertyDescriptor(this, 'authority')?.value).toBe(actualReader);
      return pin.call(this, path);
    });
    const f = await localRepositoryNativeToolFixture(cleanups, async (context, input) => {
      const original = owner(context, source);
      return (await sessionLocalRepositoryTools({
        ...original,
        readPolicy: async () => {
          const policy = await original.readPolicy();
          return {
            ...policy,
            accessScope: {
              ...policy.accessScope,
              deniedRoots: [...policy.accessScope.deniedRoots, denied],
            },
          };
        },
        captureReader: async (captured, options) => {
          expect(captured).toBe(context);
          actualReader = await captureNativeLocalRepositoryReader(captured, options);
          expect(Object.isFrozen(actualReader)).toBe(true);
          expect(typeof actualReader.executeDirectoryVerification).toBe('function');
          expect(typeof actualReader.revalidate).toBe('function');
          return actualReader;
        },
      }).execute(context.toolName, input, context.signal))!;
    });
    source = join(f.f.root, 'source');
    denied = join(source, '.git', 'config');
    const result = await f.a.call({ path: source }, { tool: 'InspectLocalRepository' });
    expect(result.response.success, JSON.stringify(result.value)).toBe(false);
    expect(paths).not.toContain(denied);
    expect(String(result.value)).toContain('read-access-required');
  },
);

it.runIf(process.platform === 'darwin').each([60000, 60001])(
  'retains the actual signed reader operation deadline boundary (%ims) and refuses owner revocation',
  async (timeoutMs) => {
    const execute = vi.spyOn(sandbox, 'executeSandboxedCommand');
    let checked = false;
    const f = await localRepositoryNativeToolFixture(cleanups, async (context) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      let reader: Awaited<ReturnType<typeof captureNativeLocalRepositoryReader>> | undefined;
      try {
        if (timeoutMs > 60000) {
          await expect(
            captureNativeLocalRepositoryReader(context, { deadline: now + timeoutMs }),
          ).rejects.toThrow('Local repository native reads unavailable');
        } else {
          reader = await captureNativeLocalRepositoryReader(context, { deadline: now + timeoutMs });
          expect(reader.deadline).toBe(now + timeoutMs);
          reader.assertCurrentSync!();
          revokeAuthSession(f.auth);
          expect(() => reader!.assertCurrentSync!()).toThrow();
        }
        checked = true;
        return { content: JSON.stringify({ boundary: 'checked' }), isError: false };
      } finally {
        await reader?.dispose();
        clock.mockRestore();
      }
    });
    await f.a.call({ path: join(f.f.root, 'source') });
    expect(checked).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  },
);
