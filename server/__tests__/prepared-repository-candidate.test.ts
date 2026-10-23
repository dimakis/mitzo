import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RepositoryWorkspaces,
  assertPreparedRepositoryMaterializedRecordBound,
  type RepositoryWorkspace,
} from '../repository-workspaces.js';
import {
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
  PendingHostTaskDecisionScopeSchema,
  type PendingHostTaskRequest,
  type PendingHostTaskDecisionScope,
} from '../pending-host-task.js';
import type { PreparedRepositoryTransitionCaptureInput } from '../prepared-repository-transition.js';
import { projectQualifiedPreparedRepositoryTransitionFacts } from '../qualified-prepared-repository-transition.js';
import type { LocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { localRepositoryPreparationSourceFacts } from '../local-repository-preparation-source.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-pending-source-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const authorize = vi.fn(async () => {
    throw Error('Candidate lookup must not request remote or source access');
  });
  const service = new RepositoryWorkspaces(join(root, 'private'), { authorize });
  cleanups.push(() => service.close());
  const db = new Database(join(root, 'private', 'workspaces.db'));
  cleanups.push(() => db.close());
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline fixture',
    provider: 'openai-codex' as const,
    model: 'fixture',
    profileRevision: 'revision',
  };
  const runtimeBinding = {
    version: 2 as const,
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: { location: 'local' as const, targetId: 'fixture-mac', targetRevision: 'target' },
  };
  const input: PreparedRepositoryTransitionCaptureInput = {
    binding,
    conversationId: 'conversation',
    sourceTarget: {
      commandId: 'command',
      attempt: 1,
      threadId: 'thread',
      turnId: 'turn',
      generation: 0,
    },
    oldWorkspace: { kind: 'ordinary', id: 'old-workspace', directory: '/fixture/old-task' },
  };
  const save = (record: RepositoryWorkspace, primary: string | null = null) => {
    const serialized = JSON.stringify(record);
    db.prepare('INSERT OR REPLACE INTO repository_workspaces VALUES(?,?,?)').run(
      record.id,
      serialized,
      primary,
    );
    return serialized;
  };
  const pending = () => {
    const id = randomUUID();
    const request: PendingHostTaskRequest = {
      id,
      binding,
      runtimeBinding,
      conversationId: input.conversationId,
      runtimeId: 'runtime',
      nativeTarget: input.sourceTarget,
      prepareCallId: 'prepare-call',
      requestHash: 'a'.repeat(64),
      taskRoot: '/fixture/tasks',
    };
    const source = {
      selection: 'existing' as const,
      repositoryId: 'existing-fixture',
      path: '/fixture/source',
      root: { dev: 1, ino: 2 },
      commonDirectory: '/fixture/source/.git',
      commonRoot: { dev: 1, ino: 3 },
    };
    const directory = `${request.taskRoot}/repo-${id}`;
    const featureBranch = `mitzo/repo-${id}`;
    const effect = {
      kind: 'local-repository-worktree' as const,
      workspaceId: id,
      featureBranch,
      baseOid: 'b'.repeat(40),
      source: {
        path: source.path,
        gitDirectory: source.commonDirectory,
        commonDirectory: source.commonDirectory,
      },
      task: { taskRoot: request.taskRoot, directory, adminBasename: `repo-${id}` },
    };
    const scope: PendingHostTaskDecisionScope = PendingHostTaskDecisionScopeSchema.parse({
      version: 1,
      oldWorkspace: input.oldWorkspace,
      create: { ...effect, intent: 'create' },
      use: { ...effect, intent: 'use' },
      sourceIdentity: source,
      taskRootIdentity: { dev: 1, ino: 4 },
      sourceDigest: 'c'.repeat(64),
      anchorsSha256: 'd'.repeat(64),
      sourceGitEffects: {
        administrationDirectory: `${source.commonDirectory}/worktrees/repo-${id}`,
        branchReference: `${source.commonDirectory}/refs/heads/${featureBranch}`,
        branchReferenceLock: `${source.commonDirectory}/refs/heads/${featureBranch}.lock`,
        branchLog: `${source.commonDirectory}/logs/refs/heads/${featureBranch}`,
      },
    });
    const payload = pendingHostTaskDecisionPayload(request, scope);
    const record: RepositoryWorkspace = {
      id,
      connectionId: 'local',
      connectionRevision: 0,
      repository: 'local/existing-fixture',
      binding,
      baseBranch: 'main',
      baseOid: effect.baseOid,
      featureBranch,
      state: 'ready',
      createdAt: 1,
      sourceDigest: scope.sourceDigest,
      localSource: source,
      ordinaryPreparation: {
        version: 1,
        originalBinding: binding,
        runtimeBinding,
        credentialDigest: 'e'.repeat(64),
      },
      pendingHostTask: {
        version: 1,
        request,
        rootIdentity: scope.taskRootIdentity,
        directory,
        sourceDigest: scope.sourceDigest,
        state: 'materialized',
        taskIdentity: {
          directory,
          featureBranch,
          root: { dev: 1, ino: 5 },
          git: { dev: 1, ino: 6 },
          localSource: source,
          linkedGit: {
            directory: scope.sourceGitEffects.administrationDirectory,
            identity: { dev: 1, ino: 7 },
          },
        },
      },
      pendingHostTaskDecision: {
        version: 1,
        request,
        scope,
        scopeSha256: pendingHostTaskDecisionHash(scope),
        evidence: {
          permId: 'permission',
          toolUseID: request.prepareCallId,
          sessionId: input.conversationId,
          toolName: 'PrepareLocalRepository',
          input: payload,
          inputSha256: pendingHostTaskDecisionHash(payload),
          approvalScope: 'request',
          decisionClassification: 'user_temporary',
          expiresAt: 1, // Historical materialization evidence, not a renewed grant.
        },
        state: 'consumed',
      },
    };
    return record;
  };
  return { service, db, input, pending, save, authorize };
}

