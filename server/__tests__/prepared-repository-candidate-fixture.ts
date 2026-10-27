import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RepositoryWorkspaces, type RepositoryWorkspace } from '../repository-workspaces.js';
import {
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
  PendingHostTaskDecisionScopeSchema,
  type PendingHostTaskRequest,
  type PendingHostTaskDecisionScope,
} from '../pending-host-task.js';
import type { PreparedRepositoryTransitionCaptureInput } from '../prepared-repository-transition.js';
import type { LocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { localRepositoryPreparationSourceFacts } from '../local-repository-preparation-source.js';

export function preparedRepositoryCandidateFixture(cleanups: Array<() => void>) {
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

export function qualifiedPreparedRepositoryRecord(
  record: RepositoryWorkspace,
  input: PreparedRepositoryTransitionCaptureInput,
  layout?: 'standalone',
) {
  const request = record.pendingHostTask!.request;
  const source = record.localSource!;
  const facts = {
    version: 1,
    ...(layout ? { layout } : {}),
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
