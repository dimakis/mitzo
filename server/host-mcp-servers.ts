export const TASK_MCP_SERVER_NAME = 'task-board';
export const TELOS_MCP_SERVER_NAME = 'telos';

const RESERVED_HOST_MCP_SERVER_NAMES = new Set([TASK_MCP_SERVER_NAME, TELOS_MCP_SERVER_NAME]);

export function rejectReservedMcpServerCollisions<T>(servers: Record<string, T>): {
  servers: Record<string, T>;
  rejected: string[];
} {
  const accepted: Record<string, T> = {};
  const rejected: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (RESERVED_HOST_MCP_SERVER_NAMES.has(name)) {
      rejected.push(name);
    } else {
      accepted[name] = server;
    }
  }

  return { servers: accepted, rejected };
}

export function buildConfiguredMcpAllowedTools<T>(servers: Record<string, T>): string[] {
  return Object.keys(servers)
    .filter((name) => !RESERVED_HOST_MCP_SERVER_NAMES.has(name))
    .map((name) => `mcp__${name}__*`);
}
