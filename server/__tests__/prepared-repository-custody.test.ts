import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RepositoryWorkspaces, type RepositoryWorkspace } from '../repository-workspaces.js';
import { snapshotRepositoryTaskCheckout } from '../repository-task-checkout.js';
import { contextDigest } from '../agent-context-compiler.js';
import {
  freezePendingHostTaskData,
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
  PendingHostTaskDecisionSchema,
  PendingHostTaskDecisionScopeSchema,
} from '../pending-host-task.js';
import type { PreparedRepositoryTransitionFacts } from '../prepared-repository-transition.js';
vi.setConfig({ testTimeout: 20000 }); // Match the existing real local Git custody fixtures.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
});
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline custody',
  provider: 'openai-codex' as const,
  profileRevision: 'profile',
  model: 'fixture',
};
const runtime = {
  version: 2 as const,
  account: {
    accountId: binding.accountId,
    provider: binding.provider,
    profileRevision: binding.profileRevision,
  },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
};
const selection = {
  runOn: 'local' as const,
  runtime: { account: runtime.account, harness: 'codex' as const, targetId: 'mac' },
};
const signal = () => AbortSignal.timeout(30000);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
async function fixture(kind: 'ordinary' | 'repository' = 'repository') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-repository-custody-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const taskRoot = join(root, 'tasks'),
    source = join(root, 'source');
  mkdirSync(taskRoot, { mode: 0o700 });
  git(root, 'init', '--template=', '-q', '-b', 'main', source);
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'task.txt'), 'Accepted source');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'base');
  const deps = {
    authorize: vi.fn(async () => {
      throw Error('No remote access');
    }),
    assertLocalRepositoryAccess: vi.fn(async () => {}),
    ordinaryPreparation: {
      capture: vi.fn(async () => ({
        version: 1 as const,
        originalBinding: binding,
        runtimeBinding: runtime,
        credentialDigest: 'a'.repeat(64),
      })),
      assert: vi.fn(async () => {}),
    },
  };
  const service = new RepositoryWorkspaces(join(root, 'private'), deps);
  cleanups.push(() => service.close());
  const db = new Database(join(root, 'private', 'workspaces.db'));
  cleanups.push(() => db.close());
  const raw = (id: string) =>
    db.prepare('SELECT record,conversation_id FROM repository_workspaces WHERE id=?').get(id) as {
      record: string;
      conversation_id: string | null;
    };
  let conversationId = 'conversation';
  let old: PreparedRepositoryTransitionFacts['oldWorkspace'];
  if (kind === 'repository') {
    const ready = await service.selectExistingLocalRepository(binding, source, selection, signal());
    const reservation = {
      id: ready.id,
      binding,
      conversationId,
      taskRoot,
      runtimeBinding: runtime,
      commandFingerprint: 'e'.repeat(64),
      signal: signal(),
    };
    await service.reserveHostTask(reservation);
    const claimed = await service.claimReservedHostTask(reservation);
    old = { kind, id: claimed.id, directory: claimed.directory! };
  } else {
    const prepared = await service.prepareOrdinaryWorkspace({
      binding,
      selection,
      signal: signal(),
    });
    const definition = {
      name: 'Agent',
      descriptor: 'Offline',
      role: 'agent' as const,
      instructions: 'Retain task',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Keep custody'],
      modelPolicyRole: 'agent' as const,
    };
    const record = await service.reserveOrdinaryWorkspace({
      preparationId: prepared.preparationId,
      allocationOperationId: randomUUID(),
      binding,
      taskRoot,
      signal: signal(),
      settings: {
        version: 2,
        binding: runtime,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        selection: {
          version: 1,
          agent: { profileId: 'agent', revision: 1 },
          context: { source: 'none', revision: null },
          permission: { mode: 'agent', revision: 0 },
          model: binding.model,
          thinking: null,
        },
      },
      agentProfile: {
        profileId: 'agent',
        revision: 1,
        definition,
        contentHash: contextDigest(definition),
      },
    });
    conversationId = record.conversationId;
    const claimed = await service.claimOrdinaryWorkspace({
      id: record.id,
      binding,
      conversationId,
      taskRoot,
      signal: signal(),
    });
    old = { kind, id: claimed.id, directory: claimed.directory };
  }
  writeFileSync(join(old.directory, 'dirty.txt'), 'Unfinished original task');
  async function pending(oldWorkspace = old) {
    const ready = await service.selectExistingLocalRepository(binding, source, selection, signal());
    const request = {
      id: ready.id,
      binding,
      conversationId,
      runtimeId: 'runtime',
      runtimeBinding: runtime,
      nativeTarget: {
        commandId: 'source-command',
        attempt: 1,
        threadId: 'thread',
        turnId: 'turn',
        generation: 0,
      },
      prepareCallId: 'prepare-call',
      requestHash: 'b'.repeat(64),
      taskRoot,
    };
    // SQL custody fixture: construct historical materialization explicitly. The
    // removed ambient pending producer was never a production caller; active
    // transition/CAS tests must not depend on an alternative creation owner.
    const record = service.get(ready.id);
    const directory = join(taskRoot, `repo-${ready.id}`);
    git(source, 'worktree', 'add', '-qb', record.featureBranch, directory, record.baseOid);
    const root = lstatSync(taskRoot);
    const receipt = {
      version: 1 as const,
      request,
      rootIdentity: { dev: root.dev, ino: root.ino },
      directory,
      sourceDigest: record.sourceDigest!,
      state: 'materialized' as const,
      taskIdentity: await snapshotRepositoryTaskCheckout(
        directory,
        record.featureBranch,
        record.localSource,
      ),
    };
    record.pendingHostTask = receipt;
    const effect = {
      kind: 'local-repository-worktree' as const,
      workspaceId: ready.id,
      featureBranch: record.featureBranch,
      baseOid: record.baseOid,
      source: {
        path: source,
        gitDirectory: join(source, '.git'),
        commonDirectory: record.localSource!.commonDirectory,
      },
      task: { taskRoot, directory: receipt.directory, adminBasename: `repo-${ready.id}` },
    };
    const scope = PendingHostTaskDecisionScopeSchema.parse({
      version: 1 as const,
      oldWorkspace,
      create: { ...effect, intent: 'create' as const },
      use: { ...effect, intent: 'use' as const },
      sourceIdentity: record.localSource!,
      taskRootIdentity: receipt.rootIdentity,
      sourceDigest: receipt.sourceDigest,
      anchorsSha256: 'c'.repeat(64),
      sourceGitEffects: {
        administrationDirectory: receipt.taskIdentity!.linkedGit!.directory,
        branchReference: join(source, '.git', 'refs', 'heads', record.featureBranch),
        branchReferenceLock: join(source, '.git', 'refs', 'heads', record.featureBranch) + '.lock',
        branchLog: join(source, '.git', 'logs', 'refs', 'heads', record.featureBranch),
      },
    });
    // SQL-unit evidence only. The production producer still must prove current
    // signed read/write authority; a persisted decision is never that grant.
    const payload = pendingHostTaskDecisionPayload(request, scope);
    record.pendingHostTaskDecision = PendingHostTaskDecisionSchema.parse({
      version: 1,
      request,
      scope,
      scopeSha256: pendingHostTaskDecisionHash(scope),
      evidence: {
        permId: 'fixture-permission',
        toolUseID: request.prepareCallId,
        sessionId: conversationId,
        toolName: 'PrepareLocalRepository',
        input: payload,
        inputSha256: pendingHostTaskDecisionHash(payload),
        approvalScope: 'request',
        decisionClassification: 'user_temporary',
        expiresAt: Date.now() + 30000,
      },
      state: 'consumed',
    });
    db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
      JSON.stringify(record),
      record.id,
    );
    const facts = freezePendingHostTaskData({
      version: 'prepared-repository-transition-v1' as const,
      request,
      oldWorkspace,
      newWorkspace: {
        kind: 'repository' as const,
        id: record.id,
        directory: receipt.directory,
        featureBranch: record.featureBranch,
        baseOid: record.baseOid,
        taskIdentity: receipt.taskIdentity!,
      },
      consumedScopeSha256: record.pendingHostTaskDecision.scopeSha256,
      materializedRecordSha256: pendingHostTaskDecisionHash(record),
      resultSha256: 'd'.repeat(64),
    });
    const sourceIdentity = {
      ...request.nativeTarget,
      callId: request.prepareCallId,
      requestHash: request.requestHash,
      resultSha256: facts.resultSha256,
    };
    const childId = `prepared-repository-${pendingHostTaskDecisionHash([conversationId, request.id, sourceIdentity])}`;
    return { facts, childId, record, before: raw(record.id) };
  }
  return { service, deps, db, raw, old, root, source, taskRoot, conversationId, pending };
}

