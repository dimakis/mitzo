import * as authorizationModule from '../local-repository-preparation-authorization.js';
import { executeLocalRepositoryPreparation } from '../local-repository-preparation-operation.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as filesystem from 'node:fs/promises';
import * as readers from '../local-repository-native-read.js';
import * as objectData from '../local-repository-preparation-object-data.js';
import {
  createPreparationAttemptDiagnostics,
  recordPreparationAttempt,
  runRecordedPreparationAttempt,
} from './fixtures/preparation-attempt-diagnostics.js';
import { observePreparationService } from './fixtures/preparation-service-diagnostics.js';
import * as actor from '../qualified-local-repository-actor.js';
import * as sandbox from '../sandboxed-command.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
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
    const actorEvidencePath = `/private/tmp/mitzo-qualified-preparation-actor-${inputIdentity.slice(0, 16)}.json`;
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
      returnedReaders.push(reader);
      return reader;
    });
    const captureData = objectData.captureLocalRepositoryPreparationObjectData;
    vi.spyOn(objectData, 'captureLocalRepositoryPreparationObjectData').mockImplementation(
      (...args) => diagnostics.capture('object-data-capture', () => captureData(...args)),
    );
    const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const cleanupCounts = { reader: 0, objects: 0, artifact: 0 };
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
      source: { calls: 0, ms: 0 },
      readTransports: { calls: 0, ms: 0 },
      effectTransports: { calls: 0, ms: 0 },
      checkouts: { calls: 0, ms: 0 },
      approvalRemainingMs: 0,
      consumptionRemainingMs: 0,
    };
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
        return await diagnostics.capture('publication', () => effectTransport(...args));
      } finally {
        metrics.effectTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateRepositoryStagingCheckout').mockImplementation(
      async (...args) => {
        const start = performance.now();
        metrics.checkouts.calls++;
        try {
          return await diagnostics.capture('checkout', () => checkout(...args));
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
                calls: metrics.source.calls - before.source.calls,
                ms: metrics.source.ms - before.source.ms,
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
                    originalFullCallbacksOnSuccess: 13,
                    explanation:
                      'Static success-path count from current actor: 3 original full callbacks for separate staging checkout, 3 for combined publication, plus 7 actor/read/cleanup callbacks. The measured operation gate excludes the additional native read-owner wait inside actor full(). Does not measure object/task read cost or establish whole-window viability.',
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
    const f = await localPreparationNativeFixture(
      cleanups,
      async (context, input, envelope) => {
        mark('callback');
        if (!envelope) throw Error('Preparation fixture envelope missing');
        const source = input.path as string;
        await writeFile(join(source, 'task.txt'), 'DIRTY SOURCE\n');
        await writeFile(join(source, 'untracked'), 'KEEP\n');
        // Real staged content change reuses an existing accepted blob, so the
        // object-count budget stays five while index preservation is meaningful.
        await writeFile(join(source, 'context.md'), 'accepted source');
        const git = (...args: string[]) =>
          execFileSync(
            '/usr/bin/git',
            ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
            {
              encoding: 'utf8',
              env: {
                PATH: '/usr/bin:/bin',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
              },
            },
          ).trim();
        git('add', '--', 'context.md');
        await diagnostics.check(
          'setup-staged-name',
          async () => git('diff', '--cached', '--name-only') === 'context.md',
        );
        await diagnostics.check(
          'setup-staged-blob',
          async () => git('rev-parse', ':context.md') === git('rev-parse', 'HEAD:task.txt'),
        );
        if (
          Object.values(diagnostics.snapshot().checks).some((check) => check.status !== 'passed')
        ) {
          await persistAttempt();
          throw Object.assign(Error('Preparation fixture setup failed'), {
            code: 'fixture_setup_check_failed',
          });
        }
        const index = await readFile(join(source, '.git', 'index'));
        const head = await readFile(join(source, '.git', 'HEAD'));
        const run = () =>
          executeLocalRepositoryPreparation(
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
                    metrics.source.calls++;
                    try {
                      await diagnostics.capture('source-owner', () =>
                        result.assertCurrent(options),
                      );
                    } finally {
                      metrics.source.ms += performance.now() - start;
                    }
                  },
                });
              },
            },
            input,
            envelope!,
          );
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
              async () =>
                (await readFile(join(source, 'context.md'), 'utf8')) === 'accepted source',
            );
          await diagnostics.check(
            `${prefix}-untracked`,
            async () => (await readFile(join(source, 'untracked'), 'utf8')) === 'KEEP\n',
          );
        };
        const inspect = async () => {
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
          await diagnostics.check(
            'primary-custody',
            async () =>
              f.f.workspace.getOrdinaryWorkspaceForConversation(context.conversationId)?.id ===
              context.workspace.id,
          );
          await diagnostics.check(
            'repository-primary',
            async () => f.f.workspace.getForConversation(context.conversationId) === undefined,
          );
          await diagnostics.check(
            'task-linkage',
            async () =>
              (await readFile(
                join(receipt?.directory ?? authorization!.scope.create.task.directory, '.git'),
                'utf8',
              )) === `gitdir: ${authorization!.scope.sourceGitEffects.administrationDirectory}\n`,
          );
          if (!receipt) {
            for (const name of ['receipt-materialized', 'receipt-task-identity'])
              diagnostics.skip(name);
            return;
          }
          receiptState = {
            status: 'returned',
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
          await diagnostics.check(
            'receipt-task-identity',
            async () =>
              receipt!.taskIdentity?.linkedGit?.directory ===
              authorization!.scope.sourceGitEffects.administrationDirectory,
          );
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
            } else receipt = await run();
          },
          inspect,
          async () => persistAttempt(),
        );
        if (profileOnly) return { profiled: true };
        prepared = true;
        return { prepared: true };
      },
      { nativeBaseReads: true, preparationEnvelope: true, diagnostics },
    );
    const serviceState = observePreparationService(diagnostics, f.f.workspace);
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
            serviceState: serviceState(),
            cleanup: { returnedReaders: returnedReaders.length, completed: cleanupCounts },
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
      () => f.a.call({ path: join(f.f.root, 'source') }),
      async () => {},
      async () => persistAttempt(),
    );
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
    expect(result.value).toEqual(profileOnly ? { profiled: true } : { prepared: true });
    expect(prepared).toBe(!profileOnly);
    if (profileOnly) {
      expect(metrics.effectTransports.calls).toBe(0);
      expect(metrics.checkouts.calls).toBe(0);
    }
    expect(f.permissions).toHaveLength(1);
  },
  300000,
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
