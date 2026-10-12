/** Trusted native adapter aliases for the existing Telos MCP service scope. */
const TELOS_NATIVE_TOOLS = new Set([
  'TelosCreateOutcome',
  'TelosSaveArtifact',
  'TelosFindArtifacts',
  'TelosReadArtifact',
]);

/** Both the permission cache and its UI description use this exact service identity. */
export function sessionApprovalServer(toolName: string): string | undefined {
  if (TELOS_NATIVE_TOOLS.has(toolName)) return 'telos';
  if (!toolName.startsWith('mcp__')) return undefined;
  const parts = toolName.split('__');
  return parts.length >= 3 && parts[1] ? parts[1] : undefined;
}
