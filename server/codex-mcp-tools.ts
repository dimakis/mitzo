import { createHash } from 'node:crypto';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './tracing.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@mitzo/harness';
import type { McpServerConfig } from './mcp-config.js';
import { normalizeMcpToolResult } from './codex-tool-result.js';
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
/** Bounded phase/index metadata only; provider errors can contain credentials. */
async function observeMcpStartup<T>(
  phase: 'connect' | 'list_tools',
  sourceIndex: number,
  work: () => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(`mcp.startup.${phase}`);
  span.setAttribute('mcp.source.index', sourceIndex);
  try {
    const value = await context.with(trace.setSpan(context.active(), span), work);
    span.setStatus({ code: SpanStatusCode.OK });
    return value;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
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
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const peerShutdowns = new WeakMap<Connection, Promise<void>>();
  const activePeerShutdowns = new Set<Promise<void>>();
  const closePeer = (peer: Connection): Promise<void> => {
    let pending = peerShutdowns.get(peer);
    if (!pending) {
      pending = Promise.resolve().then(() => peer.close());
      peerShutdowns.set(peer, pending);
      activePeerShutdowns.add(pending);
      const settled = () => activePeerShutdowns.delete(pending!);
      void pending.then(settled, settled);
    }
    return pending;
  };
  let cancelStartup: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancelStartup = () => reject(Error('MCP initialization cancelled'));
  });
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown) return shutdown;
    closed = true;
    cancelStartup?.();
    cancelStartup = undefined;
    lifetime.abort(Error('MCP clients closed'));
    options.signal.removeEventListener('abort', onAbort);
    shutdown = (async () => {
      await Promise.allSettled(peers.map(closePeer));
      // A pending connector can finish while shutdown awaits an acquired peer.
      // Include its real close if it arrives before this drain has completed.
      while (activePeerShutdowns.size) await Promise.allSettled([...activePeerShutdowns]);
    })();
    return shutdown;
  };
  const onAbort = () => {
    void close();
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Servers have independent transports. Merge their catalogs in configured
    // order after concurrent discovery, retaining the same wire identities.
    const wireNames = new Set<string>();
    let catalogCount = 0;
    let catalogBytes = 2; // JSON array brackets; include commas below.
    const discovery = Promise.all(
      Object.entries(configs).map(async ([server, config], sourceIndex) => {
        if (config.execution === 'sandbox') return [];
        signal.throwIfAborted();
        options.assertRuntimeCurrent?.();
        const peer = await observeMcpStartup('connect', sourceIndex, () =>
          (options.connect ?? connect)(config, {
            ...options,
            signal,
            env: config.librarySourceId ? snapshotMcpEnvironment(options.env) : options.env,
            cwd: options.cwdForSource?.(server) ?? options.cwd,
          }),
        );
        peers.push(peer);
        if (closed) {
          await closePeer(peer);
          throw new Error('MCP initialization cancelled');
        }
        signal.throwIfAborted();
        options.assertRuntimeCurrent?.();
        const catalog: Array<{
          wire: string;
          canonical: string;
          peer: Connection;
          discovery: (typeof discovered)[number];
          grant?: McpSessionGrant;
        }> = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        let pages = 0;
        do {
          signal.throwIfAborted();
          options.assertRuntimeCurrent?.();
          if (++pages > 100) throw new Error('MCP pagination limit exceeded');
          const page = await observeMcpStartup('list_tools', sourceIndex, () =>
            peer.listTools(cursor),
          );
          signal.throwIfAborted();
          options.assertRuntimeCurrent?.();
          for (const received of page.tools) {
            // A received descriptor is a snapshot. Other concurrent peers must
            // never be able to mutate its definition after the custody check.
            const tool = JSON.parse(JSON.stringify(received)) as typeof received;
            const canonical = `mcp__${server}__${tool.name}`;
            const wire = mcpWireName(
              config.librarySourceId
                ? JSON.stringify([config.librarySourceId, tool.name])
                : canonical,
            );
            if (wireNames.has(wire)) throw new Error('Duplicate MCP tool');
            wireNames.add(wire);
            const discovery = {
              server,
              tool: tool.name,
              definition: {
                name: wire,
                description: `${canonical}: ${tool.description ?? 'Configured MCP tool'}`,
                input_schema: tool.inputSchema,
              },
              descriptor: JSON.parse(JSON.stringify(tool)) as Input,
            };
            // Reserve the aggregate budget while results arrive, rather than
            // allowing each concurrent source its own full catalog allowance.
            catalogBytes += Buffer.byteLength(JSON.stringify(discovery)) + (catalogCount ? 1 : 0);
            if (catalogBytes > 1048576) throw new Error('MCP definitions too large');
            if (++catalogCount > 1000) throw new Error('MCP tool catalog too large');
            catalog.push({
              wire,
              canonical,
              peer,
              discovery,
              grant: config.librarySourceId
                ? {
                    sessionGrantKey: `configured-mcp:${JSON.stringify([config.librarySourceId, tool.name])}`,
                    sessionGrantDescription: `Session allowance covers only ${tool.name} from ${server} until the session ends.`,
                  }
                : undefined,
            });
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Repeated MCP cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        return catalog;
      }),
    );
    const catalogs = await Promise.race([discovery, interrupted]);
    cancelStartup = undefined;
    for (const catalog of catalogs) {
      for (const { wire, canonical, peer, discovery, grant } of catalog) {
        mapping.set(wire, { peer, name: discovery.tool, canonical, grant });
        definitions.push(discovery.definition);
        discovered.push(discovery);
      }
    }
    // Preserve the final bound even if a peer retained and mutated an earlier
    // schema object while another source's asynchronous discovery was pending.
    if (Buffer.byteLength(JSON.stringify(discovered)) > 1048576)
      throw new Error('MCP definitions too large');
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
      signal.throwIfAborted();
      options.assertRuntimeCurrent?.();
      if (closed) throw new Error('MCP clients closed');
      return normalizeMcpToolResult(result.content, !!result.isError);
    },
  };
}