it('retains exact raw bytes and unknown record fields in a frozen read-only candidate without filesystem access', () => {
  const f = fixture();
  const record = { ...f.pending(), retainedUnknownEvidence: { nested: ['original'] } };
  const raw = f.save(record);
  const selected = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
  expect(selected.record).toEqual(record);
  expect(selected.rawRecord).toBe(raw);
  expect(pendingHostTaskDecisionHash(selected.record)).toBe(
    pendingHostTaskDecisionHash(JSON.parse(raw)),
  );
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.record.pendingHostTask!.taskIdentity!.root)).toBe(true);
  expect(Object.isFrozen((selected.record as typeof record).retainedUnknownEvidence.nested)).toBe(
    true,
  );
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
  expect(f.authorize).not.toHaveBeenCalled();
});

it('returns no candidate for an absent exact native source tuple without scanning host paths', () => {
  const f = fixture();
  f.save(f.pending());
  expect(
    f.service.findPreparedRepositoryTransitionCandidate({
      ...f.input,
      sourceTarget: { ...f.input.sourceTarget, turnId: 'other-turn' },
    }),
  ).toBeUndefined();
});

it('refuses multiple pending rows for the same completed source instead of selecting latest', () => {
  const f = fixture();
  f.save(f.pending());
  f.save(f.pending());
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow(
    'pending_host_task_uncertain',
  );
});

it.each([
  'receiptRequest',
  'decision',
  'materialized',
  'primary',
  'adopted',
  'sourceDigest',
] as const)('refuses mismatched or ineligible %s evidence without rewriting the row', (change) => {
  const f = fixture();
  const record = f.pending();
  if (change === 'receiptRequest')
    record.pendingHostTaskDecision!.request = {
      ...record.pendingHostTaskDecision!.request,
      prepareCallId: 'other-call',
    };
  if (change === 'decision') record.pendingHostTaskDecision!.state = 'uncertain';
  if (change === 'materialized') {
    record.pendingHostTask!.state = 'materializing';
    delete record.pendingHostTask!.taskIdentity;
  }
  if (change === 'primary') record.conversationId = f.input.conversationId;
  if (change === 'adopted') Object.assign(record, { preparedRepositoryTransitionAdoption: {} });
  if (change === 'sourceDigest') record.sourceDigest = 'f'.repeat(64);
  const raw = f.save(record, change === 'primary' ? f.input.conversationId : null);
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow(
    'pending_host_task_ownership_changed',
  );
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
});

