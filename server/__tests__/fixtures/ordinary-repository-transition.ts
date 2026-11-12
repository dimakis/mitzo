import { randomUUID } from 'node:crypto';
import type { EventStore } from '../../event-store.js';

/** SQL transition fixture only: no native, physical custody or model authority. */
export function ordinaryRepositoryTransition(
  store: EventStore,
  sessionId: string,
  sourceCommandId: string,
  queued: string[] = [],
  priorPrimaryCommandId?: string,
) {
  const current = store.getSession(sessionId)!;
  const transition = {
    version: 1 as const,
    preparationId: randomUUID(),
    runtimeId: 'runtime',
    ...(priorPrimaryCommandId ? { priorPrimaryCommandId } : {}),
    source: {
      commandId: sourceCommandId,
      attempt: 1,
      threadId: 'thread',
      turnId: 'turn',
      generation: 0,
      callId: randomUUID(),
      requestHash: 'a'.repeat(64),
      resultSha256: 'b'.repeat(64),
    },
    oldWorkspace: {
      kind: 'repository' as const,
      id: current.repositoryWorkspaceId!,
      directory: current.cwd!,
    },
    newWorkspace: {
      kind: 'repository' as const,
      id: randomUUID(),
      directory: `/offline/${randomUUID()}`,
      featureBranch: 'mitzo/branch',
      baseOid: 'c'.repeat(40),
      taskIdentitySha256: 'd'.repeat(64),
    },
    consumedScopeSha256: 'e'.repeat(64),
    materializedRecordSha256: 'f'.repeat(64),
  };
  const child = store.reservePreparedRepositoryContinuation(sessionId, transition);
  store.commitPreparedRepositoryContinuation(sessionId, child.childCommandId, transition);
  store.rebindPreparedRepositoryQueuedCommands(sessionId, child.childCommandId, transition, queued);
  store.finalizePreparedRepositoryContinuation(
    sessionId,
    child.childCommandId,
    transition,
    () => {},
  );
  return child.childCommandId;
}
