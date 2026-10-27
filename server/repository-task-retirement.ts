import { isAbsolute, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspace } from './repository-workspaces.js';

/** Current app owner evidence, additional to the repository's exclusive durable
 * retirement lease. Neither hidden chats nor absent processes establish it. */
export function assertRepositoryTaskRetirement(
  record: Readonly<RepositoryWorkspace>,
  owners: {
    events: Pick<
      EventStore,
      | 'getSession'
      | 'assertNoOtherWorkspaceReferences'
      | 'getSessionRuntimeBinding'
      | 'hasUncertainOrdinaryCommand'
      | 'getEventsOfType'
      | 'getPendingOrdinaryLocalVertexCommandIds'
    >;
    registry: Pick<SessionRegistry, 'findBySessionId'>;
    assertNativeStopped(record: Readonly<RepositoryWorkspace>): void;
    protectedDirectories: readonly string[];
  },
): void {
  const unavailable = () =>
    Error('Stop and reconcile this local task before retiring or restoring its workspace');
  const id = record.conversationId,
    directory = record.directory;
  if (!id || !directory || !record.taskIdentity || record.taskIdentity.directory !== directory)
    throw unavailable();
  const meta = owners.events.getSession(id),
    runtime = owners.events.getSessionRuntimeBinding(id);
  if (
    !meta ||
    meta.cwd !== directory ||
    meta.repositoryWorkspaceId !== record.id ||
    !isDeepStrictEqual(meta.accountBinding, record.binding) ||
    meta.isActive ||
    meta.executionPhase !== 'TERMINAL' ||
    meta.sessionType === 'symposium' ||
    meta.symposiumConfig ||
    owners.registry.findBySessionId(id) ||
    runtime?.execution.location !== 'local' ||
    owners.events.hasUncertainOrdinaryCommand(id) ||
    owners.events
      .getEventsOfType(id, 'workspace_retention')
      .some((event) => event.payload.policy === 'external-owner')
  )
    throw unavailable();
  owners.events.assertNoOtherWorkspaceReferences(id, directory);
  for (const protectedDirectory of owners.protectedDirectories) {
    const child = relative(directory, protectedDirectory);
    if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) throw unavailable();
  }
  if (runtime.harness.implementation === 'codex') owners.assertNativeStopped(record);
  else if (runtime.harness.implementation === 'claude-sdk') {
    if (owners.events.getPendingOrdinaryLocalVertexCommandIds(id).length) throw unavailable();
  } else throw unavailable();
}
