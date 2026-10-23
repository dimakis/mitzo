import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { resolvePending } from '@mitzo/harness';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function noLiveCalls() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No model/network calls in preparation fixtures');
    }),
  );
}
function row(directory: string, id: string) {
  const db = new Database(join(directory, 'repositories', 'workspaces.db'), { readonly: true });
  try {
    const saved = db.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(id) as {
      record: string;
    };
    return JSON.parse(saved.record);
  } finally {
    db.close();
  }
}

it('fails closed without a qualified read-only source owner in an actual signed native callback', async () => {
  noLiveCalls();
  const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
    await expect(
      captureLocalRepositoryPreparationAuthorization(
        {
          context,
          registry: f.registry,
          events: f.f.events,
          workspaces: f.f.workspace,
          qualifySource: undefined as never,
        },
        input,
      ),
    ).rejects.toMatchObject({ code: 'pending_host_task_access_required' });
    return { refused: true };
  });
  const result = await f.a.call({ path: join(f.f.root, 'source') });
  expect(result.response.success).toBe(true);
  expect(result.value).toEqual({ refused: true });
  expect(f.permissions).toEqual([]);
});

it('retains actual permission evidence before outward allow and finalizes only the same existing row, without source effects', async () => {
  noLiveCalls();
  let held: Awaited<ReturnType<typeof captureLocalRepositoryPreparationAuthorization>> | undefined;
  let observedId: string | undefined;
  const effect = vi.fn();
  const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
    const source = join(f.f.root, 'source');
    const identity = (path: string) => {
      const value = lstatSync(path);
      return { dev: value.dev, ino: value.ino };
    };
    const witness = () =>
      createHash('sha256')
        .update(readFileSync(join(source, '.git', 'HEAD')))
        .update(readFileSync(join(source, '.git', 'index')))
        .update(readFileSync(join(source, 'task.txt')))
        .digest('hex');
    const originalWitness = witness();
    held = await captureLocalRepositoryPreparationAuthorization(
      {
        context,
        registry: f.registry,
        events: f.f.events,
        workspaces: service,
        qualifySource: async (path) => {
          expect(path).toBe(source);
          return {
            source: {
              path: source,
              gitDirectory: join(source, '.git'),
              commonDirectory: join(source, '.git'),
              root: identity(source),
              commonRoot: identity(join(source, '.git')),
            },
            anchorsSha256: originalWitness,
            assertCurrentSync() {
              expect(witness()).toBe(originalWitness);
            },
            async assertCurrent() {
              expect(witness()).toBe(originalWitness);
            },
          };
        },
      },
      input,
    );
    observedId = held.request.id;
    expect(row(f.f.root, observedId).pendingHostTaskDecision).toBeUndefined();
    expect(effect).not.toHaveBeenCalled();
    const finalized = await held.approve();
    expect(finalized.state).toBe('finalized');
    const saved = row(f.f.root, observedId);
    expect(saved.pendingHostTaskDecision.state).toBe('finalized');
    expect(saved.pendingHostTaskDecision.evidence.permId).toBe(f.permissions[0].permId);
    expect(saved.pendingHostTaskDecision.request.nativeTarget).toEqual(context.nativeTarget);
    expect(effect).not.toHaveBeenCalled();
    return { id: observedId, state: finalized.state };
  });
  const service = new RepositoryWorkspaces(join(f.f.root, 'repositories'), {
    assertLocalRepositoryAccess: async (path) => {
      expect(path.startsWith(f.f.root + '/')).toBe(true);
    },
    authorize: async () => {
      throw Error('No remote connection authorization');
    },
    ordinaryPreparation: {
      async capture(binding) {
        return {
          version: 1,
          originalBinding: AccountBindingSchema.parse(binding),
          runtimeBinding: SessionRuntimeBindingV2Schema.parse(
            f.f.events.getSessionRuntimeBinding(f.a.sessionId),
          ),
          credentialDigest: 'a'.repeat(64),
        };
      },
      async assert() {},
    },
  });
  cleanups.push(() => service.close());
  const retain = service.retainPendingHostTaskDecisionObservation.bind(service);
  vi.spyOn(service, 'retainPendingHostTaskDecisionObservation').mockImplementation((...args) => {
    const result = retain(...args);
    expect(row(f.f.root, args[0].id).pendingHostTaskDecision.state).toBe('observed');
    expect(f.permissionEvents.some((event) => event.type === 'permission_resolved')).toBe(false);
    return result;
  });
  const result = await f.a.call({ path: join(f.f.root, 'source') });
  expect(result.response.success).toBe(true);
  expect(result.value).toMatchObject({ id: observedId, state: 'finalized' });
  await expect(held!.approve()).rejects.toThrow();
  expect(row(f.f.root, observedId!).pendingHostTaskDecision.state).toBe('finalized');
  expect(effect).not.toHaveBeenCalled();
});

