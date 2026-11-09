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
  'TaskExecution',
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
  if (name === 'TaskExecution')
    return input.operation === 'status' || input.operation === 'github_read';
  if (name === 'ConnectionRequest') return input.method === 'GET' || input.method === 'HEAD';
  if (name === 'TelosManageItem') return input.operation === 'read';
  return false;
}

/** Historical unknown results need a stronger contract than HTTP GET/HEAD.
 * Generic web/connection requests may target side-effecting endpoints. These
 * reviewed built-ins only inspect repository metadata, files or tool definitions. */
export function isIntrinsicRecoveryRead(name: string): boolean {
  return [
    'GitHubRead',
    'DiscoverLocalRepository',
    'InspectLocalRepository',
    'DescribeIntegrationTool',
    'Read',
  ].includes(name);
}
