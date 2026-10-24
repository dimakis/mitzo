import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { captureQualifiedLocalRepositoryTask } from '../qualified-local-repository-task.js';
import * as taskModule from '../qualified-local-repository-task.js';
import * as readModule from '../local-repository-native-read.js';
import * as sandbox from '../sandboxed-command.js';
import { LocalRepositoryGitInspectionError } from '../local-repository-git-inspection.js';
import { normalizeCodexToolResult } from '../codex-tool-result.js';
import { preparedRepositoryResultSha256 } from '../codex-conversation-store.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { preparationDiagnosticFailure } from './fixtures/preparation-attempt-diagnostics.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import { materializePreparedRepositoryFixture } from './fixtures/materialized-prepared-repository.js';
import {
  capturePreparationPrimaryCustody,
  localPreparationNativeFixture,
} from './fixtures/local-preparation-native.js';

// CONTROLLED materialized seed, never actual Prepare/actor/permission evidence.
// The selected physical target below must retain real native read transport.
const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('builds a CONTROLLED physical seed with real allocation facts and publication bytes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No model/network calls');
    }),
  );
  let seed!: Awaited<ReturnType<typeof materializePreparedRepositoryFixture>>;
  const f = await localPreparationNativeFixture(cleanups, async (context) => {
    seed = await materializePreparedRepositoryFixture(
      cleanups,
      f.f,
      f.a.initial,
      context.nativeTarget!,
      context,
      { physicalReadSeed: true },
    );
    return {
      preparationId: seed.request.id,
      directory: seed.taskIdentity.directory,
      state: 'materialized',
    };
  });
  const unchanged = capturePreparationPrimaryCustody(f);
  expect((await f.a.call({ path: join(f.f.root, 'source') })).response.success).toBe(true);
  unchanged();
  const qualified = seed.record.qualifiedLocalPreparation!;
  const observed = await captureQualifiedLocalRepositoryTask(
    new LocalRepositoryReadAccess({
      deniedRoots: [],
      deadline: Date.now() + 30000,
      captureReadAnchor: fixtureReadAnchor,
      assertReadable: async () => {},
    }),
    qualified.allocationFacts,
    qualified.publication!,
  );
  const expected = { ...seed.taskIdentity };
  delete expected.localSource;
  expect(observed).toEqual(expected);
  expect(qualified.allocationFacts.source.objectFormat).toBe('sha1');
  expect(qualified.allocationFacts.existingDirectories!.length).toBeGreaterThan(0);
  expect(qualified.publication!.files.length).toBeGreaterThanOrEqual(6);
}, 30000); // Existing host fixture fact/byte validation, not a production clock.

function finiteObservation() {
  const records: Array<Record<string, unknown>> = [];
  const recentFailures: Array<Record<string, unknown>> = [];
  let dropped = 0;
  let readerDeadline: number | undefined;
  return {
    records,
    snapshot: () => ({ records, recentFailures, dropped, readerDeadline }),
    append(record: Record<string, unknown>) {
      if (records.length < 512) records.push(record);
      else dropped++;
    },
    reader(value: { deadline: number }) {
      readerDeadline = value.deadline;
    },
    async call<T>(stage: string, invoke: () => Promise<T>, detail = {}) {
      const record: Record<string, unknown> = {
        stage,
        start: performance.now(),
        remainingMs: readerDeadline === undefined ? null : readerDeadline - Date.now(),
        ...detail,
      };
      if (records.length < 512) records.push(record);
      else dropped++;
      try {
        const value = await invoke();
        record.returned = true;
        return value; // exact original returned object
      } catch (error) {
        record.error = preparationDiagnosticFailure(error);
        if (error instanceof LocalRepositoryGitInspectionError)
          record.inspection = { kind: error.kind, timeout: error.reason === 'timeout' };
        recentFailures.push(record);
        if (recentFailures.length > 32) recentFailures.shift();
        throw error; // original error identity, before callers' generic catches
      } finally {
        record.end = performance.now();
        record.remainingAfterMs = readerDeadline === undefined ? null : readerDeadline - Date.now();
      }
    },
  };
}