it('filters exact account and old workspace before the bounded ambiguity check', () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const otherAccount = f.pending();
    otherAccount.binding = { ...otherAccount.binding, model: 'other-model' };
    f.save(otherAccount);
    const otherWorkspace = f.pending();
    otherWorkspace.pendingHostTaskDecision!.scope = {
      ...otherWorkspace.pendingHostTaskDecision!.scope,
      oldWorkspace: { ...f.input.oldWorkspace, id: 'other-owner' },
    };
    f.save(otherWorkspace);
  }
  expect(f.service.findPreparedRepositoryTransitionCandidate(f.input)).toBeUndefined();
  const original = f.pending();
  f.save(original);
  expect(f.service.findPreparedRepositoryTransitionCandidate(f.input)!.record.id).toBe(original.id);
});

it('refuses caller preparation IDs instead of using them as a selector', () => {
  const f = fixture();
  const record = f.pending();
  f.save(record);
  expect(() =>
    f.service.findPreparedRepositoryTransitionCandidate({
      ...f.input,
      preparationId: record.id,
    } as never),
  ).toThrow('pending_host_task_invalid_input');
});

it('enforces the exact shared UTF-8 raw-record bound before returning a predictable unadoptable candidate', () => {
  expect(() => assertPreparedRepositoryMaterializedRecordBound('x'.repeat(262144))).not.toThrow();
  expect(() => assertPreparedRepositoryMaterializedRecordBound('é'.repeat(131073))).toThrow();
  const f = fixture();
  const record = { ...f.pending(), retainedUnknownEvidence: 'x'.repeat(262144) };
  const raw = f.save(record);
  expect(() => f.service.findPreparedRepositoryTransitionCandidate(f.input)).toThrow();
  expect(f.db.prepare('SELECT record FROM repository_workspaces').all()).toEqual([{ record: raw }]);
});

// Explicit metadata-only materialization fixture: no filesystem/task/current
// authority or actual actor effects are inferred from these declared records.
function qualifiedRecord(
  record: RepositoryWorkspace,
  input: PreparedRepositoryTransitionCaptureInput,
) {
  const request = record.pendingHostTask!.request;
  const source = record.localSource!;
  const facts = {
    version: 1,
    workspaceId: record.id,
    baseOid: record.baseOid,
    baseBranch: record.baseBranch,
    featureBranch: record.featureBranch,
    source: {
      qualification: 'preparation',
      referenceCoverage: 'preparation-head-and-namespace-v1',
      path: source.path,
      gitDirectory: source.commonDirectory,
      commonDirectory: source.commonDirectory,
      sourceAnchor: { rootPath: source.path, identity: { dev: '1', ino: '2' } },
      commonAnchor: { rootPath: source.commonDirectory, identity: { dev: '1', ino: '3' } },
    },
    taskRoot: { rootPath: request.taskRoot, identity: { dev: '1', ino: '4' } },
    directories: [],
    absentPaths: [],
  } as unknown as LocalRepositoryAllocationFacts;
  const digest = pendingHostTaskDecisionHash(facts);
  record.qualifiedLocalPreparation = {
    version: 1,
    request,
    oldWorkspace: input.oldWorkspace,
    allocationFacts: facts,
    allocationFactsSha256: digest,
  };
  record.sourceDigest = record.pendingHostTask!.sourceDigest = digest;
  const decision = record.pendingHostTaskDecision!;
  decision.scope = PendingHostTaskDecisionScopeSchema.parse({
    ...decision.scope,
    sourceDigest: digest,
    anchorsSha256: localRepositoryPreparationSourceFacts(facts).anchorsSha256,
    allocationFactsSha256: digest,
    referenceCoverage: 'preparation-head-and-namespace-v1',
  });
  decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
  decision.evidence.input = pendingHostTaskDecisionPayload(request, decision.scope);
  decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
  return record;
}