it('reuses only immutable transition projections while rechecking the current adopted ledger', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const record = f.service.get(p.record.id);
  const materialized = record.preparedRepositoryTransitionAdoption!.materializedRecord;
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const parse = vi.spyOn(JSON, 'parse');
  const current = vi.spyOn(f.service, 'getForConversation');
  const reservation = vi.spyOn(f.service, 'getHostReservation');
  const samples = 500;
  const started = performance.now();
  for (let index = 0; index < samples; index++)
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const elapsedMs = performance.now() - started;
  const immutableClones = clone.mock.calls.filter(([value]) => value === p.facts).length;
  const immutableParses = parse.mock.calls.filter(([value]) => value === materialized).length;
  if (process.env.MITZO_CUSTODY_COST_BENCHMARK === '1')
    process.stdout.write(
      JSON.stringify({ samples, elapsedMs, immutableClones, immutableParses }) + '\n',
    );
  expect(current).toHaveBeenCalledTimes(samples);
  expect(reservation).toHaveBeenCalledTimes(samples);
  expect(immutableClones).toBe(0);
  expect(immutableParses).toBe(0);
  clone.mockRestore();
  parse.mockRestore();
  current.mockRestore();
  reservation.mockRestore();
  if (process.env.MITZO_CUSTODY_COST_BENCHMARK === '1') {
    const { SynchronousStageProfiler, installSignedNativeReadStages, NativeReadBoundaryProfile } =
      await import('./fixtures/synchronous-stage-profiler.js');
    const raw: number[] = [],
      instrumented: number[] = [];
    for (let round = 0; round < 3; round++) {
      const before = performance.now();
      for (let index = 0; index < samples; index++)
        f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
      raw.push(performance.now() - before);
      const profiler = new SynchronousStageProfiler();
      const restore = installSignedNativeReadStages(profiler, new NativeReadBoundaryProfile());
      try {
        const before = performance.now();
        for (let index = 0; index < samples; index++)
          f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
        instrumented.push(performance.now() - before);
        expect(profiler.snapshot().stages['repository.adopted'].calls).toBe(samples);
      } finally {
        restore();
      }
    }
    process.stdout.write(JSON.stringify({ samples, raw, instrumented }) + '\n');
  }
  const changedBytes = materialized + '\n';
  const changedParse = vi.spyOn(JSON, 'parse');
  record.preparedRepositoryTransitionAdoption!.materializedRecord = changedBytes;
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(record), record.id);
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  expect(changedParse.mock.calls.filter(([value]) => value === changedBytes)).toHaveLength(1);
  // Only the latest successful byte projection is retained per facts owner.
  record.preparedRepositoryTransitionAdoption!.materializedRecord = materialized;
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(record), record.id);
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  expect(changedParse.mock.calls.filter(([value]) => value === materialized)).toHaveLength(1);
  changedParse.mockRestore();
  // The projection must never stand in for the fresh current custody witness.
  record.pendingHostTaskDecision!.evidence.input = { changed: 'current evidence changed' };
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(record), record.id);
  expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
});

