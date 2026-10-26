import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { TaskStore } from './task-store.js';
import type { TelosArtifactStore } from './telos-artifact-store.js';
import { TelosWorkError, type TelosWorkStore } from './telos-work-store.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { assertTelosWorkExecutionAuthority } from './telos-work-execution-authority.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';

type Pin = TelosWorkRoleContextSelection['artifacts'][number];
function unavailable(): never {
  throw new TelosWorkError(
    'conflict',
    'Original native source material scope changed; review again',
  );
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface NativeTelosWorkerMaterialOwners {
  events: EventStore;
  work: TelosWorkStore;
  artifacts: TelosArtifactStore;
  tasks?: Pick<TaskStore, 'get' | 'getTelosExecutionBinding'>;
  /** Actual host custody owner. Never a workspace descriptor from request JSON. */
  repositoryWorkspaces?(): Pick<RepositoryWorkspaces, 'getForConversation'>;
  conversationId: string;
  itemId: string;
  pendingIdentity: unknown;
  /** Original privately captured native pending owner, never a request assertion. */
  assertCurrent(): void;
}

/** Private, read-only scope for a genuine pending native lead adoption. A hash
 * is correlation/denial data only. It cannot substitute for any owner below. */
export function captureNativeTelosWorkerMaterials(owners: NativeTelosWorkerMaterialOwners) {
  const { events, work, artifacts, conversationId, itemId } = owners;
  const session = events.getSession(conversationId);
  const originalRole = resolveTelosWorkRoleContext(
    events,
    conversationId,
    session?.accountBinding ?? undefined,
  );
  if (originalRole?.role !== 'lead') return undefined;
  let originalRepositoryOwner:
    ReturnType<NonNullable<NativeTelosWorkerMaterialOwners['repositoryWorkspaces']>> | undefined;
  const localWorkspace = (id: string) => {
    const meta = events.getSession(id),
      route = events.getSessionRuntimeBinding(id);
    const account = meta?.accountBinding;
    if (
      !meta ||
      !isAvailableTelosWorkConversation(meta) ||
      !account ||
      route?.version !== 2 ||
      route.harness.implementation !== 'codex' ||
      route.execution.location !== 'local' ||
      route.account.accountId !== account.accountId ||
      route.account.provider !== account.provider ||
      route.account.profileRevision !== account.profileRevision
    )
      unavailable();
    const role = resolveTelosWorkRoleContext(events, id, account);
    // Keep non-Git scope facts and correlation hashes unchanged; this path must
    // not open repository custody or inherit a repository capability.
    if (meta.ordinaryWorkspaceId && meta.repositoryWorkspaceId == null)
      return { account, route, workspaceId: meta.ordinaryWorkspaceId, role };
    if (!meta.repositoryWorkspaceId || meta.ordinaryWorkspaceId != null) unavailable();
    const owner = owners.repositoryWorkspaces?.();
    if (
      !owner ||
      typeof owner.getForConversation !== 'function' ||
      (originalRepositoryOwner && owner !== originalRepositoryOwner)
    )
      unavailable();
    originalRepositoryOwner ??= owner;
    const workspace = owner.getForConversation(id);
    const originalRuntime =
      workspace?.ordinaryPreparation?.runtimeBinding ??
      workspace?.qualifiedLocalPreparation?.request.runtimeBinding;
    if (
      !workspace ||
      workspace.id !== meta.repositoryWorkspaceId ||
      workspace.state !== 'claimed' ||
      workspace.directory !== meta.cwd ||
      !workspace.taskIdentity ||
      !isDeepStrictEqual(workspace.binding, account) ||
      !isDeepStrictEqual(originalRuntime, route)
    )
      unavailable();
    // The real owner proves the current primary and retained checkout. These
    // private facts only narrow source selection; they grant no filesystem read.
    return {
      account,
      route,
      role,
      workspaceId: workspace.id,
      directory: workspace.directory,
      taskIdentity: workspace.taskIdentity,
      delegation: workspace.delegation,
      repositorySource: {
        connectionId: workspace.connectionId,
        connectionRevision: workspace.connectionRevision,
        repository: workspace.repository,
        baseBranch: workspace.baseBranch,
        baseOid: workspace.baseOid,
        localSource: workspace.localSource ?? null,
      },
    };
  };
  const resolve = () => {
    const checked: unknown = owners.assertCurrent();
    if (checked !== undefined) {
      void Promise.resolve(checked).catch(() => {});
      unavailable();
    }
    const lead = localWorkspace(conversationId);
    if (hash(lead.role) !== hash(originalRole)) unavailable();
    const parent = work.read(originalRole.itemId, { kind: 'conversation', id: conversationId });
    const assignment = parent.assignments.find((a) => a.role === 'lead');
    if (
      assignment?.conversation.namespace !== 'mitzo' ||
      assignment.conversation.conversationId !== conversationId ||
      (originalRole.itemKind != null && originalRole.itemKind !== parent.kind)
    )
      unavailable();
    const workerPins: Pin[] = [];
    let worker: unknown = null,
      childTitle: string | undefined;
    if (itemId !== originalRole.itemId) {
      const child = work.readDelegationTarget(conversationId, itemId, itemId);
      if (child.record.parentId !== originalRole.itemId) unavailable();
      work.assertLifecycleActive(itemId);
      let ancestor: string | null = itemId;
      const visited = new Set<string>();
      while (ancestor !== null) {
        if (visited.has(ancestor) || visited.size >= 100 || !artifacts.userUploadAllowed(ancestor))
          unavailable();
        visited.add(ancestor);
        ancestor = work.readDelegationTarget(conversationId, itemId, ancestor).record.parentId;
      }
      childTitle = child.record.summary;
      const attempt = child.work.attempts.at(-1);
      if (attempt) {
        const workerId = attempt.workerConversationId,
          taskId = attempt.executionTaskId;
        if (!workerId || !taskId || !owners.tasks) unavailable();
        const selectedWorker = localWorkspace(workerId);
        if (
          !isDeepStrictEqual(lead.repositorySource, selectedWorker.repositorySource) ||
          (lead.repositorySource &&
            (selectedWorker.delegation?.sourceConversationId !== conversationId ||
              selectedWorker.delegation.sourceWorkspaceId !== lead.workspaceId))
        )
          unavailable();
        assertTelosWorkExecutionAuthority(
          { events, tasks: owners.tasks, work: () => work },
          workerId,
          selectedWorker.account,
          taskId,
        );
        const mapping = owners.tasks.getTelosExecutionBinding(taskId),
          task = owners.tasks.get(taskId);
        if (
          !mapping ||
          !task ||
          mapping.leadConversationId !== conversationId ||
          mapping.childItemId !== itemId ||
          mapping.attemptId !== attempt.attemptId
        )
          unavailable();
        const refs = task.artifacts ?? {};
        if (Buffer.byteLength(JSON.stringify(refs)) > 512 * 1024 || Object.keys(refs).length > 1000)
          throw new TelosWorkError(
            'invalid',
            'Narrow worker output references before source review',
          );
        for (const value of Object.values(refs)) {
          if (typeof value !== 'string') continue;
          const match = /^artifact:([a-f0-9]{32})@([1-9][0-9]*)$/.exec(value);
          if (!match || !Number.isSafeInteger(Number(match[2]))) continue;
          let metadata;
          try {
            metadata = artifacts.metadataForRevision(match[1], Number(match[2]));
          } catch (error) {
            if (error instanceof Error && error.message === 'Artifact not found') continue;
            throw error;
          }
          if (
            metadata.itemId === itemId &&
            metadata.sessionId === workerId &&
            metadata.sourceKind === 'session_artifact'
          )
            workerPins.push({
              artifactId: metadata.id,
              revision: metadata.revision,
              sha256: metadata.sha256,
            });
        }
        worker = { attempt, mapping, selectedWorker, refs };
      }
    }
    const pins = Object.freeze([
      ...new Map(
        workerPins.map((p) => [`${p.artifactId}@${p.revision}`, Object.freeze(p)]),
      ).values(),
    ]);
    return {
      sha256: hash({
        pending: owners.pendingIdentity,
        conversationId,
        itemId,
        lead,
        assignment,
        worker,
      }),
      workerPins: pins,
      childTitle,
    };
  };
  const original = resolve();
  const assertCurrent = () => {
    if (resolve().sha256 !== original.sha256) unavailable();
  };
  const assertPin = (pin: Pin) => {
    assertCurrent();
    const metadata = artifacts.metadataForRevision(pin.artifactId, pin.revision);
    if (metadata.sha256 !== pin.sha256 || !artifacts.userUploadAllowed(metadata.itemId))
      unavailable();
    if (
      metadata.sessionId !== conversationId &&
      !original.workerPins.some(
        (p) =>
          p.artifactId === pin.artifactId && p.revision === pin.revision && p.sha256 === pin.sha256,
      )
    )
      unavailable();
  };
  return Object.freeze({ ...original, assertCurrent, assertPin });
}
export type NativeTelosWorkerMaterialScope = NonNullable<
  ReturnType<typeof captureNativeTelosWorkerMaterials>
>;
