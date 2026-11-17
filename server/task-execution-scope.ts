import { createHash } from 'node:crypto';
import { nativeCommandDirectoryScope } from './codex-native-grant-fence.js';
import type { ManagedSession } from '@mitzo/harness';
import type { TaskExecutionGrant } from './task-execution-store.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function assertTaskOperator(session: ManagedSession, operatorId: string): void {
  if (
    (session.ordinaryRuntimeOwner && session.ordinaryRuntimeOwner.authSessionId !== operatorId) ||
    (session.ownedLocalAuthSessionId && session.ownedLocalAuthSessionId !== operatorId)
  )
    throw Error('Task execution operator does not own this runtime');
}

export function memberScope(sessionId: string, session: ManagedSession) {
  if (!session.cwd) throw Error('Task execution requires a writable registered task workspace');
  const roots = [
    ...new Set([session.cwd, ...[...session.worktreePaths.values()].map((entry) => entry.path)]),
  ].sort();
  const identities = roots.map((path) => {
    const identity = nativeCommandDirectoryScope(path, path);
    if (path === '/' || !identity || identity[0]?.[1] === null)
      throw Error('Task workspace must be a canonical physical task directory');
    return identity;
  });
  return {
    sessionId,
    roots,
    account: session.accountBinding
      ? {
          accountId: session.accountBinding.accountId,
          accountLabel: session.accountBinding.accountLabel,
          provider: session.accountBinding.provider,
          model: session.accountBinding.model,
          profileRevision: session.accountBinding.profileRevision,
        }
      : null,
    fingerprint: hash([
      identities,
      session.accountBinding ?? null,
      session.ordinaryRuntimeOwner?.location ?? 'local',
      session.wtId ?? null,
      [...session.worktreePaths].sort(([a], [b]) => a.localeCompare(b)),
    ]),
  };
}
/**
 * Named GitHub repositories with no local task root in this session. Disclosure
 * only: it never adds roots and stays out of the member scope fingerprint.
 */
export function repositoriesWithoutLocalRoot(
  repositories: readonly string[],
  session: Pick<ManagedSession, 'worktreePaths'>,
): string[] {
  const local = new Set([...session.worktreePaths.keys()].map((name) => name.toLowerCase()));
  return repositories.filter((repository) => {
    const full = repository.toLowerCase();
    return !local.has(full) && !local.has(full.slice(full.indexOf('/') + 1));
  });
}

export const publicGrant = (
  grant: TaskExecutionGrant,
  session: Pick<ManagedSession, 'worktreePaths'>,
) => ({
  id: grant.id,
  title: grant.title,
  network: grant.network,
  repositories: grant.repositories,
  repositoriesWithoutLocalRoot: repositoriesWithoutLocalRoot(grant.repositories, session),
  expiresAt: grant.expiresAt,
  members: grant.members.map(({ sessionId, roots, account }) => ({ sessionId, roots, account })),
  executionLocation: 'host',
});