it('reuses only a private readonly decode while every SQL read and mutable result stays fresh', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const bytes = f.raw(p.record.id).record;
  const parse = vi.spyOn(JSON, 'parse');
  const statementPrototype = Object.getPrototypeOf(f.db.prepare('SELECT 1')) as Database.Statement;
  const gets = vi.spyOn(statementPrototype, 'get');
  for (let index = 0; index < 3; index++)
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  expect(
    gets.mock.contexts.filter(
      (statement) =>
        (statement as Database.Statement).source ===
        'SELECT record, conversation_id FROM repository_workspaces WHERE id=?',
    ),
  ).toHaveLength(9);
  // Only getForConversation returns a fresh mutable row on each assertion.
  expect(parse.mock.calls.filter(([value]) => value === bytes)).toHaveLength(3);
  parse.mockRestore();
  gets.mockRestore();
  const expected = {
    id: p.record.id,
    binding,
    conversationId: f.conversationId,
    taskRoot: f.taskRoot,
    runtimeBinding: runtime,
  };
  const descriptor = f.service.getHostReservation(expected);
  const original = structuredClone(descriptor);
  expect(Object.isFrozen(descriptor.binding)).toBe(false);
  expect(Object.isFrozen(descriptor.hostReservation.rootIdentity)).toBe(false);
  descriptor.binding.accountId = 'caller mutation';
  descriptor.hostReservation.rootIdentity.ino++;
  expect(f.service.getHostReservation(expected)).toEqual(original);
  const publicRow = f.service.get(p.record.id);
  const primary = f.service.getForConversation(f.conversationId)!;
  expect(publicRow).not.toBe(primary);
  expect(publicRow.binding).not.toBe(primary.binding);
  expect(Object.isFrozen(publicRow.binding)).toBe(false);
  expect(Object.isFrozen(primary.binding)).toBe(false);
  publicRow.binding.accountId = 'public caller mutation';
  primary.hostReservation!.rootIdentity.ino++;
  expect(f.service.get(p.record.id).binding).toEqual(binding);
  expect(f.service.getForConversation(f.conversationId)!.hostReservation!.rootIdentity).toEqual(
    original.hostReservation.rootIdentity,
  );
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
  ).not.toThrow();
});

it('keeps one readonly decode per store while fresh SQL identities, changes and failures remain current', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  const expected = {
    id: p.record.id,
    binding,
    conversationId: f.conversationId,
    taskRoot: f.taskRoot,
    runtimeBinding: runtime,
  };
  const original = f.raw(p.record.id);
  f.service.getHostReservation(expected);
  const second = new RepositoryWorkspaces(join(f.root, 'private'), f.deps);
  cleanups.push(() => second.close());
  const parse = vi.spyOn(JSON, 'parse');
  second.getHostReservation(expected);
  f.service.getHostReservation(expected);
  expect(parse.mock.calls.filter(([value]) => value === original.record)).toHaveLength(1);
  const changed = JSON.parse(original.record) as RepositoryWorkspace;
  Object.defineProperty(changed, '__proto__', { value: { retained: true }, enumerable: true });
  const changedBytes = JSON.stringify(changed);
  const write = (bytes: string | Buffer) =>
    f.db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(bytes, p.record.id);
  write(changedBytes);
  f.service.getHostReservation(expected);
  f.service.getHostReservation(expected);
  expect(parse.mock.calls.filter(([value]) => value === changedBytes)).toHaveLength(1);
  write(original.record);
  parse.mockClear();
  f.service.getHostReservation(expected);
  expect(parse.mock.calls.filter(([value]) => value === original.record)).toHaveLength(1);
  f.db.prepare('UPDATE repository_workspaces SET conversation_id=NULL WHERE id=?').run(p.record.id);
  expect(() => f.service.getHostReservation(expected)).toThrow('ledger identity changed');
  f.db
    .prepare('UPDATE repository_workspaces SET conversation_id=? WHERE id=?')
    .run(original.conversation_id, p.record.id);
  const wrongId = { ...changed, id: 'different-ledger-id' };
  write(JSON.stringify(wrongId));
  expect(() => f.service.getHostReservation(expected)).toThrow('ledger identity changed');
  write('{malformed');
  for (let attempt = 0; attempt < 2; attempt++)
    expect(() => f.service.getHostReservation(expected)).toThrow();
  write(original.record);
  expect(() => f.service.getHostReservation(expected)).not.toThrow();
  f.db.prepare('DELETE FROM repository_workspaces WHERE id=?').run(p.record.id);
  expect(() => f.service.getHostReservation(expected)).toThrow('reservation unavailable');
  f.db
    .prepare('INSERT INTO repository_workspaces(id,record,conversation_id) VALUES(?,?,?)')
    .run(p.record.id, original.record, original.conversation_id);
  expect(() => f.service.getHostReservation(expected)).not.toThrow();
});

it('falls back to uncached original decoding for oversized, deep, object-heavy and nonstring SQL data', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  const expected = {
    id: p.record.id,
    binding,
    conversationId: f.conversationId,
    taskRoot: f.taskRoot,
    runtimeBinding: runtime,
  };
  f.service.getHostReservation(expected);
  const original = f.raw(p.record.id).record;
  let deep: unknown = {};
  for (let index = 0; index < 40; index++) deep = { child: deep };
  const variants: Array<string | Buffer> = [
    JSON.stringify({ ...JSON.parse(original), retained: 'é'.repeat(131073) }),
    JSON.stringify({ ...JSON.parse(original), retained: deep }),
    JSON.stringify({ ...JSON.parse(original), retained: Array.from({ length: 4096 }, () => ({})) }),
    Buffer.from(original),
  ];
  const parse = vi.spyOn(JSON, 'parse');
  for (const bytes of variants) {
    f.db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(bytes, p.record.id);
    parse.mockClear();
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => f.service.getHostReservation(expected)).not.toThrow();
    expect(
      parse.mock.calls.filter(([value]) =>
        Buffer.isBuffer(bytes) ? Buffer.isBuffer(value) : value === bytes,
      ),
    ).toHaveLength(2);
  }
});

