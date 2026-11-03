import * as authorizationModule from '../local-repository-preparation-authorization.js';
import * as operationModule from '../local-repository-preparation-operation.js';
import * as sourceModule from '../local-repository-preparation-source.js';
import {
  executeLocalRepositoryPreparation,
  type LocalRepositoryPreparationEnvelope,
} from '../local-repository-preparation-operation.js';
import { executeNativeLocalRepositoryPreparation } from '../native-local-repository-preparation.js';
import { preparedRepositoryResultSha256 } from '../codex-conversation-store.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as filesystem from 'node:fs/promises';
import * as readers from '../local-repository-native-read.js';
import * as objectData from '../local-repository-preparation-object-data.js';
import {
  createPreparationAttemptDiagnostics,
  recordPreparationAttempt,
  runRecordedPreparationAttempt,
} from './fixtures/preparation-attempt-diagnostics.js';
import { observePreparationService } from './fixtures/preparation-service-diagnostics.js';
import { observePrivateHelperBoundary } from './fixtures/private-helper-boundary-diagnostics.js';
import * as actor from '../qualified-local-repository-actor.js';
import * as sandbox from '../sandboxed-command.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import {
  capturePreparationPrimaryCustody,
  localPreparationNativeFixture,
} from './fixtures/local-preparation-native.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
const profileOnly = process.env.MITZO_PREPARATION_OWNER_PROFILE === '1';
const fixtureGit = (directory: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    [
      '-C',
      directory,
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.invalid',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
actual(
  profileOnly
    ? 'profiles one genuine consumed original full gate without actor effects'
    : 'materializes through the original signed permission and fixed actor while preserving dirty source and primary custody',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No model or network calls');
      }),
    );
    const productionIdentity = async () => {
      const directory = fileURLToPath(new URL('../', import.meta.url));
      const files = (await readdir(directory, { recursive: true }))
        .filter((file) => file.endsWith('.ts') && !file.includes('__tests__/'))
        .sort();
      const hashes: Record<string, string> = {};
      for (const file of files)
        hashes['server/' + file] = createHash('sha256')
          .update(await readFile(join(directory, file)))
          .digest('hex');
      return hashes;
    };
    const repositoryIdentity = async () => {
      const directory = fileURLToPath(new URL('../../', import.meta.url));
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8' });
      const rows = git(
        'ls-files',
        '--stage',
        '-z',
        '--',
        'server/__tests__',
        'package.json',
        'package-lock.json',
        'vitest.config.*',
        'tsconfig*.json',
        'packages/*/package*.json',
      )
        .split('\0')
        .filter(Boolean);
      const files: Record<string, { mode: string; gitBlob: string; sha256: string }> = {};
      for (const row of rows) {
        const match = /^(100644|100755|120000) ([a-f0-9]+) 0\t(.+)$/.exec(row);
        if (!match) throw Error('Committed fixture identity unavailable');
        const bytes =
          match[1] === '120000'
            ? Buffer.from(await readlink(join(directory, match[3])))
            : await readFile(join(directory, match[3]));
        files[match[3]] = {
          mode: match[1],
          gitBlob: match[2],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      return {
        head: git('rev-parse', 'HEAD').trim(),
        tree: git('rev-parse', 'HEAD^{tree}').trim(),
        trackedStatus: git('status', '--porcelain=v1', '--untracked-files=no'),
        files,
      };
    };
    const atRunRepository = await repositoryIdentity();
    const atRunSources = await productionIdentity();
    const inputIdentity = createHash('sha256').update(JSON.stringify(atRunSources)).digest('hex');
    const require = createRequire(import.meta.url),
      loader = require.resolve('tsx/esm');
    const runtimeInputs = {
      nodeVersion: process.version,
      executablePath: process.execPath,
      executableSha256: createHash('sha256')
        .update(await readFile(process.execPath))
        .digest('hex'),
      loader,
      loaderSha256: createHash('sha256')
        .update(await readFile(loader))
        .digest('hex'),
      workerEntry: 'server/sandboxed-command-worker.ts',
      workerEntrySha256: atRunSources['server/sandboxed-command-worker.ts'],
      workerRuntime: 'existing sourceRuntime tsx/esm worker; no separately compiled worker binary',
    };
    const actorEvidencePath =
      process.env.CI === 'true'
        ? fileURLToPath(
            new URL('../../test-results/qualified-preparation-actor.json', import.meta.url),
          )
        : `/private/tmp/mitzo-qualified-preparation-actor-${inputIdentity.slice(0, 16)}.json`;
    await mkdir(dirname(actorEvidencePath), { recursive: true });
    if (atRunRepository.trackedStatus !== '') {
      await writeFile(
        actorEvidencePath,
        JSON.stringify({
          version: 1,
          precondition: 'tracked-inputs-not-clean',
          head: atRunRepository.head,
          tree: atRunRepository.tree,
        }),
      );
      throw Error('Actual attempt requires committed clean fixture inputs');
    }
    const diagnostics = createPreparationAttemptDiagnostics();
    let rowState: unknown = { status: 'not-reached' };
    let receiptState: unknown = { status: 'not-reached' };
    const returnedReaders: Array<
      Awaited<ReturnType<typeof readers.captureNativeLocalRepositoryReader>>
    > = [];
    const read = readers.captureNativeLocalRepositoryReader;
    vi.spyOn(readers, 'captureNativeLocalRepositoryReader').mockImplementation(async (...args) => {
      const reader = await diagnostics.capture('reader-capture', () => read(...args));
      if (!returnedReaders.includes(reader)) returnedReaders.push(reader);
      return reader;
    });
    const preparedRead = readers.capturePreparedRepositoryReader;
    vi.spyOn(readers, 'capturePreparedRepositoryReader').mockImplementation(async (...args) => {
      const reader = await diagnostics.capture('prepared-reader-capture', () =>
        preparedRead(...args),
      );
      if (!returnedReaders.includes(reader)) returnedReaders.push(reader);
      return reader;
    });
    const captureData = objectData.captureLocalRepositoryPreparationObjectData;
    vi.spyOn(objectData, 'captureLocalRepositoryPreparationObjectData').mockImplementation(
      (...args) => diagnostics.capture('object-data-capture', () => captureData(...args)),
    );
    const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const cleanupCounts = { reader: 0, objects: 0, artifact: 0 };
    const privateHelpers = { checkout: [] as unknown[], publication: [] as unknown[] };
    vi.mocked(filesystem.rm).mockImplementation(async (...args) => {
      const name = typeof args[0] === 'string' ? basename(args[0]) : '';
      const kind = name.startsWith('mitzo-native-read-')
        ? 'reader'
        : name.startsWith('mitzo-preparation-objects-')
          ? 'objects'
          : name.startsWith('mitzo-qualified-actor-')
            ? 'artifact'
            : undefined;
      if (!kind) return Reflect.apply(originalFs.rm, filesystem, args);
      return diagnostics.capture(`${kind}-cleanup`, async () => {
        await Reflect.apply(originalFs.rm, filesystem, args);
        cleanupCounts[kind]++;
      });
    });
    let prepared = false;
    let observedContext: NativeHostToolContext | undefined;
    let normalizedPreparedResult:
      Awaited<ReturnType<typeof executeNativeLocalRepositoryPreparation>> | undefined;
    let sourcePreservation: ((prefix: string, staged: boolean) => Promise<void>) | undefined;
    const postPreparation: { status: string; elapsedMs?: number; rowSha256?: string } = {
      status: 'not-reached',
    };
    const secondPreparation: {
      state: string;
      elapsedMs?: number;
      admissionCalls?: number;
      continuation?: boolean;
    } = { state: 'not-reached' };
    let observedReceipt: Awaited<ReturnType<typeof executeLocalRepositoryPreparation>> | undefined;
    let authorization:
      Awaited<ReturnType<typeof captureLocalRepositoryPreparationAuthorization>> | undefined;
    const originalCapture = captureLocalRepositoryPreparationAuthorization;
    vi.spyOn(
      authorizationModule,
      'captureLocalRepositoryPreparationAuthorization',
    ).mockImplementation(async (...args) => {
      const held = await originalCapture(...args);
      authorization = held;
      mark('authorization');
      return held;
    });
    const phases: string[] = [];
    const mark = (name: string) => phases.push(`${name}:${Date.now()}`);
    const metrics = {
      admission: { calls: 0, ms: 0 },
      operationCounts: {} as Record<string, number>,
      source: {
        calls: profileOnly ? 0 : (null as number | null),
        ms: profileOnly ? 0 : (null as number | null),
        fullOwnerCallsObserved: profileOnly,
        captureCalls: 0,
        captureMs: 0,
      },
      readTransports: { calls: 0, ms: 0 },
      effectTransports: { calls: 0, ms: 0 },
      checkouts: { calls: 0, ms: 0 },
      approvalRemainingMs: 0,
      consumptionRemainingMs: 0,
    };
    const originalOperation = executeLocalRepositoryPreparation;
    vi.spyOn(operationModule, 'executeLocalRepositoryPreparation').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      observedContext = args[0].context; // actual adapter-owned context; never reboxed
      return diagnostics.capture('preparation-operation', () =>
        Reflect.apply(originalOperation, this, args),
      );
    });
    const sourceFactory = captureNativeLocalRepositoryPreparationSource;
    vi.spyOn(sourceModule, 'captureNativeLocalRepositoryPreparationSource').mockImplementation(
      async function (this: unknown, ...args) {
        const start = performance.now();
        metrics.source.captureCalls++;
        try {
          // Preserve the actual returned owner and witness. Full-assertion
          // counts are explicitly unobserved on the private-adapter path.
          return await diagnostics.capture('source-capture', () =>
            Reflect.apply(sourceFactory, this, args),
          );
        } finally {
          metrics.source.captureMs += performance.now() - start;
        }
      },
    );
    const nativeFull = OwnedLocalCodexChatAdmission.prototype.assertCurrent;
    vi.spyOn(OwnedLocalCodexChatAdmission.prototype, 'assertCurrent').mockImplementation(
      async function (this: OwnedLocalCodexChatAdmission) {
        const start = performance.now();
        metrics.admission.calls++;
        try {
          await diagnostics.capture('admission-owner', () => Reflect.apply(nativeFull, this, []));
        } finally {
          metrics.admission.ms += performance.now() - start;
        }
      },
    );
    const readTransport = sandbox.executeSandboxedCommand,
      effectTransport = sandbox.executePrivateNativeFileHelper,
      checkout = sandbox.executePrivateRepositoryStagingCheckout;
    vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(async (...args) => {
      const start = performance.now();
      metrics.readTransports.calls++;
      const operation = /"operation":"([A-Za-z]+)"/.exec(args[0].command)?.[1] ?? 'Unclassified';
      metrics.operationCounts[operation] = (metrics.operationCounts[operation] ?? 0) + 1;
      try {
        return await readTransport(...args);
      } finally {
        metrics.readTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateNativeFileHelper').mockImplementation(async (...args) => {
      const start = performance.now();
      metrics.effectTransports.calls++;
      try {
        return await diagnostics.capture('publication', () =>
          observePrivateHelperBoundary(
            args[0],
            () => effectTransport(...args),
            privateHelpers.publication,
          ),
        );
      } finally {
        metrics.effectTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateRepositoryStagingCheckout').mockImplementation(
      async (...args) => {
        const start = performance.now();
        metrics.checkouts.calls++;
        try {
          return await diagnostics.capture('checkout', () =>
            observePrivateHelperBoundary(args[0], () => checkout(...args), privateHelpers.checkout),
          );
        } finally {
          metrics.checkouts.ms += performance.now() - start;
        }
      },
    );
    const actualActor = actor.materializeQualifiedLocalRepositoryTask;
    vi.spyOn(actor, 'materializeQualifiedLocalRepositoryTask').mockImplementation(
      async (...args) => {
        mark('actor-start');
        metrics.consumptionRemainingMs =
          (f.f.workspace.get(args[0].facts.workspaceId).pendingHostTaskDecision?.evidence
            .expiresAt ?? Date.now()) - Date.now();
        try {
          if (profileOnly) {
            const before = structuredClone(metrics);
            const start = performance.now();
            await args[0].assertCurrent();
            const fullGate = {
              elapsedMs: performance.now() - start,
              operationCounts: Object.fromEntries(
                Object.entries(metrics.operationCounts)
                  .map(([name, count]) => [name, count - (before.operationCounts[name] ?? 0)])
                  .filter(([, count]) => count !== 0),
              ),
              admission: {
                calls: metrics.admission.calls - before.admission.calls,
                ms: metrics.admission.ms - before.admission.ms,
              },
              source: {
                calls: (metrics.source.calls ?? 0) - (before.source.calls ?? 0),
                ms: (metrics.source.ms ?? 0) - (before.source.ms ?? 0),
              },
              readTransports: {
                calls: metrics.readTransports.calls - before.readTransports.calls,
                ms: metrics.readTransports.ms - before.readTransports.ms,
              },
            };
            await writeFile(
              `/private/tmp/mitzo-qualified-preparation-owner-profile-${inputIdentity.slice(0, 16)}.json`,
              JSON.stringify(
                {
                  fullGate,
                  phases,
                  metrics,
                  approvalExpiry: args[0].expiresAt,
                  measuredAt: Date.now(),
                  authority: 'actual original signed consumed operation',
                  effects: false,
                  repositoryIdentity: {
                    before: atRunRepository,
                    after: await repositoryIdentity(),
                  },
                  productionIdentity: {
                    before: atRunSources,
                    after: await productionIdentity(),
                    workerEntry: 'server/sandboxed-command-worker.ts',
                    workerRuntime:
                      'existing sourceRuntime tsx/esm worker; no separately compiled worker binary',
                  },
                  plannedActor: {
                    allocationDirectoryCount: args[0].facts.directories.length,
                    directoryCreations: args[0].facts.directories.length + 1,
                    combinedPublicationHelpers: 1,
                    stagingHelpers: 1,
                    effectHelperCount: 2,
                    originalFullCallbacksOnSuccess: 7,
                    nativeOnlyFullCallbacksOnSuccess: 4,
                    sourceFullCallbacksOnSuccess: 3,
                    explanation:
                      'Static success-path count from current actor: 4 native-only full callbacks for private artifact/staging/cleanup and 3 consumed-source full callbacks for publication/delivery. The consumed operation already includes the native context owner. Does not measure object/task read cost or establish whole-window viability.',
                  },
                },
                null,
                2,
              ),
            );
            await diagnostics.check(
              'profile-production-identity',
              async () =>
                JSON.stringify(await productionIdentity()) === JSON.stringify(atRunSources),
            );
            throw Error(
              'Bounded original full-owner profile complete; actor deliberately not invoked',
            );
          }
          const result = await diagnostics.capture('actor', () => actualActor(...args));
          mark('actor-complete');
          return result;
        } catch (error) {
          mark('actor-error');
          throw error;
        }
      },
    );
    const executeAttempt = async (
      context: NativeHostToolContext | undefined,
      input: Record<string, unknown>,
      envelope?: Readonly<LocalRepositoryPreparationEnvelope>,
      nativeRun?: () => Promise<
        Awaited<ReturnType<typeof executeNativeLocalRepositoryPreparation>>
      >,
    ) => {
      mark('callback');
      if (!nativeRun && !envelope) throw Error('Preparation fixture envelope missing');
      const source = input.path as string;
      await writeFile(join(source, 'task.txt'), 'DIRTY SOURCE\n');
      await writeFile(join(source, 'untracked'), 'KEEP\n');
      // Real staged content change reuses an existing accepted blob, so the
      // object-count budget stays five while index preservation is meaningful.
      await writeFile(join(source, 'context.md'), 'accepted source');
      const git = (...args: string[]) => fixtureGit(source, ...args);
      git('add', '--', 'context.md');
      await diagnostics.check(
        'setup-staged-name',
        async () => git('diff', '--cached', '--name-only') === 'context.md',
      );
      await diagnostics.check(
        'setup-staged-blob',
        async () => git('rev-parse', ':context.md') === git('rev-parse', 'HEAD:task.txt'),
      );
      if (Object.values(diagnostics.snapshot().checks).some((check) => check.status !== 'passed')) {
        await persistAttempt();
        throw Object.assign(Error('Preparation fixture setup failed'), {
          code: 'fixture_setup_check_failed',
        });
      }
      const index = await readFile(join(source, '.git', 'index'));
      const head = await readFile(join(source, '.git', 'HEAD'));
      const run = () => {
        if (!context || !envelope) throw Error('Original legacy preparation context missing');
        return executeLocalRepositoryPreparation(
          {
            context,
            registry: f.registry,
            events: f.f.events,
            workspaces: f.f.workspace,
            qualifySource: async (_path, original, intent, options) => {
              mark('qualify-start');
              const result = await captureNativeLocalRepositoryPreparationSource(
                original,
                intent,
                options,
              );
              mark('qualify-end');
              return Object.freeze({
                ...result,
                async assertCurrent(options?: Readonly<{ deadline: number }>) {
                  const start = performance.now();
                  metrics.source.calls = (metrics.source.calls ?? 0) + 1;
                  try {
                    await diagnostics.capture('source-owner', () => result.assertCurrent(options));
                  } finally {
                    metrics.source.ms = (metrics.source.ms ?? 0) + performance.now() - start;
                  }
                },
              });
            },
          },
          input,
          envelope,
        );
      };
      let normalizedResult:
        Awaited<ReturnType<typeof executeNativeLocalRepositoryPreparation>> | undefined;
      let receipt: Awaited<ReturnType<typeof executeLocalRepositoryPreparation>> | undefined;
      const sourceChecks = async (prefix: string, includeStaged: boolean) => {
        await diagnostics.check(`${prefix}-index`, async () =>
          (await readFile(join(source, '.git', 'index'))).equals(index),
        );
        await diagnostics.check(`${prefix}-head`, async () =>
          (await readFile(join(source, '.git', 'HEAD'))).equals(head),
        );
        await diagnostics.check(
          `${prefix}-dirty`,
          async () => (await readFile(join(source, 'task.txt'), 'utf8')) === 'DIRTY SOURCE\n',
        );
        if (includeStaged)
          await diagnostics.check(
            `${prefix}-staged`,
            async () => (await readFile(join(source, 'context.md'), 'utf8')) === 'accepted source',
          );
        await diagnostics.check(
          `${prefix}-untracked`,
          async () => (await readFile(join(source, 'untracked'), 'utf8')) === 'KEEP\n',
        );
      };
      sourcePreservation = sourceChecks;
      const inspect = async () => {
        receipt ??= observedReceipt;
        const originalContext = observedContext ?? context;
        // Every observation is independent: one failed read/check never hides
        // another preservation outcome or the original operation exception.
        await sourceChecks('finally', true);
        rowState = (await diagnostics.observe('row-state', async () => {
          const record = f.f.workspace.get(authorization!.request.id);
          return {
            status: 'observed',
            state: record.state,
            rowSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
            pendingState: record.pendingHostTask?.state ?? null,
            decisionState: record.pendingHostTaskDecision?.state ?? null,
            hasPublication: record.qualifiedLocalPreparation?.publication !== undefined,
            hasHostReservation: record.hostReservation !== undefined,
            taskIdentitySha256: record.pendingHostTask?.taskIdentity
              ? createHash('sha256')
                  .update(JSON.stringify(record.pendingHostTask.taskIdentity))
                  .digest('hex')
              : null,
          };
        })) ?? { status: 'unknown-read-failed' };
        if (profileOnly) {
          await diagnostics.check(
            'profile-consumed',
            async () =>
              f.f.workspace.get(authorization!.request.id).pendingHostTaskDecision?.state ===
              'consumed',
          );
          for (const [index, path] of [
            authorization!.scope.create.task.directory,
            authorization!.scope.sourceGitEffects.administrationDirectory,
            authorization!.scope.sourceGitEffects.branchReference,
          ].entries())
            await diagnostics.check(`profile-absent-${index}`, async () => {
              try {
                await lstat(path);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ENOENT';
              }
            });
          return;
        }
        await diagnostics.check('primary-custody', async () => {
          if (!originalContext) throw Error('Original preparation context unavailable');
          assertInitialPrimary(originalContext.workspace);
          return true;
        });
        await diagnostics.check('task-independent-git', async () => {
          const directory = receipt?.directory ?? authorization!.scope.create.task.directory;
          const git = await lstat(join(directory, '.git'));
          return (
            git.isDirectory() &&
            !git.isSymbolicLink() &&
            (await readFile(join(directory, '.git', 'HEAD'), 'utf8')) ===
              `ref: refs/heads/${authorization!.scope.create.featureBranch}\n`
          );
        });
        if (!receipt) {
          for (const name of ['receipt-materialized', 'receipt-task-identity'])
            diagnostics.skip(name);
          return;
        }
        receiptState = {
          status: nativeRun ? 'service-returned' : 'returned',
          adapterReturned: normalizedResult !== undefined,
          state: receipt.state,
          sha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
          taskIdentitySha256: receipt.taskIdentity
            ? createHash('sha256').update(JSON.stringify(receipt.taskIdentity)).digest('hex')
            : null,
        };
        await diagnostics.check(
          'receipt-materialized',
          async () => receipt!.state === 'materialized',
        );
        await diagnostics.check('receipt-task-identity', async () => {
          const identity = receipt!.taskIdentity;
          const git = await lstat(join(receipt!.directory, '.git'));
          return (
            identity !== undefined &&
            identity.linkedGit === undefined &&
            identity.git.dev === git.dev &&
            identity.git.ino === git.ino &&
            identity.localSource?.path === source &&
            authorization!.scope.layout === 'standalone'
          );
        });
        await sourceChecks('post-receipt', false);
      };
      await runRecordedPreparationAttempt(
        diagnostics,
        async () => {
          if (profileOnly) {
            let error: unknown;
            try {
              await diagnostics.capture('profile-operation', run);
            } catch (caught) {
              error = caught;
            }
            await diagnostics.check(
              'profile-expected-error',
              async () => (error as { code?: string })?.code === 'pending_host_task_uncertain',
            );
          } else if (nativeRun) normalizedPreparedResult = normalizedResult = await nativeRun();
          else receipt = await run();
        },
        inspect,
        async () => persistAttempt(),
      );
      if (profileOnly) return { profiled: true };
      prepared = true;
      return normalizedResult ?? { prepared: true };
    };
    let preparationCalls = 0;
    const f = await localPreparationNativeFixture(cleanups, executeAttempt, {
      nativeBaseReads: true,
      preparationEnvelope: profileOnly,
      diagnostics,
      ...(!profileOnly
        ? {
            executeOriginalCapture: async (capture, input, signal) => {
              if (preparationCalls++ > 0)
                return executeNativeLocalRepositoryPreparation(
                  { capture, events: f.f.events, registry: f.registry, workspaces: f.f.workspace },
                  input,
                  signal,
                );
              const result = await executeAttempt(undefined, input, undefined, () =>
                executeNativeLocalRepositoryPreparation(
                  { capture, events: f.f.events, registry: f.registry, workspaces: f.f.workspace },
                  input,
                  signal,
                ),
              );
              if (!('content' in result) || !('isError' in result))
                throw Error('Normalized native preparation result missing');
              return result; // actual adapter result, never JSON-normalized twice
            },
          }
        : {}),
    });
    const serviceState = observePreparationService(diagnostics, f.f.workspace, (value) => {
      observedReceipt = value;
    });
    cleanups.push(serviceState.restore);
    const assertInitialPrimary = capturePreparationPrimaryCustody(f);
    async function completePrepared(
      original: NativeHostToolContext,
      receipt: Awaited<ReturnType<typeof executeLocalRepositoryPreparation>>,
      afterAdopt: () => Promise<void> = async () => {},
      expectedResult?: Awaited<ReturnType<typeof executeNativeLocalRepositoryPreparation>>,
    ) {
      const source = original.nativeTarget;
      const binding = f.a.initial.lease.binding;
      const admission = f.a.initial.admission;
      const known = new Set(f.native.commands(f.a.sessionId, binding).map((command) => command.id));
      const turnsBefore = f.a.requests.filter((request) => request.method === 'turn/start').length;
      let entered = false,
        settled = false,
        failure: unknown;
      f.a.installPreparedBoundary(async (assertConversationCurrentSync) => {
        if (entered) return;
        entered = true;
        try {
          if (expectedResult) {
            const durable = f.native.completedPreparedRepositoryResultSha256(
              f.a.sessionId,
              binding,
              source,
              original.callId,
              original.requestHash,
            );
            if (durable !== preparedRepositoryResultSha256(expectedResult))
              throw Error('Actual completed preparation result mismatch');
          }
          const selectedPolicy = () =>
            composeOwnedLocalNativeExecutionPolicy({
              session: f.a.session,
              binding,
              assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
            });
          const owner = Object.freeze({
            signal: f.f.signal.signal,
            selectedPolicy,
            assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
          });
          const adopted = await diagnostics.capture('prepared-boundary', () =>
            withPreparedRepositoryBarrierReadScope(
              selectedPolicy(),
              source.commandId,
              {
                signal: f.f.signal.signal,
                selectedPolicy,
                assertCurrentSync: () => {
                  assertConversationCurrentSync();
                  admission.assertPreparedRepositoryBoundaryCurrentSync();
                },
                revalidate: async () => {
                  await admission.assertCurrent();
                  assertConversationCurrentSync();
                },
              },
              (scope) =>
                admission.adoptPreparedRepositoryAtBoundary(
                  scope,
                  source,
                  assertConversationCurrentSync,
                  owner,
                ),
            ),
          );
          expect(adopted).toMatchObject({ id: receipt.request.id, directory: receipt.directory });
          await afterAdopt();
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          settled = true;
        }
      });
      await f.a.complete();
      await vi.waitFor(
        () => {
          if (!settled) throw Error('Waiting for original completed boundary');
        },
        { timeout: 210000 },
      ); // harness only; original authority deadlines are unchanged
      if (failure) throw failure;
      await vi.waitFor(
        () => {
          const children = f.native
            .commands(f.a.sessionId, binding)
            .filter((command) => !known.has(command.id));
          if (
            f.a.requests.filter((request) => request.method === 'turn/start').length !==
              turnsBefore + 1 ||
            children.length !== 1 ||
            f.native.readNativeExecution(f.a.sessionId, binding, children[0])?.phase !== 'accepted'
          )
            throw Error('Waiting for actual queued child turn');
        },
        { timeout: 150000 },
      );
    }
    const finalize = f.f.workspace.finalizePendingHostTaskDecision;
    vi.spyOn(f.f.workspace, 'finalizePendingHostTaskDecision').mockImplementation((...args) => {
      const result = Reflect.apply(finalize, f.f.workspace, args);
      mark('approved');
      metrics.approvalRemainingMs = result.evidence.expiresAt - Date.now();
      return result;
    });
    async function persistAttempt() {
      const after = await productionIdentity();
      await writeFile(
        actorEvidencePath,
        JSON.stringify(
          {
            inputIdentity,
            productionIdentity: { before: atRunSources, after },
            repositoryIdentity: { before: atRunRepository, after: await repositoryIdentity() },
            runtimeInputs,
            diagnostics: diagnostics.snapshot(),
            rowState,
            receiptState,
            postPreparation,
            secondPreparation,
            privateHelpers,
            serviceState: serviceState(),
            cleanup: {
              returnedReaders: returnedReaders.length,
              completed: cleanupCounts,
              contextDisposalIndependentlyObserved: profileOnly,
              contextDisposal: profileOnly
                ? (diagnostics.snapshot().stages['context-dispose'] ?? null)
                : 'unknown',
            },
            phases,
            metrics,
            profileOnly,
            prepared,
            identityUnchanged: JSON.stringify(after) === JSON.stringify(atRunSources),
            measuredAt: Date.now(),
          },
          null,
          2,
        ),
      );
    }
    const result = await recordPreparationAttempt(
      diagnostics,
      'native-call',
      // Preserve the staged/dirty local-source journey; remote freshness is covered separately.
      () => f.a.call({ path: join(f.f.root, 'source'), base: { kind: 'ref', ref: 'HEAD' } }),
      async () => {},
      async () => persistAttempt(),
    );
    if (
      !profileOnly &&
      result.response.success &&
      observedReceipt &&
      observedContext &&
      normalizedPreparedResult
    ) {
      const receipt = observedReceipt;
      const original = observedContext; // historical tuple only, never reused as current authority
      const normalized = normalizedPreparedResult;
      const source = original.nativeTarget!;
      const binding = f.a.initial.lease.binding;
      const custodyBefore = f.native.readHostCustody(f.a.sessionId, binding);
      const taskCanary = join(receipt.directory, 'host-acceptance-task.txt');
      await recordPreparationAttempt(
        diagnostics,
        'post-prepare-admission',
        async () => {
          const start = performance.now();
          postPreparation.status = 'waiting-for-completed-boundary';
          try {
            await completePrepared(
              original,
              receipt,
              async () => {
                postPreparation.status = 'actual-primary-adopted';
                await writeFile(taskCanary, 'Retain new task work');
              },
              normalized,
            );
            postPreparation.status = 'second-turn-acknowledged-by-controlled-rpc';
          } finally {
            postPreparation.elapsedMs = performance.now() - start;
          }
        },
        async () => {
          await diagnostics.check(
            'adopted-source-observer',
            async () => typeof sourcePreservation === 'function',
          );
          await sourcePreservation?.('adopted', true);
          await diagnostics.check(
            'adopted-task-work',
            async () => (await readFile(taskCanary, 'utf8')) === 'Retain new task work',
          );
          await diagnostics.check(
            'adopted-repository-primary',
            async () => f.f.workspace.getForConversation(f.a.sessionId)?.id === receipt.request.id,
          );
          await diagnostics.check(
            'adopted-event-cwd',
            async () => f.f.events.getSession(f.a.sessionId)?.cwd === receipt.directory,
          );
          await diagnostics.check(
            'adopted-native-cwd',
            async () => f.native.read(f.a.sessionId, binding).cwd === receipt.directory,
          );
          await diagnostics.check(
            'adopted-original-client',
            async () =>
              f.a.initial.lease.client === f.f.rpc &&
              JSON.stringify(f.native.readHostCustody(f.a.sessionId, binding)) ===
                JSON.stringify(custodyBefore),
          );
          await diagnostics.check('adopted-child-fifo', async () => {
            const children = f.native
              .commands(f.a.sessionId, binding)
              .filter((command) => command.id !== source.commandId);
            return (
              children.length === 1 &&
              f.f.events.observePreparedRepositoryContinuation(children[0].id).state === 'consumed'
            );
          });
          await diagnostics.check('adopted-second-turn', async () => {
            const starts = f.a.requests.filter((request) => request.method === 'turn/start');
            return starts.length === 2 && starts[1].params.cwd === receipt.directory;
          });
          await diagnostics.check(
            'original-execution-cwd',
            async () =>
              f.native.readNativeExecution(f.a.sessionId, binding, {
                id: source.commandId,
                attempt: source.attempt,
              })?.policy.cwd === f.a.initial.workspace.directory,
          );
          await diagnostics.observe('post-adoption-row', async () => {
            postPreparation.rowSha256 = createHash('sha256')
              .update(JSON.stringify(f.f.workspace.get(receipt.request.id)))
              .digest('hex');
          });
        },
        async () => persistAttempt(),
      );
    }
    expect(atRunRepository.trackedStatus).toBe('');
    expect(rowState).toMatchObject({ status: 'observed' });
    expect(cleanupCounts.reader).toBe(returnedReaders.length);
    expect(cleanupCounts.objects).toBe(1);
    for (const name of ['reader-cleanup', 'objects-cleanup'])
      expect(diagnostics.snapshot().stages[name]?.errors ?? []).toEqual([]);
    expect(await productionIdentity()).toEqual(atRunSources);
    expect(await repositoryIdentity()).toEqual(atRunRepository);
    for (const [name, check] of Object.entries(diagnostics.snapshot().checks))
      expect(
        check.status,
        JSON.stringify({ name, diagnostic: diagnostics.snapshot(), rowState, receiptState }),
      ).toBe('passed');
    expect(
      result.response.success,
      JSON.stringify({ value: result.value, phases, metrics, permissions: f.permissions.length }),
    ).toBe(true);
    expect(result.value).toEqual(
      profileOnly
        ? { profiled: true }
        : {
            preparationId: observedReceipt?.request.id,
            directory: observedReceipt?.directory,
            state: 'materialized',
          },
    );
    if (!profileOnly) {
      expect(observedReceipt).toBeDefined();
      expect(metrics.source.captureCalls).toBeGreaterThan(0);
      expect(metrics.source.fullOwnerCallsObserved).toBe(false);
      expect(metrics.source.calls).toBeNull();
    }
    expect(prepared).toBe(!profileOnly);
    if (profileOnly) {
      expect(metrics.effectTransports.calls).toBe(0);
      expect(metrics.checkouts.calls).toBe(0);
    }
    expect(f.permissions).toHaveLength(1);
    if (!profileOnly) {
      // Reuse this genuine adopted runtime and populated source. The old first
      // preparation fixture had never exercised its more expensive custody
      // owner as the starting point for another actual preparation.
      // Reuse the primary-error-preserving recorder for every second-attempt
      // assertion, so CI retains the actual failing owner/helper stage too.
      await recordPreparationAttempt(
        diagnostics,
        'native-call',
        async () => {
          const current = f.f.workspace.getForConversation(f.a.sessionId)!;
          const nextSource = join(f.f.root, 'next-source');
          fixtureGit(
            f.f.root,
            'clone',
            '--no-hardlinks',
            '-q',
            join(f.f.root, 'source'),
            nextSource,
          );
          await Promise.all(
            Array.from({ length: 13 }, (_, index) =>
              writeFile(join(nextSource, `plan-${index}.md`), `Planning document ${index}\n`),
            ),
          );
          fixtureGit(nextSource, 'add', '.');
          fixtureGit(nextSource, 'commit', '-qm', 'populated second source');
          const selectedHead = fixtureGit(nextSource, 'rev-parse', 'HEAD');
          const [sourceHead, sourceIndex] = await Promise.all([
            readFile(join(nextSource, '.git', 'HEAD')),
            readFile(join(nextSource, '.git', 'index')),
          ]);
          const started = performance.now();
          const callsBefore = metrics.admission.calls;
          const next = await f.a.call({
            path: nextSource,
            base: { kind: 'ref', ref: 'HEAD' },
          });
          secondPreparation.elapsedMs = Math.round(performance.now() - started);
          secondPreparation.admissionCalls = metrics.admission.calls - callsBefore;
          secondPreparation.state = next.value.state ?? 'failed';
          console.info('Second preparation', JSON.stringify(secondPreparation));
          expect(
            next.response.success,
            JSON.stringify({ value: next.value, diagnostics: diagnostics.snapshot() }),
          ).toBe(true);
          expect(next.value).toMatchObject({ state: 'materialized' });
          expect(next.value.preparationId).not.toBe(current.id);
          expect(f.f.workspace.getForConversation(f.a.sessionId)?.id).toBe(current.id);
          expect(f.permissions).toHaveLength(2);
          await sourcePreservation?.('adopted', true);
          const secondContext = observedContext!;
          const secondReceipt = f.f.workspace.get(next.value.preparationId).pendingHostTask!;
          expect(secondReceipt.state).toBe('materialized');
          await completePrepared(secondContext, secondReceipt);
          const adopted = f.f.workspace.getForConversation(f.a.sessionId)!;
          expect(adopted.id).toBe(next.value.preparationId);
          expect(f.f.events.getSession(f.a.sessionId)?.cwd).toBe(secondReceipt.directory);
          expect(f.native.read(f.a.sessionId, f.a.initial.lease.binding).cwd).toBe(
            secondReceipt.directory,
          );
          expect(
            f.a.requests.filter((request) => request.method === 'turn/start').at(-1)?.params.cwd,
          ).toBe(secondReceipt.directory);
          expect(fixtureGit(secondReceipt.directory, 'rev-parse', 'HEAD')).toBe(selectedHead);
          expect(fixtureGit(nextSource, 'rev-parse', 'HEAD')).toBe(selectedHead);
          expect(await readFile(join(nextSource, '.git', 'HEAD'))).toEqual(sourceHead);
          expect(await readFile(join(nextSource, '.git', 'index'))).toEqual(sourceIndex);
          await Promise.all(
            Array.from({ length: 13 }, async (_, index) => {
              expect(
                await readFile(join(secondReceipt.directory, `plan-${index}.md`), 'utf8'),
              ).toBe(`Planning document ${index}\n`);
            }),
          );
          expect(cleanupCounts.reader).toBe(returnedReaders.length);
          expect(cleanupCounts.objects).toBe(2);
          secondPreparation.continuation = true;
          for (const [name, check] of Object.entries(diagnostics.snapshot().checks))
            expect(check.status, JSON.stringify({ name, check })).toBe('passed');
        },
        async () => {},
        async () => persistAttempt(),
      );
    }
  },
  // Retain the existing overall harness bound while exercising a second source
  // through the same setup. Each operation still has its own 300s envelope,
  // 120s approval, 60s read phases and 30s helper bounds. Completed receipts
  // alone are insufficient: both actual handoffs and child RPCs must succeed.
  720000,
);

it('refuses a fabricated operation in the actual signed callback before allocation or source effects', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No model or network calls');
    }),
  );
  const f = await localPreparationNativeFixture(cleanups, async (_context, input) => {
    const source = input.path as string;
    const head = await readFile(join(source, '.git', 'HEAD')),
      index = await readFile(join(source, '.git', 'index'));
    await expect(
      Promise.resolve().then(() =>
        f.f.workspace.materializeQualifiedPendingHostTask({ id: 'model-intent-only' } as never, {
          scope: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'pending_host_task_authority_required' });
    expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
    expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
    return { refused: true };
  });
  const result = await f.a.call({ path: join(f.f.root, 'source') });
  expect(result.response.success, result.value).toBe(true);
  expect(result.value).toEqual({ refused: true });
  expect(f.permissions).toEqual([]);
}, 30000);
