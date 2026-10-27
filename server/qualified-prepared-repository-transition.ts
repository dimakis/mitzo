import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import {
  assertPreparedRepositoryMaterializedRecordBound,
  type RepositoryWorkspaces,
  type RepositoryWorkspace,
} from './repository-workspaces.js';
import {
  PendingHostTaskRequestSchema,
  PendingHostTaskReceiptSchema,
  PendingHostTaskDecisionSchema,
  freezePendingHostTaskData,
  pendingHostTaskDecisionHash,
  pendingHostTaskDecisionPayload,
} from './pending-host-task.js';
import { localRepositoryPreparationSourceFacts } from './local-repository-preparation-source.js';
import type {
  PreparedRepositoryTransitionCaptureInput,
  PreparedRepositoryTransitionFacts,
} from './prepared-repository-transition.js';

type Candidate = NonNullable<
  ReturnType<RepositoryWorkspaces['findPreparedRepositoryTransitionCandidate']>
>;
const unavailable = () => Error('Qualified prepared repository transition data unavailable');

/** Pure DATA qualification before native reservation, not a proof/current
 * owner, filesystem observation, result authentication or admission. The actual
 * producer must retain its fresh read/queue/native-result owners separately. */
export function projectQualifiedPreparedRepositoryTransitionFacts(
  candidate: Candidate,
  input: PreparedRepositoryTransitionCaptureInput,
  resultSha256: string,
): Readonly<PreparedRepositoryTransitionFacts> {
  try {
    assertPreparedRepositoryMaterializedRecordBound(candidate.rawRecord);
    const record: RepositoryWorkspace = JSON.parse(candidate.rawRecord);
    const recordHash = pendingHostTaskDecisionHash(record);
    if (
      !isDeepStrictEqual(record, candidate.record) ||
      recordHash !== pendingHostTaskDecisionHash(candidate.record) ||
      !/^[a-f0-9]{64}$/.test(resultSha256)
    )
      throw unavailable();
    const request = PendingHostTaskRequestSchema.parse(record.pendingHostTask?.request);
    const receipt = PendingHostTaskReceiptSchema.parse(record.pendingHostTask);
    const decision = PendingHostTaskDecisionSchema.parse(record.pendingHostTaskDecision);
    const qualified = record.qualifiedLocalPreparation;
    const scope = decision.scope;
    if (
      !qualified ||
      qualified.version !== 1 ||
      !qualified.allocationFacts ||
      record.state !== 'ready' ||
      record.hostReservation ||
      record.conversationId ||
      record.sourceReleased ||
      record.directory ||
      record.taskIdentity ||
      !isDeepStrictEqual(request, candidate.request) ||
      !isDeepStrictEqual(record.binding, request.binding) ||
      !isDeepStrictEqual(record.ordinaryPreparation?.originalBinding, request.binding) ||
      !isDeepStrictEqual(record.ordinaryPreparation?.runtimeBinding, request.runtimeBinding) ||
      !isDeepStrictEqual(request.binding, input.binding) ||
      request.conversationId !== input.conversationId ||
      !isDeepStrictEqual(request.nativeTarget, input.sourceTarget) ||
      !isDeepStrictEqual(qualified.request, request) ||
      !isDeepStrictEqual(qualified.oldWorkspace, input.oldWorkspace) ||
      !isDeepStrictEqual(scope.oldWorkspace, input.oldWorkspace) ||
      !isDeepStrictEqual(decision.request, request) ||
      decision.state !== 'consumed' ||
      receipt.state !== 'materialized' ||
      !receipt.taskIdentity ||
      scope.referenceCoverage !== 'preparation-head-and-namespace-v1' ||
      scope.allocationFactsSha256 !== qualified.allocationFactsSha256 ||
      decision.scopeSha256 !== pendingHostTaskDecisionHash(scope) ||
      decision.evidence.toolUseID !== request.prepareCallId ||
      decision.evidence.sessionId !== request.conversationId ||
      !isDeepStrictEqual(decision.evidence.input, pendingHostTaskDecisionPayload(request, scope)) ||
      decision.evidence.inputSha256 !== pendingHostTaskDecisionHash(decision.evidence.input)
    )
      throw unavailable();
    const allocation = qualified.allocationFacts;
    const labels = localRepositoryPreparationSourceFacts(allocation);
    const source = record.localSource;
    const task = receipt.taskIdentity;
    const taskRootIdentity = {
      dev: Number(allocation.taskRoot.identity.dev),
      ino: Number(allocation.taskRoot.identity.ino),
    };
    const expectedScope = {
      kind: 'local-repository-worktree',
      workspaceId: request.id,
      featureBranch: record.featureBranch,
      baseOid: record.baseOid,
      source: {
        path: labels.source.path,
        gitDirectory: labels.source.gitDirectory,
        commonDirectory: labels.source.commonDirectory,
      },
      task: {
        taskRoot: request.taskRoot,
        directory: join(request.taskRoot, `repo-${request.id}`),
        adminBasename: `repo-${request.id}`,
      },
    };
    const taskGit =
      allocation.layout === 'standalone' ? join(receipt.directory, '.git') : undefined;
    const branchReference = join(
      taskGit ?? labels.source.commonDirectory,
      'refs',
      'heads',
      record.featureBranch,
    );
    if (
      !Object.values(taskRootIdentity).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      !isDeepStrictEqual(scope.taskRootIdentity, taskRootIdentity) ||
      !isDeepStrictEqual(receipt.rootIdentity, taskRootIdentity) ||
      !isDeepStrictEqual(scope.create, { ...expectedScope, intent: 'create' }) ||
      !isDeepStrictEqual(scope.use, { ...expectedScope, intent: 'use' }) ||
      scope.layout !== (taskGit ? 'standalone' : undefined) ||
      !isDeepStrictEqual(scope.sourceGitEffects, {
        administrationDirectory:
          taskGit ?? join(labels.source.commonDirectory, 'worktrees', `repo-${request.id}`),
        branchReference,
        branchReferenceLock: branchReference + '.lock',
        branchLog: join(
          taskGit ?? labels.source.commonDirectory,
          'logs',
          'refs',
          'heads',
          record.featureBranch,
        ),
      }) ||
      receipt.directory !== expectedScope.task.directory
    )
      throw unavailable();

    if (
      !source ||
      source.selection !== 'existing' ||
      allocation.version !== 1 ||
      allocation.workspaceId !== request.id ||
      record.id !== request.id ||
      allocation.taskRoot.rootPath !== request.taskRoot ||
      allocation.source.qualification !== 'preparation' ||
      allocation.source.referenceCoverage !== 'preparation-head-and-namespace-v1' ||
      Buffer.byteLength(JSON.stringify(allocation)) > 32768 ||
      qualified.allocationFactsSha256 !== pendingHostTaskDecisionHash(allocation) ||
      qualified.allocationFactsSha256 !== record.sourceDigest ||
      receipt.sourceDigest !== record.sourceDigest ||
      scope.sourceDigest !== record.sourceDigest ||
      scope.anchorsSha256 !== labels.anchorsSha256 ||
      source.path !== labels.source.path ||
      source.commonDirectory !== labels.source.commonDirectory ||
      !isDeepStrictEqual(source.root, labels.source.root) ||
      !isDeepStrictEqual(source.commonRoot, labels.source.commonRoot) ||
      !isDeepStrictEqual(scope.sourceIdentity, source) ||
      record.baseBranch !== allocation.baseBranch ||
      record.baseOid !== allocation.baseOid ||
      record.featureBranch !== allocation.featureBranch ||
      receipt.directory !== scope.create.task.directory ||
      receipt.directory !== task.directory ||
      task.featureBranch !== record.featureBranch ||
      !isDeepStrictEqual(task.localSource, source) ||
      (taskGit
        ? task.linkedGit !== undefined
        : task.linkedGit?.directory !== scope.sourceGitEffects.administrationDirectory)
    )
      throw unavailable();
    const facts: PreparedRepositoryTransitionFacts = {
      version: 'prepared-repository-transition-v1',
      request,
      oldWorkspace: qualified.oldWorkspace,
      newWorkspace: {
        kind: 'repository',
        id: record.id,
        directory: receipt.directory,
        featureBranch: record.featureBranch,
        baseOid: record.baseOid,
        taskIdentity: task,
      },
      consumedScopeSha256: decision.scopeSha256,
      materializedRecordSha256: recordHash,
      resultSha256,
    };
    if (Buffer.byteLength(JSON.stringify(facts)) > 65536) throw unavailable();
    return freezePendingHostTaskData(facts);
  } catch {
    throw unavailable();
  }
}