it('validates each fresh adopted marker without rebuilding equal immutable facts', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const stringify = vi.spyOn(JSON, 'stringify');
  const current = vi.spyOn(f.service, 'getForConversation');
  const reservation = vi.spyOn(f.service, 'getHostReservation');
  for (let index = 0; index < 3; index++)
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const rebuiltFacts = stringify.mock.calls.filter(
    ([value]) => value?.version === 'prepared-repository-transition-v1',
  );
  expect(current).toHaveBeenCalledTimes(3);
  expect(reservation).toHaveBeenCalledTimes(3);
  expect(rebuiltFacts).toHaveLength(0);
});

it('retains full fresh marker validation after warming equal adoption facts', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const original = JSON.parse(f.raw(p.record.id).record) as RepositoryWorkspace;
  const write = (record: RepositoryWorkspace) =>
    f.db
      .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
      .run(JSON.stringify(record), record.id);
  type Marker = NonNullable<RepositoryWorkspace['preparedRepositoryTransitionAdoption']>;
  const mutations: Array<(marker: Marker) => void> = [
    (marker) => {
      Object.assign(marker, { facts: null });
    },
    (marker) => {
      Reflect.deleteProperty(marker, 'facts');
    },
    (marker) => {
      Object.assign(marker, { facts: [] });
    },
    (marker) => {
      Object.assign(marker.facts, { unknown: true });
    },
    (marker) => {
      Object.assign(marker.facts.newWorkspace.taskIdentity.root, { ino: 'wrong-type' });
    },
    (marker) => {
      marker.facts.oldWorkspace.directory = '/canonical/../different';
    },
    (marker) => {
      marker.facts.oldWorkspace.directory = '/' + 'x'.repeat(65536);
    },
    (marker) => {
      Object.assign(marker, { unknown: true });
    },
    (marker) => {
      Object.assign(marker, { version: '1' });
    },
    (marker) => {
      marker.factsSha256 = 'invalid';
    },
    (marker) => {
      marker.childCommandId = 'different';
    },
    (marker) => {
      marker.materializedRecord = 'é'.repeat(131073);
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed.preparedRepositoryTransitionAdoption!);
    write(changed);
    expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
    write(original);
    expect(() =>
      f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
    ).not.toThrow();
  }
});

it.each(['ordinary', 'repository'] as const)(
  'atomically adopts %s→repository while retaining dirty old task and historical ownership',
  async (kind) => {
    const f = await fixture(kind),
      p = await f.pending();
    const oldBefore =
      kind === 'repository' ? f.service.get(f.old.id) : f.service.getOrdinaryWorkspace(f.old.id);
    const guard = vi.fn(() => {});
    f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, guard);
    expect(guard).toHaveBeenCalledOnce();
    expect(f.service.getForConversation(f.conversationId)?.id).toBe(p.facts.newWorkspace.id);
    expect(() =>
      f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
    ).not.toThrow();
    expect(
      f.service.getHostReservation({
        id: p.record.id,
        binding,
        conversationId: f.conversationId,
        taskRoot: f.taskRoot,
        runtimeBinding: runtime,
      }),
    ).toMatchObject({ state: 'claimed', directory: p.facts.newWorkspace.directory });
    expect(readFileSync(join(f.old.directory, 'dirty.txt'), 'utf8')).toBe(
      'Unfinished original task',
    );
    if (kind === 'repository') {
      const retained = f.service.get(f.old.id);
      expect(retained).toMatchObject({
        conversationId: f.conversationId,
        state: oldBefore.state,
        directory: f.old.directory,
      });
      expect(retained.taskIdentity).toEqual((oldBefore as RepositoryWorkspace).taskIdentity);
      expect(f.raw(f.old.id).conversation_id).toBeNull();
      expect(() =>
        f.service.getHostReservation({
          id: f.old.id,
          binding,
          conversationId: f.conversationId,
          taskRoot: f.taskRoot,
        }),
      ).toThrow();
    }
    expect(() => f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, guard)).toThrow();
    expect(guard).toHaveBeenCalledOnce();
  },
);

