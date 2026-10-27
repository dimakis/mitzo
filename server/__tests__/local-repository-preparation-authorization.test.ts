import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { resolvePending } from '@mitzo/harness';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { fixtureQualifiedLocalPreparationSource } from './fixtures/qualified-local-preparation-source.js';
import {
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
} from '../pending-host-task.js';

const cleanups: Array<() => void | Promise<void>> = [];
vi.setConfig({ testTimeout: 30000 });
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
  let assertEffectsUnchanged!: () => void;
  let originalWorkspaceInScope: { actual: unknown; expected: unknown } | undefined;
  let qualifiedIntent: { workspaceId: string; sourcePath: string; taskRoot: string } | undefined;
  const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
    const source = join(f.f.root, 'source');
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
        qualifySource: async (path, originalContext, intent) => {
          qualifiedIntent = intent;
          expect(path).toBe(source);
          expect(originalContext).toBe(context);
          expect(intent).toEqual({
            workspaceId: expect.any(String),
            sourcePath: source,
            taskRoot: f.f.reservation.taskRoot,
            base: { kind: 'default' },
            source: { kind: 'existing', path: source },
          });
          return fixtureQualifiedLocalPreparationSource(intent, {
            assertCurrentSync() {
              expect(witness()).toBe(originalWitness);
            },
            async assertCurrent() {
              expect(witness()).toBe(originalWitness);
            },
          });
        },
      },
      input,
    );
    originalWorkspaceInScope = { actual: held.scope.oldWorkspace, expected: context.workspace };
    expect(held.scope.oldWorkspace).toEqual(context.workspace);
    expect(held.scope.allocationFactsSha256).toBe(
      row(f.f.root, held.request.id).qualifiedLocalPreparation.allocationFactsSha256,
    );
    const { referenceCoverage, ...historicalScope } = held.scope;
    expect(referenceCoverage).toBe('preparation-head-and-namespace-v1');
    expect(pendingHostTaskDecisionHash(historicalScope)).not.toBe(
      pendingHostTaskDecisionHash(held.scope),
    );
    const sourceFiles = ['.git/HEAD', '.git/index', 'task.txt'].map((name) => join(source, name));
    const sourceBytes = sourceFiles.map((path) => readFileSync(path));
    const allocationPaths = [
      held.scope.create.task.directory,
      ...Object.values(held.scope.sourceGitEffects),
    ];
    assertEffectsUnchanged = () => {
      for (const [index, path] of sourceFiles.entries())
        expect(readFileSync(path)).toEqual(sourceBytes[index]);
      for (const path of allocationPaths) expect(existsSync(path)).toBe(false);
      expect(witness()).toBe(originalWitness);
    };
    observedId = held.request.id;
    expect(row(f.f.root, observedId).pendingHostTaskDecision).toBeUndefined();
    assertEffectsUnchanged();
    const finalized = await held.approve();
    expect(finalized.state).toBe('finalized');
    const saved = row(f.f.root, observedId);
    expect(saved.pendingHostTaskDecision.state).toBe('finalized');
    expect(saved.pendingHostTaskDecision.evidence.permId).toBe(f.permissions[0].permId);
    expect(saved.pendingHostTaskDecision.request.nativeTarget).toEqual(context.nativeTarget);
    expect(saved.pendingHostTaskDecision.scope.oldWorkspace).toEqual(context.workspace);
    expect(saved.pendingHostTaskDecision.scope.referenceCoverage).toBe(
      held.scope.referenceCoverage,
    );
    assertEffectsUnchanged();
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
    assertEffectsUnchanged();
    return result;
  });
  const result = await f.a.call({ path: join(f.f.root, 'source') });
  expect(qualifiedIntent).toEqual({
    workspaceId: expect.any(String),
    sourcePath: join(f.f.root, 'source'),
    taskRoot: f.f.reservation.taskRoot,
    base: { kind: 'default' },
    source: { kind: 'existing', path: join(f.f.root, 'source') },
  });
  expect(qualifiedIntent!.workspaceId).toBe(held!.request.id);
  expect(originalWorkspaceInScope).toBeDefined();
  expect(originalWorkspaceInScope!.actual).toEqual(originalWorkspaceInScope!.expected);
  expect(result.response.success).toBe(true);
  expect(result.value).toMatchObject({ id: observedId, state: 'finalized' });
  await expect(held!.approve()).rejects.toThrow();
  expect(row(f.f.root, observedId!).pendingHostTaskDecision.state).toBe('finalized');
  assertEffectsUnchanged();
});

