import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { executeNativeLocalRepositoryPreparation } from '../native-local-repository-preparation.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { preparedRepositoryResultSha256 } from '../codex-conversation-store.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import { composeOwnedLocalNativeExecutionPolicy } from '../owned-local-codex-native-policy.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { materializePreparedRepositoryFixture } from './fixtures/materialized-prepared-repository.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import type { NativeAnchoredReadRequest } from '../native-file-operation.js';

// Genuine signed pending call, envelope, qualifier, operation, durable native
// receipt, completed-turn producer, SQLite CAS and FIFO. Authorization/decision,
// object data, task creation and descriptor transport are CONTROLLED substitutes;
// this is not actual actor/SRT/helper or production Prepare qualification.
vi.mock('../local-repository-preparation-authorization.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-authorization.js')>()),
  captureLocalRepositoryPreparationAuthorization: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  captureLocalRepositoryPreparationObjectData: vi.fn(),
}));
vi.mock('../local-repository-allocation-facts.js', async (original) => ({
  ...(await original<typeof import('../local-repository-allocation-facts.js')>()),
  captureLocalRepositoryAllocationFacts: vi.fn(),
}));
const physical = vi.hoisted(() => ({ reader: vi.fn(), creation: vi.fn() }));
vi.mock('../local-repository-native-read.js', async (original) => ({
  ...(await original<typeof import('../local-repository-native-read.js')>()),
  capturePreparedRepositoryReader: physical.reader,
  captureNativeLocalRepositoryReader: physical.reader,
}));
vi.mock('../qualified-local-repository-task.js', async (original) => ({
  ...(await original<typeof import('../qualified-local-repository-task.js')>()),
  captureQualifiedLocalRepositoryTask: physical.creation,
}));
vi.setConfig({ testTimeout: 60000 }); // Several genuine authority/physical stages, no SRT.
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

/** Explicit host fixture descriptor substitute; NEVER launches native helper. */
async function descriptor(request: NativeAnchoredReadRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const stat = await lstat(request.file_path, { bigint: true });
  expect({ dev: String(stat.dev), ino: String(stat.ino) }).toEqual(request.identity);
  if (request.operation === 'ReadBytes') {
    const bytes = await readFile(request.file_path);
    expect(bytes.length).toBeLessThanOrEqual(request.limit);
    return { content: bytes.toString('base64'), is_error: false };
  }
  if (request.operation !== 'ListDirectory') throw Error('No unexpected fixture read operation');
  const entries = await Promise.all(
    (await readdir(request.file_path)).map(async (name) => {
      const child = await lstat(join(request.file_path, name), { bigint: true });
      return {
        name,
        identity: { dev: String(child.dev), ino: String(child.ino) },
        kind: child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'unsupported',
        size: Number(child.size),
        mode: Number(child.mode),
        nlink: Number(child.nlink),
        mtimeNs: String(child.mtimeNs),
        ctimeNs: String(child.ctimeNs),
      };
    }),
  );
  signal.throwIfAborted();
  return {
    content: JSON.stringify({
      identity: request.identity,
      entries,
      incomplete: false,
      truncated: false,
    }),
    is_error: false,
  };
}