it('retires ordinary current custody durably and refuses stale reacquisition while retaining history', async () => {
  const f = await fixture('ordinary'),
    p = await f.pending();
  const original = f.service.getOrdinaryWorkspace(f.old.id);
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  expect(f.service.getOrdinaryWorkspaceForConversation(f.conversationId)).toBeUndefined();
  const persisted = f.db
    .prepare('SELECT conversation_id,record FROM ordinary_workspaces WHERE id=?')
    .get(original.id) as { conversation_id: string | null; record: string };
  expect(persisted.conversation_id).toBeNull();
  expect(JSON.parse(persisted.record)).toMatchObject({
    conversationId: f.conversationId,
    directory: f.old.directory,
    state: 'claimed',
    primaryDisposition: { version: 1, revision: 1, currentConversationId: null },
  });
  const reopened = new RepositoryWorkspaces(join(f.root, 'private'), f.deps);
  cleanups.push(() => reopened.close());
  expect(reopened.getOrdinaryWorkspaceForConversation(f.conversationId)).toBeUndefined();
  expect(reopened.getOrdinaryWorkspace(f.old.id).taskIdentity).toEqual(original.taskIdentity);
  const claim = {
    id: original.id,
    conversationId: f.conversationId,
    binding,
    taskRoot: f.taskRoot,
    signal: signal(),
  };
  await expect(reopened.claimOrdinaryWorkspace(claim)).rejects.toThrow();
  await expect(reopened.revalidateOrdinaryWorkspace(claim)).rejects.toThrow();
  expect(() => reopened.validateRetainedOrdinaryWorkspace(f.conversationId)).toThrow();
  expect(() => reopened.validateOrdinaryWorkspace(f.conversationId, f.old.directory)).toThrow();
  await expect(
    reopened.reserveOrdinaryWorkspace({
      preparationId: original.preparationId,
      allocationOperationId: original.allocationOperationId,
      binding,
      taskRoot: f.taskRoot,
      settings: original.settings,
      agentProfile: original.agentProfile,
      signal: signal(),
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(f.old.directory, 'dirty.txt'), 'utf8')).toBe('Unfinished original task');
  expect(reopened.getForConversation(f.conversationId)?.id).toBe(p.record.id);
});

it('migrates only the known legacy ordinary pointer schema, preserving exact unrelated records across reopen', async () => {
  const { OrdinaryWorkspaceCustody } = await import('../ordinary-workspace-custody.js');
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  db.exec(
    'CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE); CREATE TABLE ordinary_workspace_preparations (id TEXT PRIMARY KEY, record TEXT NOT NULL)',
  );
  const bytes = ' { "historical": "dirty task", "unknown": [ 1, 2 ] } ';
  db.prepare('INSERT INTO ordinary_workspaces VALUES (?,?,?)').run('old', bytes, 'conversation');
  db.prepare('INSERT INTO ordinary_workspace_preparations VALUES (?,?)').run('prep', bytes);
  new OrdinaryWorkspaceCustody(db, undefined);
  expect(db.prepare('SELECT record,conversation_id FROM ordinary_workspaces').get()).toEqual({
    record: bytes,
    conversation_id: 'conversation',
  });
  expect(db.prepare('SELECT record FROM ordinary_workspace_preparations').get()).toEqual({
    record: bytes,
  });
  expect(
    (
      db.prepare('PRAGMA table_info(ordinary_workspaces)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === 'conversation_id')?.notnull,
  ).toBe(0);
  db.prepare('UPDATE ordinary_workspaces SET conversation_id=NULL').run();
  new OrdinaryWorkspaceCustody(db, undefined);
  expect(db.prepare('SELECT record,conversation_id FROM ordinary_workspaces').get()).toEqual({
    record: bytes,
    conversation_id: null,
  });
  db.exec('CREATE INDEX retained_custom_index ON ordinary_workspaces(record)');
  expect(() => new OrdinaryWorkspaceCustody(db, undefined)).toThrow(
    'Unsupported ordinary custody schema',
  );
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='retained_custom_index'").get(),
  ).toBeDefined();
  expect(db.prepare('SELECT record FROM ordinary_workspaces').get()).toEqual({ record: bytes });
});

it('rolls ordinary retirement back if the new repository pointer cannot commit', async () => {
  const f = await fixture('ordinary'),
    p = await f.pending();
  const before = f.db.prepare('SELECT * FROM ordinary_workspaces WHERE id=?').get(f.old.id);
  f.db.exec(
    "CREATE TRIGGER reject_new_primary BEFORE UPDATE ON repository_workspaces WHEN NEW.conversation_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END",
  );
  expect(() => f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {})).toThrow(
    'fixture transaction failure',
  );
  expect(f.db.prepare('SELECT * FROM ordinary_workspaces WHERE id=?').get(f.old.id)).toEqual(
    before,
  );
  expect(f.service.getOrdinaryWorkspaceForConversation(f.conversationId)?.id).toBe(f.old.id);
  expect(f.service.getForConversation(f.conversationId)).toBeUndefined();
  expect(f.raw(p.record.id)).toEqual(p.before);
  expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
});

it('rejects an adopted witness when the retained original decision input is replaced', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  const adopted = f.service.get(p.record.id);
  const decision = adopted.pendingHostTaskDecision!;
  decision.evidence.input = { changed: 'original request lost' };
  decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(adopted), adopted.id);
  expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
});

it('rejects stale repository saves, release and recovery without resurrecting historical custody', async () => {
  const f = await fixture(),
    p = await f.pending();
  const old = f.service.get(f.old.id),
    oldRaw = f.raw(f.old.id).record;
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  const currentRaw = f.raw(p.record.id);
  const persistence = f.service as unknown as {
    save(record: RepositoryWorkspace, expectedRecord?: string): void;
  };
  old.sourceReleased = true;
  expect(() => persistence.save(old, oldRaw)).toThrow();
  expect(() => persistence.save(old)).toThrow();
  await expect(f.service.releaseSource(old.id, binding, f.conversationId)).rejects.toThrow();
  const reservation = {
    id: old.id,
    binding,
    conversationId: f.conversationId,
    taskRoot: f.taskRoot,
    runtimeBinding: runtime,
    commandFingerprint: 'e'.repeat(64),
    signal: signal(),
  };
  await expect(f.service.reserveHostTask(reservation)).rejects.toThrow();
  await expect(f.service.claimReservedHostTask(reservation)).rejects.toThrow();
  await expect(f.service.validateHostTask(f.conversationId, f.old.directory)).rejects.toThrow();
  expect(f.raw(p.record.id)).toEqual(currentRaw);
  expect(f.raw(old.id).conversation_id).toBeNull();
  expect(readFileSync(join(f.old.directory, 'dirty.txt'), 'utf8')).toBe('Unfinished original task');
  await f.service.releaseSource(p.record.id, binding, f.conversationId);
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
  ).not.toThrow();
});