async function preparationCase(
  execute: (
    prepared: Awaited<ReturnType<typeof captureLocalRepositoryPreparationAuthorization>>,
  ) => Promise<unknown>,
  referenceCoverage?: 'preparation-head-and-namespace-v1',
) {
  noLiveCalls();
  let current = true;
  let selectedId: string | undefined;
  const ambientAccess = vi.fn(async () => {
    throw Error('Fixture intentionally denies ambient source access');
  });
  let qualifiedLabels: { referenceCoverage?: 'preparation-head-and-namespace-v1' } | undefined;
  const f = await localPreparationNativeFixture(cleanups, async (context, input) => {
    const prepared = await captureLocalRepositoryPreparationAuthorization(
      {
        context,
        registry: f.registry,
        events: f.f.events,
        workspaces: service,
        qualifySource: async (_path, _context, intent) => {
          const owner = await fixtureQualifiedLocalPreparationSource(intent, {
            assertCurrentSync() {
              if (!current) throw Error('Qualified fixture source revoked');
            },
            async assertCurrent() {},
          });
          if (referenceCoverage) expect(owner.referenceCoverage).toBe(referenceCoverage);
          qualifiedLabels = owner;
          return owner;
        },
      },
      input,
    );
    selectedId = prepared.request.id;
    return execute(prepared);
  });
  const service = new RepositoryWorkspaces(join(f.f.root, 'repositories'), {
    assertLocalRepositoryAccess: ambientAccess,
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
    ambientAccess,
    revokeSource() {
      current = false;
    },
    clearCoverage() {
      if (qualifiedLabels) delete qualifiedLabels.referenceCoverage;
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

it('refuses changed preparation reference coverage before retaining permission observation', async () => {
  const f = await preparationCase(
    async (prepared) => prepared.approve(),
    'preparation-head-and-namespace-v1',
  );
  f.setPermissionAction((event) => {
    f.clearCoverage();
    resolvePending(event.permId as string, 'once', undefined, event.sessionId as string);
  });
  expect((await f.call()).response.success).toBe(false);
  expect(f.saved().pendingHostTaskDecision).toBeUndefined();
});

it('refuses a changed original workspace even if directory and native correlation remain the same', async () => {
  const f = await preparationCase(async (prepared) => prepared.approve());
  let checked = false;
  const retain = f.service.retainPendingHostTaskDecisionObservation.bind(f.service);
  vi.spyOn(f.service, 'retainPendingHostTaskDecisionObservation').mockImplementation((...args) => {
    const [request, scope, evidence, owner] = args;
    const changed = structuredClone(scope);
    changed.oldWorkspace = { ...scope.oldWorkspace!, id: 'different-original-workspace' };
    const payload = pendingHostTaskDecisionPayload(request, changed);
    const before = f.saved();
    expect(() =>
      retain(
        request,
        changed,
        {
          ...evidence,
          input: payload,
          inputSha256: pendingHostTaskDecisionHash(payload),
        },
        owner,
      ),
    ).toThrow();
    expect(f.saved()).toEqual(before);
    checked = true;
    return retain(...args);
  });
  const result = await f.call();
  expect(checked).toBe(true);
  expect(result.response.success).toBe(true);
  expect(f.saved().pendingHostTaskDecision.scope.oldWorkspace.id).not.toBe(
    'different-original-workspace',
  );
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

it('expires a consumed operation at the actual approval deadline while the original signed owner is still current', async () => {
  const f = await preparationCase(async (prepared) => {
    const decision = await prepared.approve();
    const operation = f.service.beginPendingHostTaskDecisionMaterialization(
      prepared.request,
      prepared.owner,
    );
    operation.assertCurrentSync();
    const result = { ownerCurrent: false, operationCurrent: false, claimAllowed: false };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(decision.evidence.expiresAt + 1);
    try {
      // These actual controls expose which lifetime failed, outside the tool's
      // generic error envelope. Never replace or suppress the original fence.
      try {
        prepared.owner.context.assertCurrentSync();
        result.ownerCurrent = true;
      } catch {
        /* Record actual refusal. */
      }
      try {
        operation.assertCurrentSync();
        result.operationCurrent = true;
      } catch {
        /* Expected expired approval. */
      }
      try {
        operation.claim();
        result.claimAllowed = true;
      } catch {
        /* Expected expired approval. */
      }
    } finally {
      clock.mockRestore();
    }
    expect(f.saved().pendingHostTaskDecision.state).toBe('consumed');
    expect(f.saved().pendingHostTask.state).toBe('materializing');
    for (const path of [
      prepared.scope.create.task.directory,
      ...Object.values(prepared.scope.sourceGitEffects),
    ])
      expect(existsSync(path)).toBe(false);
    return result;
  });
  const result = await f.call();
  expect(result.response.success).toBe(true);
  expect(result.value).toEqual({
    ownerCurrent: true,
    operationCurrent: false,
    claimAllowed: false,
  });
}, 20000);

it.each(['missing', 'different'] as const)(
  'refuses %s allocation-facts digest before retaining original permission observation',
  async (change) => {
    const f = await preparationCase(async (prepared) => prepared.approve());
    let checked = false;
    let acceptedChangedEvidence = false;
    const retain = f.service.retainPendingHostTaskDecisionObservation.bind(f.service);
    vi.spyOn(f.service, 'retainPendingHostTaskDecisionObservation').mockImplementation(
      (...args) => {
        const [request, scope, evidence, owner] = args;
        const changed = structuredClone(scope);
        if (change === 'missing') delete changed.allocationFactsSha256;
        else changed.allocationFactsSha256 = 'f'.repeat(64);
        const payload = pendingHostTaskDecisionPayload(request, changed);
        const before = f.saved();
        try {
          retain(
            request,
            changed,
            {
              ...evidence,
              input: payload,
              inputSha256: pendingHostTaskDecisionHash(payload),
            },
            owner,
          );
          acceptedChangedEvidence = true;
        } catch {
          /* Expected persisted original-scope refusal. */
        }
        expect(f.saved()).toEqual(before);
        checked = true;
        return retain(...args);
      },
    );
    const result = await f.call();
    expect(acceptedChangedEvidence).toBe(false);
    expect(result.response.success).toBe(true);
    expect(checked).toBe(true);
    expect(f.saved().pendingHostTaskDecision.scope.allocationFactsSha256).toBe(
      f.saved().qualifiedLocalPreparation.allocationFactsSha256,
    );
  },
);

it.each(['call', 'target', 'request-hash', 'qualified-facts'] as const)(
  'binds metadata observation to the stored original %s before any receipt exists',
  async (change) => {
    const f = await preparationCase(async (prepared) => prepared.approve());
    let checked = false;
    let acceptedChangedEvidence = false;
    const retain = f.service.retainPendingHostTaskDecisionObservation.bind(f.service);
    vi.spyOn(f.service, 'retainPendingHostTaskDecisionObservation').mockImplementation(
      (...args) => {
        const [request, scope, evidence, owner] = args;
        const db = new Database(join(f.f.root, 'repositories', 'workspaces.db'));
        const before = f.saved();
        expect(before.pendingHostTask).toBeUndefined();
        const altered = structuredClone(before);
        if (change === 'call')
          altered.qualifiedLocalPreparation.request.prepareCallId = 'other-call';
        if (change === 'target')
          altered.qualifiedLocalPreparation.request.nativeTarget.turnId = 'other-turn';
        if (change === 'request-hash')
          altered.qualifiedLocalPreparation.request.requestHash = 'f'.repeat(64);
        if (change === 'qualified-facts') delete altered.qualifiedLocalPreparation;
        // This metadata-only API control retains the actual native context and its
        // live fences. It conveys no source-read or effect authority. In contrast
        // to the production producer, its fence does not inspect the pending row,
        // so the persisted-request check itself must reject the substituted row.
        const nativeMetadataOwner = Object.freeze({
          context: owner.context,
          assertCurrentSync() {
            owner.context.assertCurrentSync();
          },
          async assertCurrent() {
            await owner.context.assertCurrent();
          },
        });
        try {
          db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
            JSON.stringify(altered),
            request.id,
          );
          nativeMetadataOwner.assertCurrentSync();
          try {
            retain(request, scope, evidence, nativeMetadataOwner);
            acceptedChangedEvidence = true;
          } catch {
            /* Expected persisted original-request refusal. */
          }
          expect(f.saved()).toEqual(altered);
          checked = true;
        } finally {
          db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
            JSON.stringify(before),
            request.id,
          );
          db.close();
        }
        return retain(...args);
      },
    );
    const result = await f.call();
    expect(acceptedChangedEvidence).toBe(false);
    expect(result.response.success).toBe(true);
    expect(checked).toBe(true);
    expect(f.saved().pendingHostTaskDecision.request).toEqual(
      f.saved().qualifiedLocalPreparation.request,
    );
  },
);