it('projects immutable qualified transition DATA with the full original materialized-row digest only', () => {
  const f = fixture();
  const record = {
    ...qualifiedRecord(f.pending(), f.input),
    retainedUnknown: { original: ['bytes'] },
  };
  f.save(record);
  const candidate = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
  const result = projectQualifiedPreparedRepositoryTransitionFacts(
    candidate,
    f.input,
    'f'.repeat(64),
  );
  expect(result.request).toEqual(candidate.request);
  expect(result.materializedRecordSha256).toBe(pendingHostTaskDecisionHash(record));
  expect(result.consumedScopeSha256).toBe(record.pendingHostTaskDecision!.scopeSha256);
  expect(result.newWorkspace.taskIdentity).toEqual(record.pendingHostTask!.taskIdentity);
  expect(result.oldWorkspace).toEqual(f.input.oldWorkspace);
  expect(result.resultSha256).toBe('f'.repeat(64));
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.newWorkspace.taskIdentity.root)).toBe(true);
  expect(Object.isFrozen(result.request.runtimeBinding.execution)).toBe(true);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT record FROM repository_workspaces').get()).toEqual({
    record: candidate.rawRecord,
  });
});

it.each([
  'missing-qualified',
  'missing-scope-digest',
  'changed-old-workspace',
  'changed-result',
  'raw-row',
] as const)(
  'refuses unqualified transition DATA %s without new authority or row effects',
  (change) => {
    const f = fixture();
    const record = qualifiedRecord(f.pending(), f.input);
    const originalRaw = f.save(record);
    const original = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
    if (change === 'missing-qualified') delete record.qualifiedLocalPreparation;
    if (change === 'missing-scope-digest') {
      delete record.pendingHostTaskDecision!.scope.allocationFactsSha256;
      const decision = record.pendingHostTaskDecision!;
      decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
      decision.evidence.input = pendingHostTaskDecisionPayload(decision.request, decision.scope);
      decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
    }
    const candidate = { ...original, record, rawRecord: JSON.stringify(record) };
    const selected =
      change === 'changed-old-workspace'
        ? { ...f.input, oldWorkspace: { ...f.input.oldWorkspace, id: 'other' } }
        : f.input;
    const supplied =
      change === 'raw-row' ? { ...candidate, rawRecord: candidate.rawRecord + 'x' } : candidate;
    expect(() =>
      projectQualifiedPreparedRepositoryTransitionFacts(
        supplied,
        selected,
        change === 'changed-result' ? 'not-a-sha' : 'f'.repeat(64),
      ),
    ).toThrow();
    expect(f.db.prepare('SELECT record FROM repository_workspaces').get()).toEqual({
      record: originalRaw,
    });
    expect(f.authorize).not.toHaveBeenCalled();
  },
);

it.each(['evidence-input', 'scope-create', 'root-identity', 'ordinary-runtime'] as const)(
  'refuses mismatched qualified transition correlation %s before a reservation can be considered',
  (change) => {
    const f = fixture();
    const record = qualifiedRecord(f.pending(), f.input);
    f.save(record);
    const original = f.service.findPreparedRepositoryTransitionCandidate(f.input)!;
    const decision = record.pendingHostTaskDecision!;
    if (change === 'evidence-input') decision.evidence.input = {};
    if (change === 'scope-create') decision.scope.create.baseOid = 'f'.repeat(40);
    if (change === 'root-identity') decision.scope.taskRootIdentity.ino += 1;
    if (change === 'ordinary-runtime') {
      record.ordinaryPreparation!.runtimeBinding = structuredClone(
        record.ordinaryPreparation!.runtimeBinding,
      );
      record.ordinaryPreparation!.runtimeBinding.execution.targetId = 'different-target';
    }
    if (change === 'scope-create' || change === 'root-identity') {
      decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
      decision.evidence.input = pendingHostTaskDecisionPayload(decision.request, decision.scope);
      decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
    }
    const candidate = { ...original, record, rawRecord: JSON.stringify(record) };
    expect(() =>
      projectQualifiedPreparedRepositoryTransitionFacts(candidate, f.input, 'f'.repeat(64)),
    ).toThrow();
  },
);