it('prevents a release started before transfer from saving its stale captured record after await', async () => {
  const f = await fixture(),
    p = await f.pending();
  // releaseSource reaches its actual asynchronous rm before returning the promise.
  const released = f.service.releaseSource(f.old.id, binding, f.conversationId);
  const settled = released.then(
    () => ({ allowed: true }),
    () => ({ allowed: false }),
  );
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  expect(await settled).toEqual({ allowed: false });
  expect(f.raw(f.old.id).conversation_id).toBeNull();
  expect(f.service.getForConversation(f.conversationId)?.id).toBe(p.record.id);
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
  ).not.toThrow();
  expect(readFileSync(join(f.old.directory, 'dirty.txt'), 'utf8')).toBe('Unfinished original task');
});

it.each(['ordinary', 'repository'] as const)(
  'rolls back reentrant guarded changes to the exact %s owner',
  async (kind) => {
    const f = await fixture(kind),
      p = await f.pending();
    const table = kind === 'ordinary' ? 'ordinary_workspaces' : 'repository_workspaces';
    const before = f.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(f.old.id);
    const internal = (f.service as unknown as { db: Database.Database }).db;
    expect(() =>
      f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {
        internal
          .prepare(`UPDATE ${table} SET record=? WHERE id=?`)
          .run(JSON.stringify({ changed: true }), f.old.id);
      }),
    ).toThrow();
    expect(f.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(f.old.id)).toEqual(before);
    expect(f.raw(p.record.id)).toEqual(p.before);
  },
);

it('requires strict fresh synchronous authority and immutable exact facts before any pointer change', async () => {
  const f = await fixture(),
    p = await f.pending();
  const before = f.raw(f.old.id);
  const guards = [
    () => false,
    async () => {},
    () => {
      throw Error('revoked');
    },
  ];
  for (const guard of guards) {
    expect(() => f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, guard)).toThrow();
    expect(f.raw(f.old.id)).toEqual(before);
    expect(f.raw(p.record.id)).toEqual(p.before);
  }
  const guard = vi.fn(() => {});
  expect(() =>
    f.service.adoptPreparedRepositoryTransition(structuredClone(p.facts), p.childId, guard),
  ).toThrow();
  expect(() =>
    f.service.adoptPreparedRepositoryTransition(p.facts, p.childId + '-wrong', guard),
  ).toThrow();
  expect(guard).not.toHaveBeenCalled();
});

it('never qualifies mutable, accessor, proxy or oversized facts through a warm immutable projection', async () => {
  const f = await fixture(),
    p = await f.pending();
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {});
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const shallow = Object.freeze(structuredClone(p.facts));
  const accessor = structuredClone(p.facts);
  Object.defineProperty(accessor, 'version', { get: () => p.facts.version, enumerable: true });
  freezePendingHostTaskData(accessor);
  const oversized = structuredClone(p.facts);
  oversized.request.binding.accountLabel = 'x'.repeat(65536);
  freezePendingHostTaskData(oversized);
  for (const input of [shallow, accessor, new Proxy(p.facts, {}), oversized]) {
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => f.service.assertPreparedRepositoryTransitionAdopted(input, p.childId)).toThrow();
  }
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
  ).not.toThrow();
});

it('retains full original row evidence, rejects bounded snapshot overflow and every retained-proof drift', async () => {
  const f = await fixture(),
    p = await f.pending();
  const large = { ...p.record, unknownRetainedData: 'x'.repeat(262144) };
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(large), large.id);
  const largeFacts = freezePendingHostTaskData({
    ...p.facts,
    materializedRecordSha256: pendingHostTaskDecisionHash(large),
  });
  const guard = vi.fn(() => {});
  expect(() => f.service.adoptPreparedRepositoryTransition(largeFacts, p.childId, guard)).toThrow();
  expect(guard).not.toHaveBeenCalled();
  f.db
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(p.before.record, p.record.id);
  f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, guard);
  f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId);
  const adopted = f.service.get(p.record.id),
    before = f.raw(p.record.id);
  const mutations: Array<(r: RepositoryWorkspace) => void> = [
    (r) => {
      r.preparedRepositoryTransitionAdoption!.facts.oldWorkspace.directory = f.root;
    },
    (r) => {
      r.preparedRepositoryTransitionAdoption!.materializedRecord = '{}';
    },
    (r) => {
      r.preparedRepositoryTransitionAdoption!.materializedRecord = 'x'.repeat(262145);
    },
    (r) => {
      r.preparedRepositoryTransitionAdoption!.childCommandId = 'different-child';
    },
    (r) => {
      r.primaryDisposition!.currentConversationId = 'different-conversation';
    },
    (r) => {
      Object.assign(r, { sourceReleased: 'malformed' });
    },
    (r) => {
      r.pendingHostTaskDecision!.evidence.sessionId = 'another-conversation';
    },
    (r) => {
      r.pendingHostTaskDecision!.evidence.toolUseID = 'another-call';
    },
    (r) => {
      r.pendingHostTask!.rootIdentity.ino++;
    },
    (r) => {
      r.hostReservation!.rootIdentity.ino++;
    },
    (r) => {
      r.hostReservation!.taskRoot = f.root;
    },
    (r) => {
      Object.assign(r, { unknownFutureData: { changed: true } });
    },
    (r) => {
      r.localSource!.path = f.root;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(adopted);
    mutate(changed);
    f.db
      .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
      .run(JSON.stringify(changed), changed.id);
    expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
    f.db
      .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
      .run(before.record, p.record.id);
  }
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId),
  ).not.toThrow();
  f.db.prepare('UPDATE repository_workspaces SET conversation_id=NULL WHERE id=?').run(p.record.id);
  expect(() => f.service.assertPreparedRepositoryTransitionAdopted(p.facts, p.childId)).toThrow();
});

