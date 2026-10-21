import type {
  AgentToolCatalogEntry,
  AgentToolReference,
  SymposiumProfileDefinition,
} from '@mitzo/protocol';
import { connectCodexMcpTools, type McpToolsOptions } from './codex-mcp-tools.js';
import type { McpServerConfig } from './mcp-config.js';
import { TASK_MCP_SERVER_NAME } from './host-mcp-servers.js';
import { telosWorkerTaskDefinitions } from './telos-worker-task-tools.js';

/** Portable selection names for the original scoped task-server operations. No grants. */
export function taskMcpToolCatalog(): AgentToolCatalogEntry[] {
  return telosWorkerTaskDefinitions.map((tool) => {
    const name = tool.name.slice(`mcp__${TASK_MCP_SERVER_NAME}__`.length);
    return {
      id: `mitzo:${name}`,
      version: 1,
      name,
      description: tool.description,
      source: 'Task Board',
      required: false,
      behavior: name === 'TaskStatus' ? 'read' : 'write',
      routes: ['codex-owned-local'],
      requirement:
        'Requires a current delegated task and tool approval. Selection grants no task access or completion authority.',
    };
  });
}
export function selectedTaskMcpReferences(
  definition?: SymposiumProfileDefinition,
): AgentToolReference[] {
  const catalog = taskMcpToolCatalog();
  return (
    definition?.tools?.filter((ref) =>
      catalog.some((entry) => entry.id === ref.id && entry.version === ref.version),
    ) ?? []
  );
}

/** Only the host-created server with the exact original client/session/task scope is eligible. */
export async function connectSelectedTaskMcpTools(
  refs: AgentToolReference[],
  configs: Record<string, McpServerConfig>,
  scope: { clientId: string; sessionId: string; taskId: string },
  options: McpToolsOptions,
) {
  const config = configs[TASK_MCP_SERVER_NAME];
  const args = config?.args ?? [];
  const matches = (flag: string, value: string) =>
    !!value &&
    args.filter((arg) => arg === flag).length === 1 &&
    args[args.indexOf(flag) + 1] === value;
  const catalog = taskMcpToolCatalog();
  if (
    !refs.length ||
    refs.some(
      (ref) => !catalog.some((entry) => entry.id === ref.id && entry.version === ref.version),
    ) ||
    !config ||
    config.librarySourceId ||
    config.execution === 'sandbox' ||
    !matches('--client-id', scope.clientId) ||
    !matches('--session-id', scope.sessionId) ||
    !matches('--task-id', scope.taskId)
  )
    throw Error('Selected task tools require the original scoped host task server');
  const peer = await connectCodexMcpTools({ [TASK_MCP_SERVER_NAME]: config }, options);
  try {
    options.assertRuntimeCurrent?.();
    options.signal.throwIfAborted();
    const admitted = refs.map((reference) => {
      const name = catalog.find((entry) => entry.id === reference.id)!.name;
      const tool = peer.discovered.find(
        (tool) => tool.server === TASK_MCP_SERVER_NAME && tool.tool === name,
      );
      if (!tool) throw Error('Selected task operation is unavailable on the original task server');
      return { wireName: tool.definition.name, reference };
    });
    const names = new Set(admitted.map((entry) => entry.wireName));
    return {
      ...peer,
      admitted,
      definitions: peer.definitions.filter((tool) => names.has(tool.name)),
      execute: (...args: Parameters<typeof peer.execute>) => {
        if (!names.has(args[0])) throw Error('Task tool is not selected');
        options.assertRuntimeCurrent?.();
        return peer.execute(...args);
      },
    };
  } catch (error) {
    await peer.close();
    throw error;
  }
}

type McpPeer = Pick<
  Awaited<ReturnType<typeof connectCodexMcpTools>>,
  'definitions' | 'displayName' | 'execute' | 'close'
>;
/** Keep each original peer's executor, permission, cancellation and close owners. */
export function combineMcpToolPeers(primary: McpPeer, task: McpPeer): McpPeer {
  const owners = new Map<string, McpPeer>();
  for (const peer of [primary, task])
    for (const tool of peer.definitions) {
      if (owners.has(tool.name)) throw Error('Duplicate selected MCP tool identity');
      owners.set(tool.name, peer);
    }
  return {
    definitions: [...primary.definitions, ...task.definitions],
    displayName: (name) => owners.get(name)?.displayName(name) ?? name,
    close: async () => {
      await Promise.allSettled([primary.close(), task.close()]);
    },
    execute: (...args) => {
      const owner = owners.get(args[0]);
      if (!owner) throw Error('MCP tool is not selected');
      return owner.execute(...args);
    },
  };
}
