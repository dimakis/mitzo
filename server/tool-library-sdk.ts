import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { AgentToolReference } from '@mitzo/protocol';
import {
  buildPermissionHandler,
  checkSkillPolicy,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { admitConfiguredTools } from './configured-tool-admission.js';
import { getConfiguredToolCatalog } from './configured-tool-runtime.js';
import type { ConfiguredToolCatalog, ConfiguredCatalogOptions } from './configured-tool-catalog.js';
import { admitApiTools } from './api-tool-execution.js';
import { getApiToolCatalog } from './api-tool-runtime.js';
import type { ApiToolCatalog } from './api-tool-catalog.js';
import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import { connectCodexMcpTools } from './codex-mcp-tools.js';
import { agentToolAllowed, bindConfiguredAgentTools } from './agent-tool-selection.js';
import { copyCallbackOutcome, type TurnCallbackRunner } from './turn-callbacks.js';
import { reportToolFailure } from './tool-failure-reporting.js';
import { codexToolResultContentItems } from './codex-tool-result.js';

const prefix = 'mcp__mitzo-tool-library__';
interface Boundary {
  assertCurrent(signal: AbortSignal): Promise<void>;
  assertCurrentSync(signal: AbortSignal): void;
  runCallback?: TurnCallbackRunner;
  checkTool?(wire: string): 'allow' | 'deny';
}

/** Transport adaptation only. Published receipts, lazy MCP launches and API requests
 * remain with their existing owners. Each SDK query gets its own callback fence. */
export async function createSdkToolLibrary(
  options: Boundary & {
    sessionId: string;
    session: ManagedSession;
    registry: SessionRegistry;
    refs?: AgentToolReference[];
    defaultMcpServers?: Record<string, McpServerConfig>;
    cwd: string;
    env: Record<string, string>;
    configured?: Pick<ConfiguredCatalogOptions, 'readSources' | 'connect'> & {
      catalog: ConfiguredToolCatalog;
    };
    apiCatalog?: ApiToolCatalog;
  },
) {
  const mcpRefs = options.refs?.filter((ref) => ref.id.startsWith('mcp:')) ?? [];
  const apiRefs = options.refs?.filter((ref) => ref.id.startsWith('api:')) ?? [];
  const defaultSources = options.refs === undefined ? (options.defaultMcpServers ?? {}) : {};
  if (!mcpRefs.length && !apiRefs.length && !Object.keys(defaultSources).length) return undefined;
  const signal = options.session.abortController.signal;
  const service = getCredentialConnectionsRuntime();
  const current = (boundary: Boundary) => {
    signal.throwIfAborted();
    options.assertCurrentSync(signal);
    boundary.assertCurrentSync(signal);
    if (options.registry.findBySessionId(options.sessionId)?.session !== options.session)
      throw Error('Original Tool Library owner unavailable');
    if (apiRefs.length && (!service || service !== getCredentialConnectionsRuntime()))
      throw Error('Original API connection runtime unavailable');
  };
  const admit = async (boundary: Boundary) => {
    current(boundary);
    const assertCurrent = () => current(boundary);
    const assertRuntimeCurrent = async () => {
      await boundary.assertCurrent(signal);
      assertCurrent();
    };
    const approve: ReturnType<typeof buildPermissionHandler> = async (name, input, opts) => {
      await assertRuntimeCurrent();
      const owner = options.registry.findBySessionId(options.sessionId)!;
      const policyName =
        name === 'RequestConnectionAccess' ? `mcp__mitzo-connections__${name}` : name;
      const result = await buildPermissionHandler(owner.clientId, options.registry)(
        policyName,
        input,
        opts,
      );
      await assertRuntimeCurrent();
      return result;
    };
    const api = apiRefs.length
      ? admitApiTools({
          catalog: options.apiCatalog ?? getApiToolCatalog(),
          service: service!,
          sessionId: options.sessionId,
          refs: apiRefs,
          assertCurrent,
          assertRuntimeCurrent,
          approve,
          stillAllowed: (name) => {
            assertCurrent();
            const owner = options.registry.findBySessionId(options.sessionId)!;
            const policyName =
              name === 'RequestConnectionAccess' ? `mcp__mitzo-connections__${name}` : name;
            return (
              (name === 'ConnectionRequest' || agentToolAllowed(options.session, name)) &&
              checkSkillPolicy(options.registry, owner.clientId, policyName) !== 'deny'
            );
          },
        })
      : undefined;
    const mcp = mcpRefs.length
      ? await admitConfiguredTools(
          options.configured?.catalog ?? getConfiguredToolCatalog(),
          mcpRefs,
          {
            cwd: options.cwd,
            env: options.env,
            signal,
            readSources: options.configured?.readSources ?? loadMcpServers,
            connect: options.configured?.connect,
            assertRuntimeCurrent: assertCurrent,
          },
        )
      : Object.keys(defaultSources).length
        ? {
            ...(await connectCodexMcpTools(defaultSources, {
              cwd: options.cwd,
              env: options.env,
              signal,
              connect: options.configured?.connect,
              assertRuntimeCurrent: assertCurrent,
            })),
            admitted: [],
          }
        : undefined;
    return {
      api,
      mcp,
      approve,
      definitions: [...(mcp?.definitions ?? []), ...(api?.definitions ?? [])],
      admitted: [...(mcp?.admitted ?? []), ...(api?.admitted ?? [])],
    };
  };
  // Explicit profiles qualify publication without a launch. Defaults use the shared
  // configured-source discovery path, just as the existing Vertex/Codex owners do.
  const initial = await admit(options);
  await initial.mcp?.close();
  const definitions = initial.definitions;
  if (options.refs !== undefined)
    bindConfiguredAgentTools(
      options.session,
      initial.admitted.flatMap((entry) => [entry, { ...entry, wireName: prefix + entry.wireName }]),
    );
  const names = new Set(definitions.map((tool) => tool.name));
  return {
    allowedTools: definitions.map((tool) => prefix + tool.name),
    handles: (wire: string) => wire.startsWith(prefix) && names.has(wire.slice(prefix.length)),
    createServer(boundary: Boundary): McpSdkServerConfigWithInstance {
      const instance = new McpServer({ name: 'mitzo-tool-library', version: '1.0.0' });
      // Keep the exact published JSON schemas; do not convert them into a second schema language.
      instance.server.registerCapabilities({ tools: {} });
      // Existing lazy admissions retain the exact named callback authority;
      // one tool's cached owner cannot lend its ceiling to another wire name.
      const admitted = new Map<string, ReturnType<typeof admit>>();
      const toolBoundary = (name: string): Boundary => {
        const assertTool = () => {
          if (boundary.checkTool && boundary.checkTool(prefix + name) !== 'allow')
            throw Error('Tool not allowed by the frozen command skill ceiling');
        };
        return {
          async assertCurrent(signal) {
            assertTool();
            await boundary.assertCurrent(signal);
            assertTool();
          },
          assertCurrentSync(signal) {
            assertTool();
            boundary.assertCurrentSync(signal);
            assertTool();
          },
        };
      };
      const tools = (name: string, authority: Boundary) => {
        let pending = admitted.get(name);
        if (!pending) {
          pending = admit(authority);
          admitted.set(name, pending);
        }
        return pending;
      };
      instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
        current(boundary);
        return {
          tools: definitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema as { type: 'object' },
          })),
        };
      });
      instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const callSignal = AbortSignal.any([signal, extra.signal]);
        return (boundary.runCallback ?? ((work) => work()))(async () => {
          const name = request.params.name;
          try {
            callSignal.throwIfAborted();
            if (!names.has(name) || !agentToolAllowed(options.session, prefix + name))
              throw Error('Tool is not selected by the published profile');
            const authority = toolBoundary(name);
            await authority.assertCurrent(callSignal);
            current(authority);
            const admitted = await tools(name, authority);
            const input = request.params.arguments ?? {};
            const result =
              (await admitted.api?.execute(name, input, callSignal)) ??
              (await admitted.mcp!.execute(
                name,
                input,
                (canonical, args, signal, grant) =>
                  admitted.approve(canonical, args, {
                    signal,
                    toolUseID: randomUUID(),
                    ...grant,
                  }),
                callSignal,
              ));
            await authority.assertCurrent(callSignal);
            current(authority);
            callSignal.throwIfAborted();
            return copyCallbackOutcome(result, {
              content: codexToolResultContentItems(result).map((item) => {
                if (item.type === 'inputText') return { type: 'text' as const, text: item.text };
                const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(item.imageUrl)!;
                return { type: 'image' as const, mimeType, data };
              }),
              isError: result.isError,
            });
          } catch (error) {
            const result = reportToolFailure(error, {
              sessionId: options.sessionId,
              tool: name,
              signal: callSignal,
            });
            return copyCallbackOutcome(result, {
              content: [{ type: 'text' as const, text: result.content }],
              isError: true,
            });
          }
        });
      });
      instance.server.onclose = () => {
        for (const pending of admitted.values())
          void pending.then(
            async (result) => {
              try {
                await result.mcp?.close();
              } catch (error) {
                reportToolFailure(error, {
                  sessionId: options.sessionId,
                  tool: 'ToolLibraryCleanup',
                  signal,
                });
              }
            },
            // Failed admission has no peer to close; its call already reported the error.
            () => undefined,
          );
      };
      return { type: 'sdk', name: 'mitzo-tool-library', instance };
    },
  };
}