it.each([false, true])(
  'uses the ACTUAL signed callback receipt and durable hash at the completed boundary (candidate mismatch=%s)',
  async (mismatch) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls');
      }),
    );
    let original!: NativeHostToolContext;
    let candidate!: Awaited<ReturnType<typeof materializePreparedRepositoryFixture>>;
    let returned!: Awaited<ReturnType<typeof executeNativeLocalRepositoryPreparation>>;
    const packed = Object.freeze({ kind: 'absent' as const });
    const objectDispose = vi.fn(async () => {});
    const readerDispose = vi.fn(async () => {});
    const approve = vi.fn(async () => {});
    const materialize = vi.fn(async () => candidate.record.pendingHostTask!);
    physical.reader.mockImplementation(async (scope, options) => {
      const full = scope.revalidate ?? scope.assertCurrent;
      await Reflect.apply(full, scope, []);
      return {
        deadline: options.deadline,
        signal: scope.signal,
        deniedRoots: scope.deniedRoots ?? scope.nativeBaseReadScope.deniedRoots,
        assertCurrentSync: () => scope.assertCurrentSync(),
        assertReadable: async () => scope.assertCurrentSync(),
        revalidate: () => Reflect.apply(full, scope, []),
        captureReadAnchor: fixtureReadAnchor,
        executeReadOperation: descriptor,
        executeDirectoryVerification: async (
          requests: NativeAnchoredReadRequest[],
          signal: AbortSignal,
        ) => Promise.all(requests.map((request) => descriptor(request, signal))),
        dispose: readerDispose,
      };
    });
    vi.mocked(captureLocalRepositoryAllocationFacts).mockImplementation(async (_reader, intent) => {
      expect(intent.sourcePath).toBe(join(f.f.root, 'source'));
      return {
        facts: candidate.record.qualifiedLocalPreparation!.allocationFacts,
        factsSha256: candidate.record.qualifiedLocalPreparation!.allocationFactsSha256,
        publicationPackedRefs: packed,
        verify: async () => {},
      } as never;
    });
    vi.mocked(captureLocalRepositoryPreparationAuthorization).mockImplementation(
      async (owners, input) => {
        original = owners.context;
        candidate = await materializePreparedRepositoryFixture(
          cleanups,
          f.f,
          f.a.initial,
          original.nativeTarget!,
          original,
        );
        const task = structuredClone(candidate.taskIdentity);
        delete task.localSource;
        physical.creation.mockResolvedValue(task);
        const intent = Object.freeze({
          workspaceId: candidate.record.id,
          sourcePath: (input as { path: string }).path,
          taskRoot: candidate.request.taskRoot,
        });
        const source = await owners.qualifySource(intent.sourcePath, original, intent);
        expect(source.publicationPackedRefs).toBe(packed);
        expect(source.allocationFacts).toEqual(
          candidate.record.qualifiedLocalPreparation!.allocationFacts,
        );
        return {
          request: candidate.request,
          allocationFacts: source.allocationFacts,
          allocationFactsSha256: source.allocationFactsSha256,
          publicationPackedRefs: source.publicationPackedRefs,
          owner: { assertCurrent: () => original.assertCurrent() },
          approve,
          materialize,
        } as never;
      },
    );
    vi.mocked(captureLocalRepositoryPreparationObjectData).mockImplementation(
      async (context, request, _facts, _sha, deadline, witness) => {
        expect(context).toBe(original);
        expect(request).toBe(candidate.request);
        expect(witness).toBe(packed);
        expect(deadline).toBeGreaterThan(Date.now());
        return { dispose: objectDispose } as never;
      },
    );
    const f = await localPreparationNativeFixture(
      cleanups,
      async () => {
        throw Error('Raw capture required');
      },
      {
        nativeBaseReads: true,
        executeOriginalCapture: async (capture, input, signal) => {
          returned = await executeNativeLocalRepositoryPreparation(
            { capture, events: f.f.events, registry: f.registry, workspaces: f.f.workspace },
            input,
            signal,
          );
          return returned;
        },
      },
    );
    const response = await f.a.call({ path: join(f.f.root, 'source') });
    expect(response.response.success).toBe(true);
    expect(response.value).toEqual({
      preparationId: candidate.record.id,
      directory: candidate.record.pendingHostTask!.directory,
      state: 'materialized',
    });
    expect(objectDispose).toHaveBeenCalledOnce();
    expect(readerDispose).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledOnce();
    expect(() => original.assertCurrentSync()).toThrow(); // callback context expired, never reused as authority
    const expectedDigest = preparedRepositoryResultSha256(returned);
    const source = original.nativeTarget!;
    let boundaryDone = false;
    let boundarySettled = false;
    let boundaryError: unknown;
    f.a.installPreparedBoundary(async (assertConversationCurrentSync) => {
      if (boundaryDone) return;
      boundaryDone = true;
      try {
        expect(
          f.native.completedPreparedRepositoryResultSha256(
            f.a.sessionId,
            f.a.initial.lease.binding,
            source,
            original.callId,
            original.requestHash,
          ),
        ).toBe(expectedDigest);
        if (mismatch) {
          // Corrupt only the actual candidate's source tuple AFTER the successful
          // callback; planned/canned result text cannot repair this mismatch.
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(join(f.f.root, 'repositories', 'workspaces.db'));
          try {
            const row = db
              .prepare('SELECT record FROM repository_workspaces WHERE id=?')
              .get(candidate.record.id) as { record: string };
            const record = JSON.parse(row.record);
            record.pendingHostTask.request.requestHash = 'f'.repeat(64);
            db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
              JSON.stringify(record),
              candidate.record.id,
            );
          } finally {
            db.close();
          }
        }
        const admission = f.a.initial.admission;
        const selectedPolicy = () =>
          composeOwnedLocalNativeExecutionPolicy({
            session: f.a.session,
            binding: f.a.initial.lease.binding,
            assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
          });
        const owner = Object.freeze({
          signal: f.f.signal.signal,
          selectedPolicy,
          assertCurrentSync: () => admission.assertPreparedRepositoryBoundaryCurrentSync(),
        });
        const adopted = await withPreparedRepositoryBarrierReadScope(
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
        );
        if (mismatch) expect(adopted).toBeUndefined();
        else expect(adopted?.id).toBe(candidate.record.id);
      } catch (error) {
        boundaryError = error;
        throw error;
      } finally {
        boundarySettled = true;
      }
    });
    await f.a.complete();
    await vi.waitFor(() => expect(boundarySettled).toBe(true), { timeout: 30000 });
    if (!mismatch && boundaryError) throw boundaryError;
    if (mismatch) {
      expect(boundaryError).toBeDefined();
      expect(f.native.commands(f.a.sessionId, f.a.initial.lease.binding)).toHaveLength(1);
      expect(f.f.events.getSession(f.a.sessionId)?.cwd).toBe(f.a.initial.workspace.directory);
    } else {
      expect(boundaryError).toBeUndefined();
      const children = f.native
        .commands(f.a.sessionId, f.a.initial.lease.binding)
        .filter((c) => c.id !== source.commandId);
      expect(children).toHaveLength(1);
      expect(f.f.events.observePreparedRepositoryContinuation(children[0].id).state).toBe(
        'consumed',
      );
      expect(f.native.read(f.a.sessionId, f.a.initial.lease.binding).cwd).toBe(
        candidate.record.pendingHostTask!.directory,
      );
      expect(f.a.initial.lease.client).toBe(f.f.rpc);
      await vi.waitFor(
        () =>
          expect(f.a.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2),
        { timeout: 10000 },
      );
      expect(
        f.a.requests.filter((request) => request.method === 'turn/start').at(-1)?.params.cwd,
      ).toBe(candidate.record.pendingHostTask!.directory);
      expect(
        f.native.readNativeExecution(f.a.sessionId, f.a.initial.lease.binding, {
          id: source.commandId,
          attempt: source.attempt,
        })?.policy.cwd,
      ).toBe(f.a.initial.workspace.directory);
    }
  },
);
