import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@mitzo/harness';
import type { McpServerConfig } from './mcp-config.js';
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
interface Options {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  connect?: (config: McpServerConfig, options: Options) => Promise<Connection>;
}
async function connect(config: McpServerConfig, options: Options): Promise<Connection> {
  const client = new Client({ name: 'mitzo-codex', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: options.cwd,
    env: { ...options.env, ...config.env },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport, { signal: options.signal, timeout: 15000 });
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
type Permission = (
  name: string,
  input: Input,
  signal: AbortSignal,
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Input }>;
/** Owns configured MCP clients; all calls pass the same host permission boundary as native tools. */
export async function connectCodexMcpTools(
  configs: Record<string, McpServerConfig>,
  options: Options,
) {
  const peers: Connection[] = [];
  const mapping = new Map<string, { peer: Connection; name: string; canonical: string }>();
  const definitions: ToolDefinition[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    await Promise.allSettled(peers.map((p) => p.close()));
  };
  const onAbort = () => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (const [server, config] of Object.entries(configs)) {
      options.signal.throwIfAborted();
      const peer = await (options.connect ?? connect)(config, options);
      peers.push(peer);
      if (closed) {
        await peer.close();
        throw new Error('MCP initialization cancelled');
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await peer.listTools(cursor);
        for (const tool of page.tools) {
          const canonical = `mcp__${server}__${tool.name}`;
          const wire = `mitzo_mcp_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
          if (mapping.has(wire)) throw new Error('Duplicate MCP tool');
          mapping.set(wire, { peer, name: tool.name, canonical });
          definitions.push({
            name: wire,
            description: `${canonical}: ${tool.description ?? 'Configured MCP tool'}`,
            input_schema: tool.inputSchema,
          });
          if (definitions.length > 1000) throw new Error('MCP tool catalog too large');
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated MCP cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
    }
  } catch {
    await close();
    throw new Error('MCP initialization failed. Check configured servers and retry.');
  }
  return {
    definitions,
    close,
    async execute(wire: string, input: Input, permission: Permission, signal: AbortSignal) {
      const tool = mapping.get(wire);
      if (!tool) throw new Error('Unknown MCP tool');
      if (closed) throw new Error('MCP clients closed');
      signal.throwIfAborted();
      const decision = await permission(tool.canonical, input, signal);
      signal.throwIfAborted();
      if (decision.behavior !== 'allow')
        return { content: 'MCP tool permission denied', isError: true };
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