it('permits a fresh preparation for a revisited repository source, never reattaches its retired exact task', async () => {
  const f = await fixture(),
    first = await f.pending();
  f.service.adoptPreparedRepositoryTransition(first.facts, first.childId, () => {});
  const second = await f.pending({
    kind: 'repository',
    id: first.record.id,
    directory: first.facts.newWorkspace.directory,
  });
  f.service.adoptPreparedRepositoryTransition(second.facts, second.childId, () => {});
  expect(f.service.getForConversation(f.conversationId)?.id).toBe(second.record.id);
  expect(f.service.get(first.record.id).conversationId).toBe(f.conversationId);
  expect(f.raw(first.record.id).conversation_id).toBeNull();
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(first.facts, first.childId),
  ).toThrow();
  const guard = vi.fn(() => {});
  expect(() =>
    f.service.adoptPreparedRepositoryTransition(first.facts, first.childId, guard),
  ).toThrow();
  expect(guard).not.toHaveBeenCalled();
  expect(() =>
    f.service.assertPreparedRepositoryTransitionAdopted(second.facts, second.childId),
  ).not.toThrow();
});

it('refuses unknown ordinary schema constraints and rolls a failed legacy migration back byte-for-byte', async () => {
  const { OrdinaryWorkspaceCustody } = await import('../ordinary-workspace-custody.js');
  const unusual = new Database(':memory:');
  cleanups.push(() => unusual.close());
  unusual.exec(
    'CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(length(record)>0), conversation_id TEXT NOT NULL UNIQUE)',
  );
  unusual
    .prepare('INSERT INTO ordinary_workspaces VALUES (?,?,?)')
    .run('old', 'untouched', 'conversation');
  const unusualSchema = unusual
    .prepare("SELECT sql FROM sqlite_master WHERE name='ordinary_workspaces'")
    .get();
  expect(() => new OrdinaryWorkspaceCustody(unusual, undefined)).toThrow(
    'Unsupported ordinary custody schema',
  );
  expect(
    unusual.prepare("SELECT sql FROM sqlite_master WHERE name='ordinary_workspaces'").get(),
  ).toEqual(unusualSchema);
  expect(unusual.prepare('SELECT record FROM ordinary_workspaces').get()).toEqual({
    record: 'untouched',
  });
  const legacy = new Database(':memory:');
  cleanups.push(() => legacy.close());
  legacy.exec(
    'CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE); CREATE TABLE ordinary_workspaces_legacy_primary (retain TEXT)',
  );
  legacy
    .prepare('INSERT INTO ordinary_workspaces VALUES (?,?,?)')
    .run('old', ' exact dirty history ', 'conversation');
  const legacyBefore = legacy.prepare('SELECT * FROM ordinary_workspaces').all();
  expect(() => new OrdinaryWorkspaceCustody(legacy, undefined)).toThrow();
  expect(legacy.prepare('SELECT * FROM ordinary_workspaces').all()).toEqual(legacyBefore);
  expect(
    (
      legacy.prepare('PRAGMA table_info(ordinary_workspaces)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === 'conversation_id')?.notnull,
  ).toBe(1);
  expect(
    legacy
      .prepare("SELECT name FROM sqlite_master WHERE name='ordinary_workspaces_legacy_primary'")
      .get(),
  ).toBeDefined();
});

it.each([
  'CREATE VIEW retained_view AS SELECT record FROM ordinary_workspaces',
  'CREATE TABLE retained_reference (workspace_id TEXT REFERENCES ordinary_workspaces(id))',
  'CREATE TABLE retained_events (id TEXT); CREATE TRIGGER retained_trigger AFTER INSERT ON retained_events BEGIN UPDATE ordinary_workspaces SET record=record; END',
])(
  'preserves external schema references instead of rewriting them during migration: %s',
  async (external) => {
    const { OrdinaryWorkspaceCustody } = await import('../ordinary-workspace-custody.js');
    const db = new Database(':memory:');
    cleanups.push(() => db.close());
    db.exec(
      'CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE)',
    );
    db.exec(external);
    const before = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    expect(() => new OrdinaryWorkspaceCustody(db, undefined)).toThrow(
      'Unsupported ordinary custody schema',
    );
    expect(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='ordinary_workspace_preparations' ORDER BY name",
        )
        .all(),
    ).toEqual(before);
  },
);

it('rejects substituted original account, source, old/new workspace and record/scope digests before invoking authority', async () => {
  const f = await fixture(),
    p = await f.pending();
  const variants = [
    { ...p.facts, request: { ...p.facts.request, binding: { ...binding, accountId: 'other' } } },
    {
      ...p.facts,
      request: {
        ...p.facts.request,
        nativeTarget: { ...p.facts.request.nativeTarget, commandId: 'other-source' },
      },
    },
    { ...p.facts, oldWorkspace: { ...p.facts.oldWorkspace, directory: f.root } },
    { ...p.facts, newWorkspace: { ...p.facts.newWorkspace, directory: f.root } },
    { ...p.facts, newWorkspace: { ...p.facts.newWorkspace, baseOid: 'f'.repeat(40) } },
    { ...p.facts, consumedScopeSha256: '0'.repeat(64) },
    { ...p.facts, materializedRecordSha256: '0'.repeat(64) },
  ];
  const old = f.raw(f.old.id),
    guard = vi.fn(() => {});
  for (const variant of variants) {
    const facts = freezePendingHostTaskData(variant);
    const source = {
      ...facts.request.nativeTarget,
      callId: facts.request.prepareCallId,
      requestHash: facts.request.requestHash,
      resultSha256: facts.resultSha256,
    };
    const child = `prepared-repository-${pendingHostTaskDecisionHash([facts.request.conversationId, facts.request.id, source])}`;
    expect(() => f.service.adoptPreparedRepositoryTransition(facts, child, guard)).toThrow();
    expect(f.raw(f.old.id)).toEqual(old);
    expect(f.raw(p.record.id)).toEqual(p.before);
  }
  expect(guard).not.toHaveBeenCalled();
});

it('rolls back an intervening third current pointer together with both selected custody rows', async () => {
  const f = await fixture('ordinary'),
    p = await f.pending();
  const old = f.db.prepare('SELECT * FROM ordinary_workspaces WHERE id=?').get(f.old.id);
  const internal = (f.service as unknown as { db: Database.Database }).db;
  expect(() =>
    f.service.adoptPreparedRepositoryTransition(p.facts, p.childId, () => {
      internal
        .prepare('INSERT INTO repository_workspaces VALUES (?,?,?)')
        .run(
          'intervening',
          JSON.stringify({ id: 'intervening', conversationId: f.conversationId }),
          f.conversationId,
        );
    }),
  ).toThrow();
  expect(f.db.prepare('SELECT * FROM ordinary_workspaces WHERE id=?').get(f.old.id)).toEqual(old);
  expect(f.raw(p.record.id)).toEqual(p.before);
  expect(
    f.db.prepare('SELECT id FROM repository_workspaces WHERE id=?').get('intervening'),
  ).toBeUndefined();
});

it.each(['before', 'during', 'after'] as const)(
  'refuses cross-table ordinary pointer resurrection %s repository transfer',
  async (phase) => {
    const f = await fixture('ordinary'),
      first = await f.pending();
    f.service.adoptPreparedRepositoryTransition(first.facts, first.childId, () => {});
    const next = await f.pending({
      kind: 'repository',
      id: first.record.id,
      directory: first.facts.newWorkspace.directory,
    });
    const ordinaryBefore = f.db
      .prepare('SELECT * FROM ordinary_workspaces WHERE id=?')
      .get(f.old.id);
    const retired = f.service.getOrdinaryWorkspace(f.old.id);
    const current = {
      ...retired,
      primaryDisposition: { version: 1, revision: 2, currentConversationId: f.conversationId },
    };
    const restore = (db: Database.Database) =>
      db
        .prepare('UPDATE ordinary_workspaces SET record=?,conversation_id=? WHERE id=?')
        .run(JSON.stringify(current), f.conversationId, f.old.id);
    if (phase === 'after') {
      f.service.adoptPreparedRepositoryTransition(next.facts, next.childId, () => {});
      restore(f.db);
      expect(() =>
        f.service.assertPreparedRepositoryTransitionAdopted(next.facts, next.childId),
      ).toThrow();
      expect(() => f.service.getForConversation(f.conversationId)).toThrow();
      expect(() =>
        f.service.getHostReservation({
          id: next.record.id,
          binding,
          conversationId: f.conversationId,
          taskRoot: f.taskRoot,
          runtimeBinding: runtime,
        }),
      ).toThrow();
      expect(() => f.service.getOrdinaryWorkspaceForConversation(f.conversationId)).toThrow();
      await expect(
        f.service.claimOrdinaryWorkspace({
          id: f.old.id,
          binding,
          conversationId: f.conversationId,
          taskRoot: f.taskRoot,
          signal: signal(),
        }),
      ).rejects.toThrow();
    } else {
      if (phase === 'before') restore(f.db);
      const guard = vi.fn(() => {
        if (phase === 'during') restore((f.service as unknown as { db: Database.Database }).db);
      });
      expect(() =>
        f.service.adoptPreparedRepositoryTransition(next.facts, next.childId, guard),
      ).toThrow();
      if (phase === 'before') expect(guard).not.toHaveBeenCalled();
      else
        expect(f.db.prepare('SELECT * FROM ordinary_workspaces WHERE id=?').get(f.old.id)).toEqual(
          ordinaryBefore,
        );
      expect(f.raw(next.record.id)).toEqual(next.before);
      expect(f.raw(first.record.id).conversation_id).toBe(f.conversationId);
    }
  },
);

it('initializes and migrates legacy ordinary custody at RepositoryWorkspaces construction without changing retained bytes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-custody-constructor-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(join(root, 'workspaces.db'));
  cleanups.push(() => db.close());
  db.exec(
    'CREATE TABLE ordinary_workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE); CREATE TABLE ordinary_workspace_preparations (id TEXT PRIMARY KEY, record TEXT NOT NULL)',
  );
  const raw = ' { "historical": [ 1, 2 ], "retained": "exact bytes" } ';
  db.prepare('INSERT INTO ordinary_workspaces VALUES (?,?,?)').run(
    'historical',
    raw,
    'old-conversation',
  );
  db.prepare('INSERT INTO ordinary_workspace_preparations VALUES (?,?)').run('preparation', raw);
  writeFileSync(join(root, 'dirty-task.txt'), 'Original unfinished task');
  const deps = {
    authorize: vi.fn(async () => {
      throw Error('No remote access');
    }),
  };
  const service = new RepositoryWorkspaces(root, deps);
  cleanups.push(() => service.close());
  const reopened = new RepositoryWorkspaces(root, deps);
  cleanups.push(() => reopened.close());
  expect(
    (
      db.prepare('PRAGMA table_info(ordinary_workspaces)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((c) => c.name === 'conversation_id')?.notnull,
  ).toBe(0);
  expect(db.prepare('SELECT record,conversation_id FROM ordinary_workspaces').get()).toEqual({
    record: raw,
    conversation_id: 'old-conversation',
  });
  expect(db.prepare('SELECT record FROM ordinary_workspace_preparations').get()).toEqual({
    record: raw,
  });
  expect(readFileSync(join(root, 'dirty-task.txt'), 'utf8')).toBe('Original unfinished task');
  expect(deps.authorize).not.toHaveBeenCalled();
});
