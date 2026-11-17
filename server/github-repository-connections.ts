import type { Connection } from './connections-store.js';

/** Active managed GitHub connections scoped to a repository, for any account. */
export function githubRepositoryScopedConnections(
  connections: readonly Connection[],
  repository: string,
) {
  return connections.filter(
    (connection) =>
      connection.templateId === 'github-readonly' &&
      connection.status === 'active' &&
      Array.isArray(connection.publicConfig.allowedRepositories) &&
      connection.publicConfig.allowedRepositories.some(
        (value) => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase(),
      ),
  );
}

/** The account/repository scope used by both preparation and publication. */
export function githubRepositoryConnections(
  connections: readonly Connection[],
  accountId: string,
  repository: string,
) {
  return githubRepositoryScopedConnections(connections, repository).filter((connection) =>
    connection.desiredAccountIds.includes(accountId),
  );
}
