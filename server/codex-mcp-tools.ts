import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@mitzo/harness';
import type { McpServerConfig } from './mcp-config.js';
import {
  mcpStdioEnvironment,
  snapshotMcpEnvironment,
  type McpLaunchEnvironment,
} from './mcp-launch-environment.js';
type Input = Record<string, unknown>;
interface Connection {
  listTools(cursor?: string): Promise<{
    tools: { name: string; description?: string; inputSchema: Input }[];
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments: Input },
    signal: AbortSignal,
  ): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}
export interface McpToolsOptions {
  assertRuntimeCurrent?: () => void;
  cwd: string;
  /** Private receipt-owned launch directory for an admitted source. */
  cwdForSource?: (server: string) => string;
  env: McpLaunchEnvironment;
  signal: AbortSignal;
  connect?: (config: McpServerConfig, options: McpToolsOptions) => Promise<Connection>;
}
async function connect(config: McpServerConfig, options: McpToolsOptions): Promise<Connection> {
  options.signal.throwIfAborted();
  options.assertRuntimeCurrent?.();
  const client = new Client({ name: 'mitzo-codex', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: options.cwd,
    env: config.librarySourceId
      ? mcpStdioEnvironment(options.env, config.env)
      : ({ ...options.env, ...config.env } as Record<string, string>),
    stderr: 'pipe',
  });
  try {
    options.signal.throwIfAborted();
    options.assertRuntimeCurrent?.();
    await client.connect(transport, { signal: options.signal, timeout: 15000 });
    options.signal.throwIfAborted();
    options.assertRuntimeCurrent?.();
    transport.stderr?.on('data', () => {});
  } catch {
    await client.close().catch(() => {});
    throw new Error('MCP connection failed');
  }
  return {
    listTools: (cursor) =>
      client.listTools(cursor ? { cursor } : undefined, { signal: options.signal, timeout: 15000 }),
    callTool: async (params, signal) => {
      const result = await client.callTool(params, undefined, { signal, timeout: 60000 });
      return { content: result.content, isError: result.isError === true };
    },
    close: () => client.close(),
  };
}
interface McpSessionGrant {
  sessionGrantKey: string;
  sessionGrantDescription: string;
}
type Permission = (
  name: string,
  input: Input,
  signal: AbortSignal,
  grant?: McpSessionGrant,
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Input; message?: string }>;
function mcpWireName(canonical: string): string {
  const identity = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `mitzo_mcp_${identity}`;
}
/** Owns configured MCP clients; all calls pass the same host permission boundary as native tools. */
export async function connectCodexMcpTools(
  configs: Record<string, McpServerConfig>,
  options: McpToolsOptions,
) {
  const peers: Connection[] = [];
  const mapping = new Map<
    string,
    { peer: Connection; name: string; canonical: string; grant?: McpSessionGrant }
  >();
  const definitions: ToolDefinition[] = [];
  const discovered: {
    server: string;
    tool: string;
    definition: ToolDefinition;
    descriptor: Input;
  }[] = [];
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    shutdown = Promise.allSettled(peers.map(async (peer) => peer.close())).then(() => {});
    return shutdown;
  };
  const onAbort = () => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (const [server, config] of Object.entries(configs)) {
      if (config.execution === 'sandbox') continue;
      options.signal.throwIfAborted();
      options.assertRuntimeCurrent?.();
      const peer = await (options.connect ?? connect)(config, {
        ...options,
        env: config.librarySourceId ? snapshotMcpEnvironment(options.env) : options.env,
        cwd: options.cwdForSource?.(server) ?? options.cwd,
      });
      peers.push(peer);
      if (closed) {
        await peer.close();
        throw new Error('MCP initialization cancelled');
      }
      options.signal.throwIfAborted();
      options.assertRuntimeCurrent?.();
      let cursor: string | undefined;
      const seen = new Set<string>();
      let pages = 0;
      do {
        options.signal.throwIfAborted();
        options.assertRuntimeCurrent?.();
        if (++pages > 100) throw new Error('MCP pagination limit exceeded');
        const page = await peer.listTools(cursor);
        options.signal.throwIfAborted();
        options.assertRuntimeCurrent?.();
        for (const tool of page.tools) {
          const canonical = `mcp__${server}__${tool.name}`;
          const wire = mcpWireName(
            config.librarySourceId
              ? JSON.stringify([config.librarySourceId, tool.name])
              : canonical,
          );
          if (mapping.has(wire)) throw new Error('Duplicate MCP tool');
          mapping.set(wire, {
            peer,
            name: tool.name,
            canonical,
            grant: config.librarySourceId
              ? {
                  sessionGrantKey: `configured-mcp:${JSON.stringify([config.librarySourceId, tool.name])}`,
                  sessionGrantDescription: `Session allowance covers only ${tool.name} from ${server} until the session ends.`,
                }
              : undefined,
          });
          definitions.push({
            name: wire,
            description: `${canonical}: ${tool.description ?? 'Configured MCP tool'}`,
            input_schema: tool.inputSchema,
          });
          discovered.push({
            server,
            tool: tool.name,
            definition: definitions[definitions.length - 1],
            descriptor: JSON.parse(JSON.stringify(tool)) as Input,
          });
          if (Buffer.byteLength(JSON.stringify(discovered)) > 1048576)
            throw new Error('MCP definitions too large');
          if (definitions.length > 1000) throw new Error('MCP tool catalog too large');
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated MCP cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
    options.signal.throwIfAborted();
    options.assertRuntimeCurrent?.();
  } catch {
    await close();
    throw new Error('MCP initialization failed. Check configured servers and retry.');
  }
  return {
    definitions,
    discovered,
    displayName: (wire: string) => mapping.get(wire)?.canonical ?? wire,
    close,
    async execute(wire: string, input: Input, permission: Permission, signal: AbortSignal) {
      const tool = mapping.get(wire);
      if (!tool) throw new Error('Unknown MCP tool');
      if (closed) throw new Error('MCP clients closed');
      signal.throwIfAborted();
      // Skill policy and user-facing identity retain the existing canonical name.
      // Only retained approval scope uses the source/tool-specific grant key.
      const decision = tool.grant
        ? await permission(tool.canonical, input, signal, tool.grant)
        : await permission(tool.canonical, input, signal);
      signal.throwIfAborted();
      if (decision.behavior !== 'allow')
        return { content: decision.message || 'MCP tool permission denied', isError: true };
      options.assertRuntimeCurrent?.();
      const result = await tool.peer.callTool(
        { name: tool.name, arguments: decision.updatedInput ?? input },
        signal,
      );
      const content = Array.isArray(result.content)
        ? result.content
            .map((block) => {
              const item = block as Input;
              return item.type === 'text' && typeof item.text === 'string'
                ? item.text
                : '[Non-text MCP output unavailable in this Codex slice]';
            })
            .join('\n')
        : JSON.stringify(result.content ?? '');
      const limit = 65536;
      return {
        content:
          content.length > limit ? content.slice(0, limit) + '\n[Output truncated]' : content,
        isError: !!result.isError,
      };
    },
  };
}
