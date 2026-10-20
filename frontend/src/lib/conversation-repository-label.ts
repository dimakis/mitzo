/** Display only. The metadata hook selects and validates the public projection;
 * repository source access and admission remain with their existing owners.
 */
export function conversationRepositoryLabel(input: {
  routeConversationId?: string;
  conversationId: string | null;
  repositoryWorkspaceId?: string;
  repositoryContext?: { workspaceId: string; repository: string };
  metadataPending: boolean;
  repoNames: readonly string[];
}): string | undefined {
  if (input.routeConversationId && input.routeConversationId !== input.conversationId)
    return undefined;
  if (input.repositoryContext) return input.repositoryContext.repository;
  if (input.repositoryWorkspaceId) return 'Unavailable';
  if (input.metadataPending) return undefined;
  return (
    [
      ...new Set(
        input.repoNames.filter(
          (name) =>
            typeof name === 'string' &&
            name.length <= 200 &&
            /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(name) &&
            !name.includes('..'),
        ),
      ),
    ].join(', ') || undefined
  );
}
