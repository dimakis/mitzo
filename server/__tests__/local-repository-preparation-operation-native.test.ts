import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { resolvePending } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import * as reads from '../local-repository-native-read.js';
import * as objects from '../local-repository-preparation-objects.js';
import * as data from '../local-repository-preparation-object-data.js';
import * as authorization from '../local-repository-preparation-authorization.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import { executeLocalRepositoryPreparation } from '../local-repository-preparation-operation.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function sanitized(error: unknown) {
  const allowed = [
    'Prepared private object data unavailable',
    'Preparation objects unavailable',
    'Original preparation owner unavailable',
    'pending_host_task_authority_required',
    'pending_host_task_ownership_changed',
    'pending_host_task_uncertain',
    'Preparation deadline exceeded',
  ];
  return error instanceof Error && allowed.includes(error.message)
    ? error.message
    : 'unclassified-error';
}
it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'copies verified objects through the genuine pending READ owner, closes readers before denial, and joins scratch cleanup with no source effects',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No model/live/network calls');
      }),
    );
    const started = Date.now();
    const phases: Array<{ phase: string; atMs: number; remainingMs?: number; error?: string }> = [];
    const phase = (name: string, remainingMs?: number, error?: string) => {
      if (phases.length < 64)
        phases.push({ phase: name, atMs: Date.now() - started, remainingMs, error });
    };
    const returnedReaders: Array<
      Awaited<ReturnType<typeof reads.captureNativeLocalRepositoryReader>>
    > = [];
    const read = reads.captureNativeLocalRepositoryReader;
    vi.spyOn(reads, 'captureNativeLocalRepositoryReader').mockImplementation(async (...args) => {
      phase('reader-start', args[1].deadline - Date.now());
      try {
        const reader = await read(...args);
        returnedReaders.push(reader);
        phase('reader-return', reader.deadline - Date.now());
        return reader;
      } catch (error) {
        phase('reader-error', undefined, sanitized(error));
        throw error;
      }
    });
    let scratch = '',
      copied = false,
      dataReturned = false,
      actualDeny = false;
    let operationError = '',
      dataError = '',
      envelopeDeadline = 0;
    const rm = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rm;
    const removed = { reader: 0, objects: 0 };
    const cleanupErrors: string[] = [];
    vi.mocked(fs.rm).mockImplementation(async (...args) => {
      const name = typeof args[0] === 'string' ? basename(args[0]) : '';
      const kind = name.startsWith('mitzo-native-read-')
        ? 'reader'
        : name.startsWith('mitzo-preparation-objects-')
          ? 'objects'
          : undefined;
      try {
        await Reflect.apply(rm, fs, args);
        if (kind) {
          removed[kind]++;
          phase(`${kind}-cleanup-complete`);
        }
      } catch (error) {
        if (kind) {
          cleanupErrors.push(kind + ':' + sanitized(error));
          phase(`${kind}-cleanup-error`, undefined, sanitized(error));
        }
        throw error;
      }
    });
    const copy = objects.captureLocalRepositoryPreparationObjects;
    vi.spyOn(objects, 'captureLocalRepositoryPreparationObjects').mockImplementation(
      async (...args) => {
        phase('object-copy-start', args[1].timeoutMs);
        try {
          const artifact = await copy(...args);
          scratch = artifact.view.scratch;
          copied = true;
          phase('object-copy-return', returnedReaders.at(-1)!.deadline - Date.now());
          return artifact;
        } catch (error) {
          phase('object-copy-error', undefined, sanitized(error));
          throw error;
        }
      },
    );
    const captureData = data.captureLocalRepositoryPreparationObjectData;
    vi.spyOn(data, 'captureLocalRepositoryPreparationObjectData').mockImplementation(
      async (...args) => {
        phase('object-data-start', args[4] - Date.now());
        try {
          const value = await captureData(...args);
          dataReturned = true;
          phase('object-data-return', args[4] - Date.now());
          return value;
        } catch (error) {
          dataError = sanitized(error);
          phase('object-data-error', args[4] - Date.now(), dataError);
          throw error;
        }
      },
    );
    let retained:
      | Awaited<ReturnType<typeof authorization.captureLocalRepositoryPreparationAuthorization>>
      | undefined;
    const capture = authorization.captureLocalRepositoryPreparationAuthorization;
    vi.spyOn(authorization, 'captureLocalRepositoryPreparationAuthorization').mockImplementation(
      async (...args) => {
        phase('authorization-start');
        try {
          const held = await capture(...args);
          retained = held;
          phase('authorization-return');
          return held;
        } catch (error) {
          phase('authorization-error', undefined, sanitized(error));
          throw error;
        }
      },
    );
    const f = await localPreparationNativeFixture(
      cleanups,
      async (context, input, envelope) => {
        if (!envelope) throw Error('Preparation envelope missing');
        envelopeDeadline = envelope.deadline;
        phase('callback-start', envelope.deadline - Date.now());
        try {
          return await executeLocalRepositoryPreparation(
            {
              context,
              events: f.f.events,
              registry: f.registry,
              workspaces: f.f.workspace,
              qualifySource: (_path, original, intent, options) =>
                captureNativeLocalRepositoryPreparationSource(original, intent, options),
            },
            input,
            envelope,
          );
        } catch (error) {
          operationError = sanitized(error);
          phase('operation-error', envelope.deadline - Date.now(), operationError);
          throw error;
        } finally {
          phase('callback-finally', envelope.deadline - Date.now());
        }
      },
      { nativeBaseReads: true, preparationEnvelope: true },
    );
    const source = join(f.f.root, 'source');
    await fs.writeFile(join(source, 'task.txt'), 'DIRTY SOURCE\n');
    await fs.writeFile(join(source, 'staged.txt'), 'STAGED KEEP\n');
    await fs.writeFile(join(source, 'untracked.txt'), 'UNTRACKED KEEP\n');
    execFileSync(
      '/usr/bin/git',
      ['-C', source, '-c', 'core.hooksPath=/dev/null', 'add', 'staged.txt'],
      {
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    );
    const names = ['.git/HEAD', '.git/index', 'task.txt', 'staged.txt', 'untracked.txt'];
    const before = await Promise.all(names.map((name) => fs.readFile(join(source, name))));
    let copiedAtApproval = false,
      scratchAtApproval = false;
    let readersClosedAtApproval = false;
    f.setPermissionAction((event) => {
      phase('approval-reached', envelopeDeadline - Date.now());
      copiedAtApproval = copied;
      scratchAtApproval = !!scratch && existsSync(scratch);
      readersClosedAtApproval =
        returnedReaders.length > 0 &&
        returnedReaders.every((reader) => {
          try {
            reader.assertCurrentSync!();
            return false;
          } catch {
            return true;
          }
        });
      actualDeny = resolvePending(
        event.permId as string,
        'deny',
        undefined,
        event.sessionId as string,
      );
      phase('actual-deny', envelopeDeadline - Date.now());
    });
    let result: Awaited<ReturnType<typeof f.a.call>> | undefined;
    try {
      // The denial journey reads this deliberately modified local fixture snapshot.
      result = await f.a.call({ path: source, base: { kind: 'ref', ref: 'HEAD' } });
    } finally {
      // No assertions in the callback or before this unconditional bounded record.
      // It contains no source contents, identities, paths or credential material.
      await fs.writeFile(
        '/private/tmp/mitzo-preparation-operation-native-denial-record.json',
        JSON.stringify(
          {
            version: 1,
            phases,
            operationError,
            dataError,
            copied,
            dataReturned,
            actualDeny,
            approvalReached: f.permissions.length > 0,
            permissionCount: f.permissions.length,
            copiedAtApproval,
            scratchAtApproval,
            readersClosedAtApproval,
            cleanupErrors,
            readerCleanupCompleted: removed.reader,
            objectScratchCleanupCompleted: removed.objects,
            scratchExists: !!scratch && existsSync(scratch),
            envelopeRemainingMs: envelopeDeadline - Date.now(),
            readers: returnedReaders.map((reader) => ({
              remainingMs: reader.deadline - Date.now(),
              aborted: reader.signal?.aborted === true,
            })),
          },
          null,
          2,
        ),
      );
    }
    expect(actualDeny, JSON.stringify({ operationError, dataError, phases })).toBe(true);
    expect(f.permissions).toHaveLength(1);
    expect(operationError).toBe('pending_host_task_authority_required');
    expect(result!.response.success).toBe(false);
    expect(dataReturned).toBe(true);
    expect(copiedAtApproval).toBe(true);
    expect(scratchAtApproval).toBe(true);
    expect(readersClosedAtApproval).toBe(true);
    expect(cleanupErrors).toEqual([]);
    expect(removed.reader).toBe(returnedReaders.length);
    expect(removed.objects).toBe(1);
    expect(existsSync(scratch)).toBe(false);
    expect(await Promise.all(names.map((name) => fs.readFile(join(source, name))))).toEqual(before);
    expect(retained).toBeDefined();
    for (const target of [
      retained!.scope.create.task.directory,
      retained!.scope.sourceGitEffects.administrationDirectory,
      retained!.scope.sourceGitEffects.branchReference,
      retained!.scope.sourceGitEffects.branchLog,
    ])
      expect(existsSync(target)).toBe(false);
    const row = f.f.workspace.get(retained!.request.id);
    expect(row.state).toBe('ready');
    expect(row.qualifiedLocalPreparation?.publication).toBeUndefined();
    expect(row.hostReservation).toBeUndefined();
  },
  180000,
);