it('retains exact observer return/receiver/error identity with finite timeout evidence', async () => {
  const observer = finiteObservation();
  const returned = Object.freeze({ value: 1 });
  const owner = {
    result: returned,
    async invoke() {
      return this.result;
    },
  };
  const original = owner.invoke;
  expect(await observer.call('return', () => Reflect.apply(original, owner, []))).toBe(returned);
  const failure = new LocalRepositoryGitInspectionError('limit', 'timeout');
  await expect(
    observer.call('failure', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(observer.records[1].inspection).toEqual({ kind: 'limit', timeout: true });
  expect(JSON.stringify(observer.snapshot())).not.toContain(failure.message);
});

it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'qualifies a CONTROLLED materialized seed at the REAL fresh native physical boundary (NO actual creation)',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No model/network calls');
      }),
    );
    const observer = finiteObservation();
    let seed!: Awaited<ReturnType<typeof materializePreparedRepositoryFixture>>;
    let original!: NativeHostToolContext;
    let normalized!: ReturnType<typeof normalizeCodexToolResult>;
    const f = await localPreparationNativeFixture(
      cleanups,
      async () => {
        throw Error('Original capture required');
      },
      {
        nativeBaseReads: true,
        executeOriginalCapture: async (capture, _input, signal) => {
          original = capture(signal);
          try {
            seed = await materializePreparedRepositoryFixture(
              cleanups,
              f.f,
              f.a.initial,
              original.nativeTarget!,
              original,
              { physicalReadSeed: true },
            );
            normalized = normalizeCodexToolResult({
              content: JSON.stringify({
                preparationId: seed.request.id,
                directory: seed.taskIdentity.directory,
                state: 'materialized',
              }),
              isError: false,
            });
            return normalized;
          } finally {
            await Reflect.apply(original.dispose, original, []);
          }
        },
      },
    );
    const unchanged = capturePreparationPrimaryCustody(f);
    expect((await f.a.call({ path: join(f.f.root, 'source') })).response.success).toBe(true);
    unchanged(original.workspace);
    // Install call-through observers ONLY after the controlled host seed exists.
    // No physical reader, owner, scope or result is replaced/reboxed.
    const reader = readModule.capturePreparedRepositoryReader;
    vi.spyOn(readModule, 'capturePreparedRepositoryReader').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      return observer.call(
        'reader-capture',
        async () => {
          const value = await Reflect.apply(reader, this, args);
          observer.reader(value);
          return value;
        },
        { deadline: args[1].deadline },
      );
    });
    const qualified = taskModule.captureQualifiedLocalRepositoryTask;
    vi.spyOn(taskModule, 'captureQualifiedLocalRepositoryTask').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      return observer.call('qualified-task', () => Reflect.apply(qualified, this, args));
    });
    const read = LocalRepositoryReadAccess.prototype.read;
    vi.spyOn(LocalRepositoryReadAccess.prototype, 'read').mockImplementation(function (
      this: LocalRepositoryReadAccess,
      ...args
    ) {
      return observer.call('access-read', () => Reflect.apply(read, this, args));
    });
    const stat = LocalRepositoryReadAccess.prototype.stat;
    vi.spyOn(LocalRepositoryReadAccess.prototype, 'stat').mockImplementation(function (
      this: LocalRepositoryReadAccess,
      ...args
    ) {
      return observer.call('access-stat', () => Reflect.apply(stat, this, args));
    });
    const pin = LocalRepositoryReadAccess.prototype.pinRoot;
    vi.spyOn(LocalRepositoryReadAccess.prototype, 'pinRoot').mockImplementation(function (
      this: LocalRepositoryReadAccess,
      ...args
    ) {
      return observer.call('access-pin', () => Reflect.apply(pin, this, args));
    });
    const verify = LocalRepositoryReadAccess.prototype.verify;
    vi.spyOn(LocalRepositoryReadAccess.prototype, 'verify').mockImplementation(function (
      this: LocalRepositoryReadAccess,
      ...args
    ) {
      return observer.call('access-verify', () => Reflect.apply(verify, this, args));
    });
    const execute = sandbox.executeSandboxedCommand;
    vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(function (
      this: unknown,
      ...args
    ) {
      const operation = /"operation":"([A-Za-z]+)"/.exec(args[0].command)?.[1] ?? 'unknown';
      return observer.call(
        'sandbox-' + operation,
        async () => {
          const result = await Reflect.apply(execute, this, args);
          if (result.isError)
            observer.append({
              stage: 'sandbox-error-result',
              operation,
              timeoutMentioned: /timed out|timeout|deadline/i.test(result.content),
              outputSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
            });
          return result;
        },
        { timeoutMs: args[0].timeoutMs, signalAborted: args[0].signal.aborted },
      );
    });
    const source = original.nativeTarget!;
    const binding = f.a.initial.lease.binding;
    let settled = false;
    let failure: unknown;
    let failed = false;
    const git = (...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['-C', fileURLToPath(new URL('../../', import.meta.url)), ...args],
        { encoding: 'utf8' },
      ).trim();
    const before = {
      head: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      status: git('status', '--porcelain'),
    };
    const artifact = `/private/tmp/mitzo-prepared-physical-boundary-${before.head.slice(0, 9)}.json`;
    expect(before.status).toBe('');
    const sourcePaths = [
      'server/prepared-repository-transition-capture.ts',
      'server/qualified-local-repository-task.ts',
      'server/local-repository-native-read.ts',
      'server/local-repository-read-access.ts',
      'server/native-file-operation.ts',
      'server/sandboxed-command.ts',
      'server/sandboxed-command-worker.ts',
      'server/__tests__/fixtures/materialized-prepared-repository.ts',
      'server/__tests__/prepared-repository-physical-boundary.test.ts',
    ];
    const sourceIdentity = async () =>
      Object.fromEntries(
        await Promise.all(
          sourcePaths.map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(new URL('../../' + path, import.meta.url)))
              .digest('hex'),
          ]),
        ),
      );
    const sourceBefore = await sourceIdentity();
    const recordFile = await open(artifact, 'wx'); // no repeated target at the same frozen head
    let status = 'completed-tuple-pending';
    try {
      f.a.installPreparedBoundary(async (assertConversationCurrentSync) => {
        if (settled) throw Error('No repeated boundary attempt');
        try {
          expect(
            f.native.completedPreparedRepositoryResultSha256(
              f.a.sessionId,
              binding,
              source,
              original.callId,
              original.requestHash,
            ),
          ).toBe(preparedRepositoryResultSha256(normalized));
          status = 'durable-tuple-matched';
          const admission = f.a.initial.admission;
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
          const adopted = await observer.call('physical-boundary', () =>
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
          expect(adopted?.id).toBe(seed.record.id);
          status = 'primary-adopted';
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          settled = true;
        }
      });
      await f.a.complete();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 210000 }); // three independently60s physical phases plus joined owner/cleanup work
      if (failure) throw failure;
      await vi.waitFor(
        () => expect(f.a.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2),
        { timeout: 150000 }, // two fresh workspace checks precede controlled child RPC
      );
      expect(f.f.workspace.getForConversation(f.a.sessionId)?.id).toBe(seed.record.id);
      expect(f.f.events.getSession(f.a.sessionId)?.cwd).toBe(seed.taskIdentity.directory);
      expect(f.native.read(f.a.sessionId, binding).cwd).toBe(seed.taskIdentity.directory);
      const children = f.native
        .commands(f.a.sessionId, binding)
        .filter((c) => c.id !== source.commandId);
      expect(children).toHaveLength(1);
      expect(f.f.events.observePreparedRepositoryContinuation(children[0].id).state).toBe(
        'consumed',
      );
      status = 'queued-second-turn';
    } catch (error) {
      failure ??= error;
      failed = true;
    } finally {
      try {
        const after = {
          head: git('rev-parse', 'HEAD'),
          tree: git('rev-parse', 'HEAD^{tree}'),
          status: git('status', '--porcelain'),
        };
        const sourceAfter = await sourceIdentity();
        await recordFile.writeFile(
          JSON.stringify(
            {
              version: 1,
              controlledSeed: true,
              actualCreation: false,
              readerCleanupIndependentlyObserved: false, // never replace immutable original disposal
              before,
              after,
              sourceBefore,
              sourceAfter,
              status,
              error: failure ? preparationDiagnosticFailure(failure) : null,
              observation: observer.snapshot(),
            },
            null,
            2,
          ),
        );
        expect(after).toEqual(before);
        expect(sourceAfter).toEqual(sourceBefore);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      } finally {
        try {
          await recordFile.close();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
    if (failed) throw failure;
  },
  420000, // Host seed30 + three fresh phases/cleanup210 + two workspace checks/child150 + evidence30; no authority extension.
);
