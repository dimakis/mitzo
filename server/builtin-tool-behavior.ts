/** Reviewed built-in identities only. Configured MCP annotations and display names
 * cannot declare a call free of mutation. Keep catalog and recovery in agreement. */
const reads = new Set([
  'DiscoverLocalRepository',
  'InspectLocalRepository',
  'Read',
  'GitHubRead',
  'GoogleWorkspaceRead',
  'ListConnections',
  'GetConnectionGuide',
  'GetConnectionSetup',
  'GetSecretRelay',
  'ListRepositories',
  'GetRepositoryChatPreparation',
  'SymposiumReadProfiles',
  'AgentReadTasks',
  'TelosGetItem',
  'TelosListItems',
  'TelosSearchItems',
  'TelosFindArtifacts',
  'TelosReadArtifact',
  'ReadKnowledge',
  'SearchPastSessions',
  'ReadPastSession',
]);
const mixed = new Set([
  'TelosManageItem',
  'Bash',
  'ConnectionRequest',
  'HomeAssistantDashboard',
  'AgentCommunication',
  'SessionTimers',
]);
export function builtinToolBehavior(name: string) {
  return name === 'AskUserQuestion'
    ? ('interaction' as const)
    : reads.has(name)
      ? ('read' as const)
      : mixed.has(name)
        ? ('mixed' as const)
        : ('write' as const);
}

/** Operation-qualified reads only; a mixed tool's other operations stay unknown.
 * This also qualifies old read receipts which predate durable callback outcomes. */
export function isReadOnlyBuiltinToolCall(name: string, input: Record<string, unknown>): boolean {
  if (reads.has(name)) return true;
  if (
    ['SearchSkills', 'ReadToolOutput', 'ListIntegrationTools', 'DescribeIntegrationTool'].includes(
      name,
    )
  )
    return true;
  if (name === 'RequestWebAccess') return input.operation === 'fetch';
  if (name === 'SessionTimers')
    return ['list', 'sessions', 'read', 'delivery'].includes(String(input.operation));
  if (name === 'ConnectionRequest') return input.method === 'GET' || input.method === 'HEAD';
  if (name === 'TelosManageItem') return input.operation === 'read';
  return false;
}