async function preparationCase(
  execute: (
    prepared: Awaited<ReturnType<typeof captureLocalRepositoryPreparationAuthorization>>,
  ) => Promise<unknown>,
) {
  noLiveCalls();
  let current = true;
  let selectedId: string | undefined;
  const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
    const source = join(f.f.root, 'source');
    const identity = (path: string) => {
      const value = lstatSync(path);
      return { dev: value.dev, ino: value.ino };
    };
    const prepared = await captureLocalRepositoryPreparationAuthorization(
      {
        context,
        registry: f.registry,
        events: f.f.events,
        workspaces: service,
        qualifySource: async () => ({
          source: {
            path: source,
            gitDirectory: join(source, '.git'),
            commonDirectory: join(source, '.git'),
            root: identity(source),
            commonRoot: identity(join(source, '.git')),
          },
          anchorsSha256: 'b'.repeat(64),
          assertCurrentSync() {
            if (!current) throw Error('Qualified fixture source revoked');
          },
          async assertCurrent() {},
        }),
      },
      input,
    );
    selectedId = prepared.request.id;
    return execute(prepared);
  });
  const service = new RepositoryWorkspaces(join(f.f.root, 'repositories'), {
    assertLocalRepositoryAccess: async (path) => {
      expect(path.startsWith(f.f.root + '/')).toBe(true);
    },
    authorize: async () => {
      throw Error('Remote fixture access prohibited');
    },
    ordinaryPreparation: {
      async capture(binding) {
        return {
          version: 1,
          originalBinding: AccountBindingSchema.parse(binding),
          runtimeBinding: SessionRuntimeBindingV2Schema.parse(
            f.f.events.getSessionRuntimeBinding(f.a.sessionId),
          ),
          credentialDigest: 'a'.repeat(64),
        };
      },
      async assert() {},
    },
  });
  cleanups.push(() => service.close());
  return {
    ...f,
    service,
    revokeSource() {
      current = false;
    },
    saved() {
      return row(f.f.root, selectedId!);
    },
    call() {
      return f.a.call({ path: join(f.f.root, 'source') });
    },
  };
}

it('checks the original qualified source fence before permission-observer metadata writes', async () => {
  const f = await preparationCase(async (prepared) => prepared.approve());
  f.setPermissionAction((event) => {
    f.revokeSource();
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  });
  expect((await f.call()).response.success).toBe(false);
  expect(f.saved().pendingHostTaskDecision).toBeUndefined();
  expect(f.saved().pendingHostTask).toBeUndefined();
});

it('does not retain approval evidence when the actual permission handler denies', async () => {
  const f = await preparationCase(async (prepared) => prepared.approve());
  f.setPermissionAction((event) => {
    resolvePending(event.permId as string, 'deny', undefined, event.sessionId as string);
  });
  expect((await f.call()).response.success).toBe(false);
  expect(f.saved().pendingHostTaskDecision).toBeUndefined();
  expect(f.saved().pendingHostTask).toBeUndefined();
});

