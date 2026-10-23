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
