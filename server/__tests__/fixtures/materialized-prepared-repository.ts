import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { AccountBindingSchema } from '@mitzo/protocol';
import type { ownedRuntimeFixture } from './owned-local-codex-runtime.js';
import {
  preparedRepositoryCandidateFixture,
  qualifiedPreparedRepositoryRecord,
} from '../prepared-repository-candidate-fixture.js';
import { fixtureReadAnchor } from './local-repository-read-owner.js';
import { snapshotRepositoryTaskCheckout } from '../../repository-task-checkout.js';
import { localRepositoryPreparationSourceFacts } from '../../local-repository-preparation-source.js';
import {
  PendingHostTaskDecisionScopeSchema,
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
} from '../../pending-host-task.js';
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
const numeric = (identity: { dev: string; ino: string }) => ({
  dev: Number(identity.dev),
  ino: Number(identity.ino),
});
export async function materializePreparedRepositoryFixture(
  cleanups: Array<() => void | Promise<void>>,
  f: Awaited<ReturnType<typeof ownedRuntimeFixture>>,
  first: import('../../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
  source: import('../../codex-conversation-store.js').CodexNativeTurnTarget,
  original?: import('../../native-host-tool-context.js').NativeHostToolContext,
) {
  const binding = AccountBindingSchema.parse(first.lease.binding);
  const privateCloses: Array<() => void> = [];
  const templates = preparedRepositoryCandidateFixture(privateCloses);
  cleanups.push(...privateCloses);
  let record = templates.pending();
  const sourcePath = join(f.root, 'source'),
    taskRoot = f.reservation.taskRoot,
    directory = join(taskRoot, `repo-${record.id}`),
    featureBranch = `mitzo/repo-${record.id}`;
  git(sourcePath, 'worktree', 'add', '-qb', featureBranch, directory);
  const sourceIdentity = {
    selection: 'existing' as const,
    repositoryId: 'existing-fixture',
    path: sourcePath,
    root: numeric((await fixtureReadAnchor(sourcePath)).identity),
    commonDirectory: join(sourcePath, '.git'),
    commonRoot: numeric((await fixtureReadAnchor(join(sourcePath, '.git'))).identity),
  };
  const taskIdentity = await snapshotRepositoryTaskCheckout(
    directory,
    featureBranch,
    sourceIdentity,
  );
  const request = {
    ...record.pendingHostTask!.request,
    binding,
    runtimeBinding: first.expected.binding,
    conversationId: first.sessionId,
    runtimeId: original?.runtimeId ?? record.pendingHostTask!.request.runtimeId,
    nativeTarget: source,
    prepareCallId: original?.callId ?? `prepare-${source.commandId}`,
    requestHash: original?.requestHash ?? record.pendingHostTask!.request.requestHash,
    taskRoot,
  };
  const oldWorkspace = {
    kind: original?.workspace.kind ?? ('repository' as const),
    id: first.workspace.id,
    directory: first.workspace.directory!,
  };
  const effect = {
    kind: 'local-repository-worktree' as const,
    workspaceId: record.id,
    featureBranch,
    baseOid: git(sourcePath, 'rev-parse', 'HEAD'),
    source: {
      path: sourcePath,
      gitDirectory: join(sourcePath, '.git'),
      commonDirectory: join(sourcePath, '.git'),
    },
    task: { taskRoot, directory, adminBasename: `repo-${record.id}` },
  };
  const scope = PendingHostTaskDecisionScopeSchema.parse({
    ...record.pendingHostTaskDecision!.scope,
    oldWorkspace,
    create: { ...effect, intent: 'create' },
    use: { ...effect, intent: 'use' },
    sourceIdentity,
    taskRootIdentity: numeric((await fixtureReadAnchor(taskRoot)).identity),
    sourceGitEffects: {
      administrationDirectory: taskIdentity.linkedGit!.directory,
      branchReference: join(sourcePath, '.git', 'refs', 'heads', featureBranch),
      branchReferenceLock: join(sourcePath, '.git', 'refs', 'heads', featureBranch) + '.lock',
      branchLog: join(sourcePath, '.git', 'logs', 'refs', 'heads', featureBranch),
    },
  });
  record = {
    ...record,
    binding,
    featureBranch,
    baseOid: effect.baseOid,
    localSource: sourceIdentity,
    ordinaryPreparation: {
      ...record.ordinaryPreparation!,
      originalBinding: binding,
      runtimeBinding: first.expected.binding,
    },
    pendingHostTask: {
      ...record.pendingHostTask!,
      request,
      rootIdentity: scope.taskRootIdentity,
      directory,
      taskIdentity,
    },
    pendingHostTaskDecision: {
      ...record.pendingHostTaskDecision!,
      request,
      scope,
      scopeSha256: pendingHostTaskDecisionHash(scope),
    },
  };
  record.pendingHostTaskDecision!.evidence = {
    ...record.pendingHostTaskDecision!.evidence,
    sessionId: first.sessionId,
    toolUseID: request.prepareCallId,
    input: pendingHostTaskDecisionPayload(request, scope),
    inputSha256: pendingHostTaskDecisionHash(pendingHostTaskDecisionPayload(request, scope)),
  };
  record = qualifiedPreparedRepositoryRecord(record, {
    binding,
    conversationId: first.sessionId,
    sourceTarget: source,
    oldWorkspace,
  });
  const qualified = record.qualifiedLocalPreparation!;
  qualified.allocationFacts = {
    ...qualified.allocationFacts,
    source: {
      ...qualified.allocationFacts.source,
      sourceAnchor: await fixtureReadAnchor(sourcePath),
      commonAnchor: await fixtureReadAnchor(join(sourcePath, '.git')),
    },
    taskRoot: await fixtureReadAnchor(taskRoot),
  };
  qualified.allocationFactsSha256 = pendingHostTaskDecisionHash(qualified.allocationFacts);
  record.sourceDigest = record.pendingHostTask!.sourceDigest = qualified.allocationFactsSha256;
  const decision = record.pendingHostTaskDecision!;
  decision.scope = PendingHostTaskDecisionScopeSchema.parse({
    ...decision.scope,
    sourceDigest: record.sourceDigest,
    allocationFactsSha256: record.sourceDigest,
    anchorsSha256: localRepositoryPreparationSourceFacts(qualified.allocationFacts).anchorsSha256,
  });
  decision.scopeSha256 = pendingHostTaskDecisionHash(decision.scope);
  decision.evidence.input = pendingHostTaskDecisionPayload(request, decision.scope);
  decision.evidence.inputSha256 = pendingHostTaskDecisionHash(decision.evidence.input);
  record.qualifiedLocalPreparation!.publication = { version: 1, directories: [], files: [] };
  const db = new Database(join(f.root, 'repositories', 'workspaces.db'));
  cleanups.push(() => {
    db.close();
  });
  db.prepare('INSERT INTO repository_workspaces VALUES(?,?,NULL)').run(
    record.id,
    JSON.stringify(record),
  );
  return { record, request, taskIdentity };
}
