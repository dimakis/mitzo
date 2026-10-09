import type { Connection } from './connections-store.js';

/** The account/repository scope used by both preparation and publication. */
export function githubRepositoryConnections(
  connections: readonly Connection[],
  accountId: string,
  repository: string,
) {
  return connections.filter(
    (connection) =>
      connection.templateId === 'github-readonly' &&
      connection.status === 'active' &&
      connection.desiredAccountIds.includes(accountId) &&
      Array.isArray(connection.publicConfig.allowedRepositories) &&
      connection.publicConfig.allowedRepositories.some(
        (value) => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase(),
      ),
  );
}