it('consumes a finalized exact decision and retains materializing intent in the same row transaction', async () => {
  let inspected = false;
  const f = await preparationCase(async (prepared) => {
    await prepared.approve();
    const operation = f.service.beginPendingHostTaskDecisionMaterialization(
      prepared.request,
      prepared.owner,
    );
    const saved = f.saved();
    expect(saved.pendingHostTaskDecision.state).toBe('consumed');
    expect(saved.pendingHostTask.state).toBe('materializing');
    expect(saved.pendingHostTask.request).toEqual(prepared.request);
    operation.assertCurrentSync();
    operation.claim();
    expect(() => operation.claim()).toThrow();
    expect(() =>
      f.service.beginPendingHostTaskDecisionMaterialization(prepared.request, prepared.owner),
    ).toThrow();
    inspected = true;
    return { state: saved.pendingHostTask.state };
  });
  expect((await f.call()).response.success).toBe(true);
  expect(inspected).toBe(true);
  expect(f.saved().pendingHostTaskDecision.state).toBe('consumed');
  expect(f.saved().pendingHostTask.state).toBe('materializing');
});

it.each(['throw', 'promise', 'commit-then-throw'] as const)(
  'never finalizes or starts effects when approval observation returns %s',
  async (failure) => {
    const f = await preparationCase(async (prepared) => {
      await expect(prepared.approve()).rejects.toThrow();
      expect(() =>
        f.service.beginPendingHostTaskDecisionMaterialization(prepared.request, prepared.owner),
      ).toThrow();
      await expect(prepared.approve()).rejects.toThrow();
      return { refused: true };
    });
    const retain = f.service.retainPendingHostTaskDecisionObservation.bind(f.service);
    vi.spyOn(f.service, 'retainPendingHostTaskDecisionObservation').mockImplementation(
      (...args) => {
        if (failure === 'promise') return Promise.resolve(undefined) as never;
        if (failure === 'commit-then-throw') retain(...args);
        throw Error('Harmless fixture observation failure');
      },
    );
    const result = await f.call();
    expect(result.response.success).toBe(true);
    expect(result.value).toEqual({ refused: true });
    expect(f.saved().pendingHostTaskDecision?.state).toBe(
      failure === 'commit-then-throw' ? 'observed' : undefined,
    );
    expect(f.saved().pendingHostTask).toBeUndefined();
    expect(f.permissions).toHaveLength(1);
  },
  20000,
);

it('admits only one approval attempt when callers race within the original callback', async () => {
  const f = await preparationCase(async (prepared) => {
    const attempts = await Promise.allSettled([prepared.approve(), prepared.approve()]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    return { state: f.saved().pendingHostTaskDecision.state };
  });
  const result = await f.call();
  expect(result.response.success).toBe(true);
  expect(result.value).toEqual({ state: 'finalized' });
  expect(f.permissions).toHaveLength(1);
  expect(f.saved().pendingHostTask).toBeUndefined();
}, 20000);

it.each(['account', 'native-target', 'mode'] as const)(
  'refuses evidence after original %s ownership changes during actual approval',
  async (change) => {
    let originalThread!: string;
    const f = await preparationCase(async (prepared) => {
      originalThread = prepared.request.nativeTarget.threadId;
      return prepared.approve();
    });
    f.setPermissionAction((event) => {
      if (change === 'account')
        f.a.session.accountBinding = {
          ...f.a.session.accountBinding!,
          model: 'changed-fixture-model',
        };
      if (change === 'mode') f.registry.setMode(f.a.clientId, 'ask');
      if (change === 'native-target') {
        const initial = f.a.initial;
        f.native.replaceThread(
          f.a.sessionId,
          initial.lease.binding,
          originalThread,
          'replacement-fixture-thread',
          'provider_transport_failure',
        );
      }
      resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
    });
    expect((await f.call()).response.success).toBe(false);
    expect(f.saved().pendingHostTaskDecision).toBeUndefined();
    expect(f.saved().pendingHostTask).toBeUndefined();
  },
  20000,
);
