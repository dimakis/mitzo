import './fixtures/offline-user-home.js';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { createCredentialSdkServer } from '../credential-sdk-tools.js';
import { createTelosSdkServer } from '../telos-sdk-tools.js';
import { createWebAccessSdkServer } from '../web-access-sdk.js';
import { credentialConnectionToolDefinitions } from '../credential-connection-tools.js';
import { repositoryChatToolDefinitions } from '../repository-chat-tools.js';
import { profileToolDefinitions } from '../session-profile-tools.js';
import { knowledgeToolDefinitions } from '../session-knowledge-tools.js';
import { learningToolDefinitions } from '../session-learning-tools.js';
import { sessionPromptDefinitions } from '../session-prompt-definitions.js';
import { sessionLaunchDefinitions } from '../session-launch-tools.js';
import { sessionHistoryToolDefinitions } from '../session-history-tools.js';
import { agentTaskToolDefinitions } from '../session-agent-task-tools.js';
import { agentCommunicationDefinitions } from '../agent-communication-tools.js';
import { googleWorkspaceReadDefinition } from '../google-workspace-read.js';
import { telosSdkDefinitions } from '../telos-sdk-definitions.js';
import { webAccessDefinition } from '../request-web-access.js';
import { githubPublishingDefinition } from '../github-publishing-tool.js';
import { setConnectionsRuntime } from '../connections-runtime.js';
import { GoogleWorkspaceManagement } from '../google-workspace-management.js';
import { googleReadFixture } from './fixtures/google-workspace-read.js';
import { localEfficiencyToolDefinitions } from '../local-agent-efficiency.js';
import { localRepositoryToolDefinitions } from '../session-local-repository-tools.js';
import { localRepositoryPreparationDefinition } from '../local-repository-preparation-tool.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  setConnectionsRuntime(null);
});
// Union branches are valid JSON schemas. Check their actual argument names as
// well as ordinary object shapes; truly parameterless tools must remain empty.
function parameters(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const value = schema as Record<string, unknown>;
  const properties =
    value.properties && typeof value.properties === 'object' ? Object.keys(value.properties) : [];
  return [
    ...new Set([
      ...properties,
      ...['anyOf', 'oneOf', 'allOf'].flatMap((key) =>
        Array.isArray(value[key]) ? value[key].flatMap(parameters) : [],
      ),
    ]),
  ].sort();
}
async function list(server: McpSdkServerConfigWithInstance) {
  const client = new Client({ name: 'offline-schema-audit', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  return (await client.listTools()).tools;
}
it.each([false, true])(
  'preserves every registered helper/Telos/web tool argument through SDK tools/list, ordinary=%s',
  async (profilesOnly) => {
    const registry = new SessionRegistry();
    cleanups.push(() => registry.dispose());
    registry.register('owner', {
      sessionId: 'schema-chat',
      mode: 'auto',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
    } as never);
    const session = registry.get('owner')!;
    const events = new EventStore(':memory:');
    cleanups.push(() => events.close());
    const google = googleReadFixture();
    setConnectionsRuntime({
      googleWorkspace: new GoogleWorkspaceManagement(google.options),
    } as never);
    const boundary = { assertCurrent: async () => {}, assertCurrentSync: () => {} };
    const connections = createCredentialSdkServer(() => session.sessionId, session, registry, {
      ...boundary,
      profilesOnly,
      historyEvents: events,
      repositoryTools: {
        events,
        captureRepositoryReadOwner: () => {
          throw Error('Schema audit does not dispatch repository operations');
        },
      },
      agentCommunication: () =>
        ({
          execute: async () => {
            throw Error('Schema audit does not dispatch');
          },
        }) as never,
    });
    const telos = createTelosSdkServer({ ...boundary, session, registry, events });
    const web = createWebAccessSdkServer(
      async () => {
        throw Error('Schema audit does not dispatch');
      },
      session.abortController.signal,
      async () => {
        throw Error('Schema audit does not publish');
      },
    );
    const definitions = [
      ...credentialConnectionToolDefinitions,
      ...repositoryChatToolDefinitions,
      ...profileToolDefinitions,
      ...knowledgeToolDefinitions,
      ...learningToolDefinitions,
      ...sessionPromptDefinitions,
      ...sessionLaunchDefinitions,
      ...sessionHistoryToolDefinitions,
      ...agentTaskToolDefinitions,
      ...agentCommunicationDefinitions,
      ...localEfficiencyToolDefinitions.filter((tool) => tool.name === 'ReadToolOutput'),
      ...localRepositoryToolDefinitions,
      localRepositoryPreparationDefinition,
      googleWorkspaceReadDefinition,
      ...telosSdkDefinitions,
      webAccessDefinition,
      githubPublishingDefinition,
    ];
    const tools = [...(await list(connections)), ...(await list(telos)), ...(await list(web))];
    expect(tools.length).toBeGreaterThan(40);
    for (const tool of tools) {
      const definition = definitions.find((definition) => definition.name === tool.name);
      expect(definition, tool.name).toBeDefined();
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(parameters(tool.inputSchema), tool.name).toEqual(parameters(definition!.input_schema));
    }
    expect(parameters(tools.find((tool) => tool.name === 'ListConnections')!.inputSchema)).toEqual(
      [],
    );
  },
);
