import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as actor from '../qualified-local-repository-actor.js';
import * as sandbox from '../sandboxed-command.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';

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
    let prepared = false;
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
          await Reflect.apply(nativeFull, this, []);
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
        return await effectTransport(...args);
      } finally {
        metrics.effectTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateRepositoryStagingCheckout').mockImplementation(
      async (...args) => {
        const start = performance.now();
        metrics.checkouts.calls++;
        try {
          return await checkout(...args);
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
            expect(await productionIdentity()).toEqual(atRunSources);
            throw Error(
              'Bounded original full-owner profile complete; actor deliberately not invoked',
            );
          }
          const result = await actualActor(...args);
          mark('actor-complete');
          return result;
        } catch (error) {
          mark('actor-error:' + String(error));
          throw error;
        }
      },
    );
    const f = await localPreparationNativeFixture(
      cleanups,
      async (context, input) => {
        mark('callback');
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
        expect(git('diff', '--cached', '--name-only')).toBe('context.md');
        expect(git('rev-parse', ':context.md')).toBe(git('rev-parse', 'HEAD:task.txt'));
        const index = await readFile(join(source, '.git', 'index'));
        const head = await readFile(join(source, '.git', 'HEAD'));
        const authorization = await captureLocalRepositoryPreparationAuthorization(
          {
            context,
            registry: f.registry,
            events: f.f.events,
            workspaces: f.f.workspace,
            qualifySource: async (_path, original, intent) => {
              mark('qualify-start');
              const result = await captureNativeLocalRepositoryPreparationSource(original, intent);
              mark('qualify-end');
              return Object.freeze({
                ...result,
                async assertCurrent() {
                  const start = performance.now();
                  metrics.source.calls++;
                  try {
                    await result.assertCurrent();
                  } finally {
                    metrics.source.ms += performance.now() - start;
                  }
                },
              });
            },
          },
          input,
        );
        mark('authorization');
        await authorization.approve();
        mark('approved');
        metrics.approvalRemainingMs =
          (f.f.workspace.get(authorization.request.id).pendingHostTaskDecision?.evidence
            .expiresAt ?? Date.now()) - Date.now();
        if (profileOnly) {
          await expect(authorization.materialize()).rejects.toMatchObject({
            code: 'pending_host_task_uncertain',
          });
          expect(f.f.workspace.get(authorization.request.id).pendingHostTaskDecision?.state).toBe(
            'consumed',
          );
          for (const path of [
            authorization.scope.create.task.directory,
            authorization.scope.sourceGitEffects.administrationDirectory,
            authorization.scope.sourceGitEffects.branchReference,
          ])
            await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
          expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
          expect(await readFile(join(source, 'task.txt'), 'utf8')).toBe('DIRTY SOURCE\n');
          expect(await readFile(join(source, 'untracked'), 'utf8')).toBe('KEEP\n');
          return { profiled: true };
        }
        let receipt: Awaited<ReturnType<typeof authorization.materialize>>;
        try {
          receipt = await authorization.materialize();
        } finally {
          expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
          expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
          expect(await readFile(join(source, 'task.txt'), 'utf8')).toBe('DIRTY SOURCE\n');
          expect(await readFile(join(source, 'context.md'), 'utf8')).toBe('accepted source');
          expect(await readFile(join(source, 'untracked'), 'utf8')).toBe('KEEP\n');
        }
        expect(receipt.state).toBe('materialized');
        expect(receipt.taskIdentity?.linkedGit?.directory).toBe(
          authorization.scope.sourceGitEffects.administrationDirectory,
        );
        expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
        expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
        expect(await readFile(join(source, 'task.txt'), 'utf8')).toBe('DIRTY SOURCE\n');
        expect(await readFile(join(source, 'untracked'), 'utf8')).toBe('KEEP\n');
        expect(f.f.workspace.getOrdinaryWorkspaceForConversation(context.conversationId)?.id).toBe(
          context.workspace.id,
        );
        expect(f.f.workspace.getForConversation(context.conversationId)).toBeUndefined();
        expect(await readFile(join(receipt.directory, '.git'), 'utf8')).toBe(
          `gitdir: ${authorization.scope.sourceGitEffects.administrationDirectory}\n`,
        );
        prepared = true;
        return { prepared: true };
      },
      { nativeBaseReads: true },
    );
    let result: Awaited<ReturnType<typeof f.a.call>>;
    try {
      result = await f.a.call({ path: join(f.f.root, 'source') });
    } finally {
      const after = await productionIdentity();
      await writeFile(
        actorEvidencePath,
        JSON.stringify(
          {
            inputIdentity,
            productionIdentity: { before: atRunSources, after },
            runtimeInputs,
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
    expect(await productionIdentity()).toEqual(atRunSources);
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
