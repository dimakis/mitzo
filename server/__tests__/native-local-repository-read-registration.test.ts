import { afterEach, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, writeFile, symlink, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build, version as compilerVersion } from 'esbuild';
import { Socket } from 'node:net';
import * as nativePolicy from '../owned-local-codex-native-policy.js';
import * as sandbox from '../sandboxed-command.js';
import * as metadata from '../local-repository-git-inspection.js';
import * as childProcess from 'node:child_process';
import { localRepositoryNativeToolFixture } from './fixtures/local-repository-native-tools.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore, revokeAuthSession } from '../auth.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Explicit mechanical target only: signed real owners, mocked provider RPC and
// process launch, actual existing SRT/Python read transport against scratch.
// This does not qualify a provider turn or the synthetic UNUSED companion.
it.skipIf(
  process.platform !== 'darwin' || process.env.MITZO_RUN_NATIVE_READ_TOOLS_MECHANICAL !== '1',
)(
  'registered owned Discover and Inspect use the actual SRT reader and retain denial/current/cleanup fences',
  async () => {
    vi.stubEnv('TMPDIR', '/private/tmp');
    const artifacts = await mkdtemp('/private/tmp/mitzo-read-tools-artifact-');
    const { rm } = await import('node:fs/promises');
    cleanups.push(() => rm(artifacts, { recursive: true, force: true }));
    const executable = join(artifacts, 'codex');
    await copyFile(
      '/private/tmp/mitzo-native-protocol-0.160.0/codex-aarch64-apple-darwin',
      executable,
    );
    const companion = join(artifacts, 'codex-code-mode-host');
    // Deliberately nonfunctional fixture bytes satisfying only the existing
    // byte-custody format check. No companion qualification is claimed.
    await writeFile(
      companion,
      Buffer.concat([
        Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
        Buffer.from('SYNTHETIC UNUSED OFFLINE COMPANION'),
      ]),
      { mode: 0o755 },
    );
    const sourceWorker = fileURLToPath(new URL('../sandboxed-command-worker.ts', import.meta.url));
    const sourceAuthority = fileURLToPath(new URL('../sandbox-authority.ts', import.meta.url));
    const buildOptions = {
      entryPoints: [sourceWorker, sourceAuthority],
      outdir: artifacts,
      platform: 'node' as const,
      format: 'esm' as const,
      target: 'es2022',
      bundle: false,
      metafile: true,
      logLevel: 'silent' as const,
    };
    const compiled = await build(buildOptions);
    expect(
      Object.keys(compiled.metafile!.inputs)
        .map((path) => path.split('/').at(-1))
        .sort(),
    ).toEqual(['sandbox-authority.ts', 'sandboxed-command-worker.ts']);
    const compiledWorker = join(artifacts, 'sandboxed-command-worker.js');
    await writeFile(join(artifacts, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(await realpath('node_modules'), join(artifacts, 'node_modules'));
    const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const compilation = {
      compiler: `esbuild ${compilerVersion}`,
      config: { platform: 'node', format: 'esm', target: 'es2022', bundle: false },
      inputs: {
        worker: sha256(await readFile(sourceWorker)),
        authority: sha256(await readFile(sourceAuthority)),
      },
      outputs: {
        worker: sha256(await readFile(compiledWorker)),
        authority: sha256(await readFile(join(artifacts, 'sandbox-authority.js'))),
      },
    };
    await writeFile(
      '/private/tmp/mitzo-registered-read-tools-compiled-worker-evidence.json',
      JSON.stringify(compilation, null, 2),
    );
    const tsLoader = createRequire(import.meta.url).resolve('tsx/esm');
    const sourceSettings: string[] = [];
    const phases: Array<{
      commandSha: string;
      started: number;
      timeoutMs: number;
      operation: string;
      prefixMs?: number;
      childMs?: number;
      postMs?: number;
      totalMs?: number;
      exit?: number | null;
      exitSignal?: string | null;
      error?: string;
      stdoutBytes?: number;
      stderrBytes?: number;
    }> = [];
    const spawn = await vi
      .importActual<typeof import('node:child_process')>('node:child_process')
      .then((actual) => actual.spawn);
    const processBoundary = vi
      .mocked(childProcess.spawn)
      .mockImplementation((...args: Parameters<typeof spawn>) => {
        if (/\/codex(?:-runtime|-code-mode-host)?$/.test(String(args[0])))
          throw Error('Mechanical test forbids real native client execution');
        const argv = args[1];
        if (Array.isArray(argv) && argv.includes(sourceWorker)) {
          expect(args[0]).toBe(process.execPath);
          expect(argv).toHaveLength(4);
          expect(argv.slice(0, 3)).toEqual(['--import', tsLoader, sourceWorker]);
          const settings = argv[3];
          const settingsBytes = readFileSync(settings);
          const before = sha256(settingsBytes);
          const payload = JSON.parse(settingsBytes.toString('utf8'));
          const phase = [...phases]
            .reverse()
            .find(
              (item) =>
                item.commandSha === sha256(Buffer.from(payload.command)) &&
                item.totalMs === undefined,
            );
          expect(phase).toBeDefined();
          const spawned = performance.now();
          phase!.prefixMs = spawned - phase!.started;
          sourceSettings.push(settings);
          // Only production-equivalent worker startup changes. The SAME parent
          // owner, policy/settings, options/env/cwd/stdio and process group remain.
          const mapped: [(typeof args)[0], string[], (typeof args)[2]] = [
            args[0],
            [compiledWorker, settings],
            args[2],
          ];
          expect(mapped[2]).toBe(args[2]);
          const child = Reflect.apply(spawn, childProcess, mapped);
          child.once('close', (code, signal) => {
            phase!.childMs = performance.now() - spawned;
            phase!.exit = code;
            phase!.exitSignal = signal;
          });
          expect(sha256(readFileSync(settings))).toBe(before);
          return child;
        }
        return Reflect.apply(spawn, childProcess, args);
      });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw Error('Mechanical test forbids network');
    });
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
      throw Error('Mechanical test forbids sockets');
    });
    const revocations = new EventStore(':memory:');
    setAuthRevocationStore(revocations);
    cleanups.push(() => revocations.close());
    const trace = {
      policyCalls: 0,
      policyMs: 0,
      helpers: 0,
      helperMs: 0,
      helperErrors: 0,
      metadataError: '',
      scratch: [] as string[],
    };
    const compose = nativePolicy.composeOwnedLocalNativeExecutionPolicy;
    vi.spyOn(nativePolicy, 'composeOwnedLocalNativeExecutionPolicy').mockImplementation(
      (...args) => {
        const start = performance.now();
        trace.policyCalls++;
        try {
          return compose(...args);
        } finally {
          trace.policyMs += performance.now() - start;
        }
      },
    );
    const enforced = sandbox.executeSandboxedCommand;
    vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(async (...args) => {
      const start = performance.now();
      const phase: (typeof phases)[number] = {
        commandSha: sha256(Buffer.from(args[0].command)),
        started: start,
        timeoutMs: args[0].timeoutMs!,
        operation: args[0].command.match(/"operation":"([A-Za-z]+)"/)?.[1] ?? 'unknown',
      };
      phases.push(phase);
      trace.helpers++;
      trace.scratch.push(args[0].cwd);
      try {
        const result = await enforced(...args);
        phase.stdoutBytes = Buffer.byteLength(result.stdout ?? '');
        phase.stderrBytes = Buffer.byteLength(result.stderr ?? '');
        if (result.isError) {
          trace.helperErrors++;
          phase.error = /timed? out/i.test(result.content)
            ? 'timeout'
            : /permission|denied/i.test(result.content)
              ? 'denied'
              : /output/i.test(result.content)
                ? 'output-bound'
                : /unavailable/i.test(result.content)
                  ? 'unavailable'
                  : 'worker-error';
        }
        return result;
      } finally {
        phase.totalMs = performance.now() - start;
        phase.postMs = phase.totalMs - (phase.prefixMs ?? phase.totalMs) - (phase.childMs ?? 0);
        trace.helperMs += phase.totalMs;
      }
    });
    const inspect = metadata.inspectLocalRepositoryGitMetadata;
    vi.spyOn(metadata, 'inspectLocalRepositoryGitMetadata').mockImplementation(async (...args) => {
      try {
        return await inspect(...args);
      } catch (error) {
        trace.metadataError = error instanceof Error ? error.message : 'unknown';
        throw error;
      }
    });
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async () => {
        throw Error('Registered runtime must own actual dispatch');
      },
      { registeredExecutablePath: executable },
    );
    expect(f.f.launch).toHaveBeenCalledOnce();
    const thread = f.a.requests.find((r) => r.method === 'thread/start')!;
    const tools = thread.params.dynamicTools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['DiscoverLocalRepository', 'InspectLocalRepository']),
    );
    expect(tools.some((t) => t.name === 'PrepareLocalRepository')).toBe(false);
    const discovery = await f.a.call({ path: join(f.f.root, 'source') });
    for (const scratch of new Set(trace.scratch))
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const settings of sourceSettings)
      await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sourceSettings.length).toBeGreaterThan(0);
    await writeFile(
      '/private/tmp/mitzo-registered-read-tools-phase-evidence.json',
      JSON.stringify({ compilation, metrics: f.a.metrics, trace, phases }, null, 2),
    );
    expect(discovery.response.success, JSON.stringify(discovery.value)).toBe(true);
    expect(
      discovery.value,
      JSON.stringify({ value: discovery.value, metrics: f.a.metrics, trace, phases }),
    ).toMatchObject({
      state: 'selected',
      candidates: [{ path: join(f.f.root, 'source') }],
      truncated: false,
    });
    const inspection = await f.a.call(
      { path: join(f.f.root, 'source') },
      { tool: 'InspectLocalRepository' },
    );
    expect(inspection.response.success, JSON.stringify(inspection.value)).toBe(true);
    expect(inspection.value).toMatchObject({
      path: join(f.f.root, 'source'),
      branch: 'main',
      dirty: { state: 'unknown' },
    });
    expect(inspection.value.instructions.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(join(f.f.root, 'source'), 'AGENTS.md') }),
      ]),
    );
    const denied = await f.a.call(
      { path: join(f.f.root, 'login') },
      { tool: 'InspectLocalRepository' },
    );
    expect(JSON.stringify(denied.value)).not.toContain('access_token');
    expect(denied.response.success).toBe(false);
    revokeAuthSession(f.auth);
    const revoked = await f.a.call({ path: join(f.f.root, 'source') });
    expect(revoked.response.success).toBe(false);
    expect(
      processBoundary.mock.calls.some((args) =>
        /\/codex(?:-runtime|-code-mode-host)?$/.test(String(args[0])),
      ),
    ).toBe(false);
    expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    for (const scratch of new Set(trace.scratch))
      await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(join(f.f.root, 'source'), 'task.txt'), 'utf8')).toBe(
      'accepted source',
    );
  },
  60000,
);
