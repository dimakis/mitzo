import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RepositoryWorkspaces, type RepositoryWorkspace } from '../repository-workspaces.js';
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
    assertPendingHostTaskCurrentSync: vi.fn(() => {}),
    assertPendingHostTaskAccess: vi.fn(async () => {}),
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
    await service.reservePendingHostTask(request, signal());
    const receipt = await service.materializePendingHostTask(request, signal());
    const record = service.get(ready.id);
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
