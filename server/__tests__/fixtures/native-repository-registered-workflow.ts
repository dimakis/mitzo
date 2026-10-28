import { afterAll, afterEach, expect, it, vi } from 'vitest';
import {
  copyFile,
  mkdtemp,
  readFile,
  writeFile,
  symlink,
  realpath,
  stat,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build, version as compilerVersion } from 'esbuild';
import { Socket } from 'node:net';
import * as nativePolicy from '../../owned-local-codex-native-policy.js';
import * as sandbox from '../../sandboxed-command.js';
import * as metadata from '../../local-repository-git-inspection.js';
import * as gitFacts from '../../local-repository-git-snapshot.js';
import * as repositoryDiscovery from '../../local-repository-discovery.js';
import * as childProcess from 'node:child_process';
import * as workspaceRuntime from '../../repository-workspace-runtime.js';
import { localRepositoryNativeToolFixture } from './local-repository-native-tools.js';
import { EventStore } from '../../event-store.js';
import { setAuthRevocationStore, revokeAuthSession } from '../../auth.js';
import { CodexTransportError } from '../../codex-app-server-client.js';
import {
  SynchronousStageProfiler,
  NativeReadBoundaryProfile,
  installSignedNativeReadStages,
} from './synchronous-stage-profiler.js';
import { createPreparationAttemptDiagnostics } from './preparation-attempt-diagnostics.js';
import { observePreparationService } from './preparation-service-diagnostics.js';
import { nativeRepositoryFixtureWorkerSources } from './native-repository-worker-sources.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock('../../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async () => 'synthetic-api-key',
  }),
}));
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
const cleanups: Array<() => void | Promise<void>> = [];
let recordCleanup: ((cleanupMs: number) => Promise<void>) | undefined;
let beginCleanup: (() => void) | undefined;
afterEach(async () => {
  beginCleanup?.();
  beginCleanup = undefined;
  const started = performance.now();
  for (const close of cleanups.splice(0).reverse()) await close();
  await recordCleanup?.(performance.now() - started);
  recordCleanup = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// Explicit mechanical target only: signed real owners, mocked provider RPC and
// process launch, actual existing SRT/Python read transport against scratch.
// This does not qualify a provider turn or the synthetic UNUSED companion.
export function registerNativeRepositoryWorkflow(account: 'api' | 'subscription') {
  // Whole-journey resource envelope only: retained CI evidence shows completed
  // account journeys near 238s, with identical sources varying by over 50s in
  // preparation on loaded hosts. Keep every helper/read/admission/handoff bound.
  // This finite CI allowance includes all phases and cleanup; local stays 240s.
  const wholeCaseBudgetMs = process.env.CI ? 480_000 : 240_000;
  it.skipIf(
    process.platform !== 'darwin' || process.env.MITZO_RUN_NATIVE_READ_TOOLS_MECHANICAL !== '1',
  )(
    `registered owned repository workflow survives cold login and viewer detach on ${account} with actual OS fences`,
    async () => {
      const inspectOnly = process.env.MITZO_NATIVE_READ_TOOLS_INSPECT_ONLY === '1';
      const revocationOnly = process.env.MITZO_NATIVE_READ_TOOLS_REVOCATION_ONLY === '1';
      if (
        process.env.MITZO_REQUIRE_NATIVE_REPOSITORY_WORKFLOW === '1' &&
        (inspectOnly || revocationOnly)
      )
        throw Error('CI requires both complete native repository account journeys');
      const setupStarted = performance.now();
      vi.stubEnv('TMPDIR', '/private/tmp');
      const artifacts = await mkdtemp('/private/tmp/mitzo-read-tools-artifact-');
      const { rm } = await import('node:fs/promises');
      cleanups.push(() => rm(artifacts, { recursive: true, force: true }));
      const executable = join(artifacts, 'codex');
      await copyFile(
        process.env.S9_CODEX_NATIVE_FIXTURE ??
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
      const sourceWorker = fileURLToPath(
        new URL('../../sandboxed-command-worker.ts', import.meta.url),
      );
      // Compile and hash the same complete standalone ESM closure qualified by
      // the ungated module-load smoke, before any real sandbox helper runs.
      const entryPoints = nativeRepositoryFixtureWorkerSources.map((file) =>
        fileURLToPath(new URL('../../' + file, import.meta.url)),
      );
      const buildOptions = {
        entryPoints,
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
      ).toEqual([...nativeRepositoryFixtureWorkerSources].sort());
      const compiledWorker = join(artifacts, 'sandboxed-command-worker.js');
      await writeFile(join(artifacts, 'package.json'), JSON.stringify({ type: 'module' }));
      await symlink(await realpath('node_modules'), join(artifacts, 'node_modules'));
      const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      const compilation = {
        compiler: `esbuild ${compilerVersion}`,
        config: { platform: 'node', format: 'esm', target: 'es2022', bundle: false },
        inputs: Object.fromEntries(
          await Promise.all(
            entryPoints.map(async (path) => [
              path.split('/').at(-1)!,
              sha256(await readFile(path)),
            ]),
          ),
        ),
        outputs: Object.fromEntries(
          await Promise.all(
            entryPoints.map(async (path) => {
              const file = path.split('/').at(-1)!.replace(/\.ts$/, '.js');
              return [file, sha256(await readFile(join(artifacts, file)))];
            }),
          ),
        ),
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
          if (
            args[0] === '/bin/sh' &&
            Array.isArray(argv) &&
            argv[0] === '-c' &&
            argv[1]?.includes('/usr/bin/sandbox-exec')
          ) {
            const phase = [...phases].reverse().find((item) => item.totalMs === undefined);
            expect(phase).toBeDefined();
            const spawned = performance.now();
            phase!.prefixMs = spawned - phase!.started;
            const child = Reflect.apply(spawn, childProcess, args);
            child.once('close', (code, signal) => {
              phase!.childMs = performance.now() - spawned;
              phase!.exit = code;
              phase!.exitSignal = signal;
            });
            return child;
          }
          if (Array.isArray(argv) && argv.includes(sourceWorker)) {
            expect(args[0]).toBe(process.execPath);
            expect(argv).toHaveLength(4);
            expect(argv.slice(0, 3)).toEqual(['--import', tsLoader, sourceWorker]);
            const settings = argv[3];
            const settingsBytes = readFileSync(settings);
            const before = sha256(settingsBytes);
            const payload = JSON.parse(settingsBytes.toString('utf8'));
            let phase = [...phases]
              .reverse()
              .find(
                (item) =>
                  item.commandSha === sha256(Buffer.from(payload.command)) &&
                  item.totalMs === undefined,
              );
            if (!phase) {
              phase = {
                commandSha: sha256(Buffer.from(payload.command)),
                started: performance.now(),
                timeoutMs: 30000,
                operation: payload.privateRepositoryCheckoutJson
                  ? 'PrivateRepositoryCheckout'
                  : payload.privateNativeFileRequestJson
                    ? JSON.parse(payload.privateNativeFileRequestJson).operation
                    : 'private',
              };
              phases.push(phase);
            }
            const spawned = performance.now();
            phase.prefixMs = spawned - phase.started;
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
              phase!.totalMs = performance.now() - phase!.started;
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
      let phase = 'setup';
      let profilePhase: string | undefined;
      beginCleanup = () => {
        profilePhase = 'cleanup';
      };
      const synchronous = new SynchronousStageProfiler(
        () => performance.now(),
        () => profilePhase ?? phase,
      );
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
      const profiledCompose = synchronous.wrap('nativePolicy.compose', compose);
      vi.spyOn(nativePolicy, 'composeOwnedLocalNativeExecutionPolicy').mockImplementation(
        (...args) => {
          const start = performance.now();
          trace.policyCalls++;
          try {
            return profiledCompose(...args);
          } finally {
            trace.policyMs += performance.now() - start;
          }
        },
      );
      const monitor =
        (enforced: typeof sandbox.executeSandboxedCommand) =>
        async (...args: Parameters<typeof sandbox.executeSandboxedCommand>) => {
          if (revocationOnly) throw Error('Protocol-only control forbids native helpers');
          const start = performance.now();
          expect(args[0].timeoutMs).toBeLessThanOrEqual(30000);
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
        };
      const enforced = sandbox.executeSandboxedCommand;
      const observe = sandbox.executePrivateRepositoryObservation;
      const helperTransport = vi
        .spyOn(sandbox, 'executeSandboxedCommand')
        .mockImplementation(monitor(enforced));
      const observationTransport = vi
        .spyOn(sandbox, 'executePrivateRepositoryObservation')
        .mockImplementation(monitor(observe as typeof sandbox.executeSandboxedCommand));
      const metadataBudgets: number[] = [];
      const factsBudgets: number[] = [];
      const inspect = metadata.inspectLocalRepositoryGitMetadata;
      vi.spyOn(metadata, 'inspectLocalRepositoryGitMetadata').mockImplementation(
        async (...args) => {
          try {
            metadataBudgets.push(args[0].timeoutMs!);
            return await inspect(...args);
          } catch (error) {
            trace.metadataError = error instanceof Error ? error.message : 'unknown';
            throw error;
          }
        },
      );
      const facts = gitFacts.readLocalRepositoryGitFacts;
      vi.spyOn(gitFacts, 'readLocalRepositoryGitFacts').mockImplementation(async (...args) => {
        factsBudgets.push(args[1].timeoutMs);
        return facts(...args);
      });
      cleanups.push(installSignedNativeReadStages(synchronous, new NativeReadBoundaryProfile()));
      const f = await localRepositoryNativeToolFixture(
        cleanups,
        async () => {
          throw Error('Registered runtime must own actual dispatch');
        },
        {
          registeredExecutablePath: executable,
          api: account === 'api',
          resumeFromPreviousLogin: true,
          continuityV2: true,
          separateViewer: true,
        },
      );
      const sourcePath =
        process.env.MITZO_NATIVE_READ_TOOLS_SOURCE_PATH ?? join(f.f.root, 'source');
      const preparationDiagnostics = createPreparationAttemptDiagnostics();
      const preparationService = observePreparationService(preparationDiagnostics, f.f.workspace);
      cleanups.push(preparationService.restore);
      // Representative retained history must not be replayed at every current-owner fence.
      for (let index = 0; index < 3000; index++)
        f.f.events.append(f.a.sessionId, 'block_delta', {
          text: 'retained offline history '.repeat(16),
        });
      const history = vi.spyOn(f.f.events, 'getSessionEvents');
      vi.spyOn(workspaceRuntime, 'getRepositoryWorkspaces').mockReturnValue(f.f.workspace);
      f.detachViewer();
      expect(f.a.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(1);
      expect(f.a.requests.some((r) => r.method === 'thread/start')).toBe(false);
      const resumed = f.native.read(f.a.sessionId, f.a.initial.lease.binding);
      expect(resumed.threadId).toBe(`thread-${f.a.sessionId}`);
      expect(resumed.toolSurfaceRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(
        f.native.readHostCustody(f.a.sessionId, f.a.initial.lease.binding)?.authSessionId,
      ).not.toBe(f.auth.id);
      // Calls below go through all three actual registered handlers. A thread
      // resume inherits its registered tools instead of sending dynamicTools.
      const declaredBudgets: number[] = [];
      const deadlines: number[] = [];
      for (const name of ['discoverLocalRepository', 'inspectLocalRepository'] as const) {
        const original = repositoryDiscovery[name];
        vi.spyOn(repositoryDiscovery, name).mockImplementation(
          async (request: Parameters<typeof repositoryDiscovery.discoverLocalRepository>[0]) => {
            declaredBudgets.push(request.limits?.timeoutMs ?? -1);
            const reader = Object.getOwnPropertyDescriptor(request, 'nativeReader')?.value;
            expect(request.limits?.timeoutMs).toBe(
              name === 'inspectLocalRepository' ? 60000 : 30000,
            );
            deadlines.push(reader.deadline);
            return Reflect.apply(original, repositoryDiscovery, [request]);
          },
        );
      }
      const setupMs = performance.now() - setupStarted;
      const operationTimings: Record<string, number> = {};
      const outcomes: Record<string, unknown> = {};
      let filesystemCallBudget: { trackedFiles: number; limit: number } | undefined;
      phase = 'ready';
      let preparedDirectory: string | undefined;
      // Keep retained outcomes bounded and payload-free, including denial paths.
      const outcome = (result: Awaited<ReturnType<typeof f.a.call>>) => {
        let parsed = result.value;
        if (typeof parsed === 'string' && Buffer.byteLength(parsed) <= 4096) {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            // Non-JSON errors never enter the retained payload-free projection.
          }
        }
        const value = typeof parsed === 'object' && parsed !== null ? parsed : {};
        const code = (value: unknown) =>
          typeof value === 'string' && /^[a-z-]{1,80}$/.test(value) ? value : undefined;
        return {
          success: result.response.success,
          state: code(value.state),
          reason: code(value.reason),
          branch: value.branch === 'main' ? 'main' : undefined,
          dirtyState: code(value.dirty?.state),
          candidateCount: Array.isArray(value.candidates) ? value.candidates.length : undefined,
          instructionCount: Array.isArray(value.instructions?.files)
            ? value.instructions.files.length
            : undefined,
        };
      };
      const writeEvidence = async (cleanupMs?: number) => {
        await writeFile(
          '/private/tmp/mitzo-registered-read-tools-phase-evidence.json',
          JSON.stringify(
            {
              compilation,
              account,
              coldResume: true,
              viewerDetached: true,
              inspectOnly,
              revocationOnly,
              phase,
              setupMs,
              wholeCaseBudgetMs,
              operationTimings,
              outcomes,
              cleanupMs,
              declaredBudgets,
              deadlines,
              metadataBudgets,
              factsBudgets,
              metrics: f.a.metrics,
              synchronous: synchronous.snapshot(),
              filesystemCallBudget,
              preparationDiagnostics: preparationDiagnostics.snapshot(),
              preparationService: preparationService(),
              trace,
              phases,
            },
            null,
            2,
          ),
        );
        const evidenceRoot = process.env.MITZO_NATIVE_REPOSITORY_EVIDENCE_DIR;
        if (evidenceRoot) {
          await mkdir(evidenceRoot, { recursive: true });
          await copyFile(
            '/private/tmp/mitzo-registered-read-tools-phase-evidence.json',
            join(evidenceRoot, account + '.json'),
          );
        }
      };
      recordCleanup = writeEvidence;
      await writeEvidence();
      if (!inspectOnly && !revocationOnly) {
        phase = 'discover';
        const discoverStarted = performance.now();
        const discovery = await f.a.call({ path: sourcePath });
        operationTimings.DiscoverLocalRepository = performance.now() - discoverStarted;
        outcomes.DiscoverLocalRepository = outcome(discovery);
        await writeEvidence();
        expect(declaredBudgets).toEqual([30000]);
        for (const scratch of new Set(trace.scratch))
          await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
        for (const settings of sourceSettings)
          await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(phases.length).toBeGreaterThan(0);
        expect(discovery.response.success, JSON.stringify(discovery.value)).toBe(true);
        expect(
          discovery.value,
          JSON.stringify({ value: discovery.value, metrics: f.a.metrics, trace, phases }),
        ).toMatchObject({
          state: 'selected',
          candidates: [{ path: sourcePath }],
          truncated: false,
        });
      }
      if (revocationOnly) {
        phase = 'invalid-input';
        const invalid = await f.a.call({ path: 42 }, { tool: 'InspectLocalRepository' });
        outcomes.invalid = outcome(invalid);
        await writeEvidence();
        expect(invalid.response.success).toBe(false);
        expect(helperTransport).not.toHaveBeenCalled();
        expect(observationTransport).not.toHaveBeenCalled();
        expect(factsBudgets).toHaveLength(0);
      } else {
        phase = 'inspect';
        await writeEvidence();
        const inspectStarted = performance.now();
        const inspection = await f.a.call({ path: sourcePath }, { tool: 'InspectLocalRepository' });
        operationTimings.InspectLocalRepository = performance.now() - inspectStarted;
        outcomes.InspectLocalRepository = outcome(inspection);
        await writeEvidence();
        expect(declaredBudgets).toEqual(inspectOnly ? [60000] : [30000, 60000]);
        expect(factsBudgets).toHaveLength(inspectOnly ? 1 : 2);
        expect(inspection.response.success, JSON.stringify(inspection.value)).toBe(true);
        expect(inspection.value).toMatchObject({
          path: sourcePath,
          dirty: { state: 'unknown' },
        });
        expect(inspection.value.instructions.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: join(sourcePath, 'AGENTS.md') }),
          ]),
        );
        expect(history).not.toHaveBeenCalled();
        {
          phase = 'prepare';
          const prepareStarted = performance.now();
          // Real source inspection remains read-only. Preparation effects use a
          // disposable copy of the same repository, including its actual object store.
          let preparationSource = sourcePath;
          if (process.env.MITZO_NATIVE_READ_TOOLS_SOURCE_PATH) {
            preparationSource = join(f.f.root, 'preparation-source');
            childProcess.execFileSync(
              '/usr/bin/git',
              [
                '-c',
                'core.hooksPath=/dev/null',
                'clone',
                '--no-local',
                sourcePath,
                preparationSource,
              ],
              {
                env: {
                  PATH: '/usr/bin:/bin',
                  GIT_CONFIG_GLOBAL: '/dev/null',
                  GIT_CONFIG_SYSTEM: '/dev/null',
                },
                stdio: 'ignore',
              },
            );
            // CI's detached merge checkout keeps the exact tested tree, while the
            // disposable fixture supplies its required ordinary base branch name.
            childProcess.execFileSync(
              '/usr/bin/git',
              [
                '-C',
                preparationSource,
                '-c',
                'core.hooksPath=/dev/null',
                'checkout',
                '-q',
                '-B',
                'main',
              ],
              {
                env: {
                  PATH: '/usr/bin:/bin',
                  GIT_CONFIG_GLOBAL: '/dev/null',
                  GIT_CONFIG_SYSTEM: '/dev/null',
                },
                stdio: 'ignore',
              },
            );
          }
          // Retain the representative repository and add a nested empty Git tree.
          // checkout-index omits these directories; the actor must create parents first.
          const fixtureGit = (args: string[], input?: string) =>
            childProcess
              .execFileSync(
                '/usr/bin/git',
                [
                  '-C',
                  preparationSource,
                  '-c',
                  'core.hooksPath=/dev/null',
                  '-c',
                  'commit.gpgsign=false',
                  ...args,
                ],
                {
                  input,
                  encoding: 'utf8',
                  env: {
                    PATH: '/usr/bin:/bin',
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                    GIT_AUTHOR_NAME: 'Offline fixture',
                    GIT_AUTHOR_EMAIL: 'offline@example.invalid',
                    GIT_COMMITTER_NAME: 'Offline fixture',
                    GIT_COMMITTER_EMAIL: 'offline@example.invalid',
                  },
                },
              )
              .trim();
          const empty = fixtureGit(['mktree'], '');
          const parent = fixtureGit(['mktree'], `040000 tree ${empty}\tempty\n`);
          const tree = fixtureGit(
            ['mktree'],
            fixtureGit(['ls-tree', 'HEAD']) +
              `\n040000 tree ${parent}\t__mitzo_empty_tree_fixture__\n`,
          );
          const commit = fixtureGit(
            ['commit-tree', tree, '-p', 'HEAD'],
            'Offline nested empty tree fixture\n',
          );
          fixtureGit(['update-ref', 'refs/heads/main', commit]);
          // Publication must inspect each tracked leaf before it writes it. Keep
          // fixed owner-fence overhead bounded while accounting for repository size:
          // the Mac source fixture has 873 leaves; the CI checkout has over 5,000.
          const trackedFiles = fixtureGit(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
            .split('\0')
            .filter(Boolean).length;
          filesystemCallBudget = { trackedFiles, limit: 16_000 + 2 * trackedFiles };
          const prepared = await f.a.call(
            // This journey intentionally selects its locally constructed nested-empty-tree commit.
            { path: preparationSource, base: { kind: 'ref', ref: 'HEAD' } },
            { tool: 'PrepareLocalRepository' },
          );
          operationTimings.PrepareLocalRepository = performance.now() - prepareStarted;
          outcomes.PrepareLocalRepository = outcome(prepared);
          await writeEvidence();
          expect(prepared.response.success, JSON.stringify(prepared.value)).toBe(true);
          expect(prepared.value).toMatchObject({ state: 'materialized' });
          preparedDirectory = prepared.value.directory;
          expect(
            (
              await stat(join(preparedDirectory!, '__mitzo_empty_tree_fixture__', 'empty'))
            ).isDirectory(),
          ).toBe(true);
          expect(f.permissions).toHaveLength(1);
          expect(f.a.metrics.syncCalls).toBeLessThan(filesystemCallBudget.limit);
          expect(history).not.toHaveBeenCalled();
        }
        phase = 'denied';
        const denied = await f.a.call(
          { path: join(f.f.root, 'login') },
          { tool: 'InspectLocalRepository' },
        );
        outcomes.denied = outcome(denied);
        await writeEvidence();
        expect(JSON.stringify(denied.value)).not.toContain('access_token');
        expect(denied.response.success).toBe(false);
      }
      expect(
        processBoundary.mock.calls.some((args) =>
          /\/codex(?:-runtime|-code-mode-host)?$/.test(String(args[0])),
        ),
      ).toBe(false);
      expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
      for (const scratch of new Set(trace.scratch))
        await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
      if (!revocationOnly) expect(phases.length).toBeGreaterThan(0);
      for (const settings of sourceSettings)
        await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(join(f.f.root, 'source'), 'task.txt'), 'utf8')).toBe(
        'accepted source',
      );
      if (preparedDirectory) {
        phase = 'handoff';
        await writeEvidence();
        const started = performance.now();
        await f.a.complete();
        await vi.waitFor(
          () => {
            expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(
              2,
            );
          },
          { timeout: 120000, interval: 100 },
        );
        const adopted = f.native.read(f.a.sessionId, f.a.initial.lease.binding);
        expect(adopted.threadId).toBe(resumed.threadId);
        expect(adopted.cwd).toBe(preparedDirectory);
        expect(f.f.events.getSession(f.a.sessionId)?.cwd).toBe(preparedDirectory);
        expect(
          f.a.requests.filter((request) => request.method === 'turn/start').at(-1)?.params.cwd,
        ).toBe(preparedDirectory);
        operationTimings.PreparedRepositoryHandoff = performance.now() - started;
        const continued = await f.a.call(
          { path: preparedDirectory },
          { tool: 'InspectLocalRepository' },
        );
        expect(continued.response.success, JSON.stringify(continued.value)).toBe(true);
        expect(continued.value.path).toBe(preparedDirectory);
        outcomes.handoff = {
          sameConversation: true,
          sameThread: true,
          taskCwdSelected: true,
          toolsUsable: true,
        };
        await writeEvidence();
      }
      for (const scratch of new Set(trace.scratch))
        await expect(stat(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const settings of sourceSettings)
        await expect(stat(settings)).rejects.toMatchObject({ code: 'ENOENT' });
      outcomes.custody = { sourcePreserved: true, scratchRemoved: true, settingsRemoved: true };
      const helpersBeforeRevoke =
        helperTransport.mock.calls.length + observationTransport.mock.calls.length;
      const factsBeforeRevoke = factsBudgets.length;
      phase = 'revoked';
      revokeAuthSession(f.auth);
      try {
        const revoked = await f.a.call({ path: join(f.f.root, 'source') });
        outcomes.revoked = outcome(revoked);
        await writeEvidence();
        expect(revoked.response.success).toBe(false);
      } catch (error) {
        // Actual revocation can retire the original transport before dispatch.
        // Only that fixed typed closure is equivalent to a refused response.
        if (!(error instanceof CodexTransportError) || error.category !== 'connection') throw error;
        outcomes.revoked = { success: false, transport: 'connection-closed' };
        await writeEvidence();
      }
      expect(helperTransport.mock.calls.length + observationTransport.mock.calls.length).toBe(
        helpersBeforeRevoke,
      );
      expect(factsBudgets).toHaveLength(factsBeforeRevoke);
      phase = 'completed';
      await writeEvidence();
    },
    wholeCaseBudgetMs,
  );
}
