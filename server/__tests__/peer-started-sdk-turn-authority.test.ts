import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore, type AuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { sessionAgentCommunicationTools } from '../agent-communication-tools.js';
import { registerAgentMessageRuntime } from '../agent-message-runtime.js';
import { SdkAgentMessageRuntime } from '../sdk-agent-message-runtime.js';
import { createCredentialSdkServer } from '../credential-sdk-tools.js';
import { createTelosSdkServer } from '../telos-sdk-tools.js';
import { AsyncQueue } from '../async-queue.js';
import {
  createOrdinaryLocalVertexSdkQuery,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';
import type { CodexConversationStore } from '../codex-conversation-store.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn(),
}));

const cleanups: Array<() => unknown> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

/** Real sender MCP entry, AgentCommunication owner, SDK peer adapter, ordinary
 * query owner and recipient MCP/Telos servers. Only the native CLI is replaced:
 * like the real SDK, the fake connects in-process MCP servers and starts its
 * control loop while query() runs, so callbacks inherit that creation context.
 */
async function fixture() {
  const auth: AuthSession = { id: randomUUID(), expiresAt: Date.now() + 60_000 };
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  cleanups.push(bindAgentLibraryTransport('operator', auth));
  for (const id of ['orchestrator', 'claude-worker']) {
    const binding = {
      version: 2,
      account: { accountId: id, provider: 'anthropic-vertex', profileRevision: 'offline-profile' },
      harness: { implementation: 'claude-sdk' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'offline-target' },
    };
    events.createSessionWithRuntimeBinding(
      {
        sessionId: id,
        summary: id,
        mode: 'agent',
        repositoryWorkspaceId: `${id}-workspace`,
        cwd: process.cwd(),
        accountBinding: { ...binding.account, accountLabel: id, model: 'offline-model' },
      },
      binding,
    );
    registry.register(`operator:${id}`, {
      sessionId: id,
      ownerConnectionId: 'operator',
      transport: { send() {}, isOpen: () => true },
      abortController: new AbortController(),
      mode: 'agent',
      sessionAllowList: new Set(),
      ordinaryRuntimeOwner: {
        location: 'local',
        authSessionId: auth.id,
        identity: {},
        initialCommandId: `${id}-initial`,
        admit: vi.fn(async () => ({ dispatched: true })),
        retryInitial: vi.fn(async () => ({ dispatched: false })),
        close() {},
      },
    });
  }
  const native = {
    hasConversation: () => false,
    readHostCustody: () => ({ authSessionId: auth.id }),
  } as unknown as CodexConversationStore;
  const tools = (conversationId: string, approve: ReturnType<typeof vi.fn>) =>
    sessionAgentCommunicationTools({
      toolName: 'mcp__mitzo-connections__AgentCommunication',
      events,
      native,
      registry,
      conversationId,
      session: registry.get(`operator:${conversationId}`)!,
      assertRuntimeCurrent: async () => {},
      assertRuntimeCurrentSync() {},
      approve: approve as never,
      startQueued: vi.fn(async () => {}),
    });
  const allow = () =>
    vi.fn(async (input: unknown) => ({ behavior: 'allow' as const, updatedInput: input }));
  const senderApprove = allow();
  const recipientApprove = allow();
  const sender = registry.get('operator:orchestrator')!;
  const recipient = registry.get('operator:claude-worker')!;
  const senderTools = tools('orchestrator', senderApprove);
  const recipientTools = tools('claude-worker', recipientApprove);

  // Recipient ordinary authority fences, observed per server.
  const recipientConnectionsAuthority = vi.fn(async () => {});
  const recipientTelosAuthority = vi.fn(async () => {});
  const calls = new Map<object, (name: string, args: unknown) => Promise<ToolResult>>();
  vi.mocked(query).mockImplementation(({ options }) => {
    const servers = (options as Options).mcpServers as Record<string, { instance: McpServer }>;
    const clients = Object.entries(servers).map(([name, server]) => {
      const client = new Client({ name: `fake-cli-${name}`, version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      return {
        name,
        client,
        ready: Promise.all([server.instance.connect(a), client.connect(b)]),
        close: async () => {
          await client.close();
          await server.instance.close();
        },
      };
    });
    const requests = new AsyncQueue<{
      server: string;
      name: string;
      args: unknown;
      resolve(result: ToolResult): void;
    }>();
    // The native control loop starts with the query and outlives this call.
    void (async () => {
      for await (const request of requests) {
        const target = clients.find((entry) => entry.name === request.server)!;
        await target.ready;
        request.resolve(
          (await target.client.callTool({
            name: request.name,
            arguments: request.args as Record<string, unknown>,
          })) as ToolResult,
        );
      }
    })();
    const handle = { close: vi.fn() };
    cleanups.push(async () => {
      requests.close();
      for (const entry of clients) await entry.close();
    });
    calls.set(handle, (name, args) => {
      const [server, tool] = name.includes('__') ? name.split('__') : ['mitzo-connections', name];
      return new Promise((resolve) => requests.push({ server, name: tool, args, resolve }));
    });
    return handle as never;
  });

  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const owner = createOrdinaryLocalVertexSdkQuery({
    options: {},
    input: new AsyncQueue(),
    controller,
    lifetime: new SdkHookLifetime(),
    sdkSessionId: 'claude-worker',
    cwd: process.cwd(),
    authorize: async () => {},
    authorizeSync() {},
    adapt: (run) => run as never,
    settings: () => ({}),
    inputChanged() {},
    onUnsent: vi.fn(),
    mcpServers: (state) => ({
      'mitzo-connections': createCredentialSdkServer(() => 'claude-worker', recipient, registry, {
        profilesOnly: true,
        runCallback: state.runCallback,
        assertCurrent: recipientConnectionsAuthority,
        assertCurrentSync() {},
        agentCommunication: () => recipientTools,
      }),
      telos: createTelosSdkServer({
        session: recipient,
        registry,
        events,
        runCallback: state.runCallback,
        assertCurrent: recipientTelosAuthority,
        assertCurrentSync() {},
      }),
    }),
  });
  // The operator's original command owns the first native query.
  await owner.apply({ model: 'initial' } as never);
  const firstQuery = owner.firstQuery;

  // An idle recipient admits the peer message as its next ordinary command:
  // the owner replaces its native query while the sender's tool call awaits.
  let peerQuery: object | undefined;
  const adapter = new SdkAgentMessageRuntime({
    events,
    session: recipient,
    identity: recipient.ordinaryRuntimeOwner!.identity,
    operatorAuthSessionId: auth.id,
    assertCurrent() {},
    activeCommandId: () => undefined,
    stopped: () => false,
    push() {},
    enqueue: async (_message, current) => {
      current();
      await owner.apply({ model: 'peer-turn' } as never);
      current();
    },
  });
  cleanups.push(registerAgentMessageRuntime(recipient, adapter));
  // The busy sender accepts the correlated reply as steering.
  cleanups.push(
    registerAgentMessageRuntime(sender, {
      identity: sender.ordinaryRuntimeOwner!.identity,
      runtime: 'claude-sdk',
      assertCurrent() {},
      state: () => 'busy',
      steer: vi.fn(async () => 'accepted' as const),
    }),
  );

  const senderServer = createCredentialSdkServer(() => 'orchestrator', sender, registry, {
    profilesOnly: true,
    assertCurrent: async () => {},
    assertCurrentSync() {},
    agentCommunication: () => senderTools,
  });
  const senderClient = new Client({ name: 'sender-cli', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await senderServer.instance.connect(a);
  await senderClient.connect(b);
  cleanups.push(async () => {
    await senderClient.close();
    await senderServer.instance.close();
  });
  return {
    events,
    auth,
    senderApprove,
    recipientApprove,
    recipientConnectionsAuthority,
    recipientTelosAuthority,
    async send(text: string) {
      const result = (await senderClient.callTool({
        name: 'AgentCommunication',
        arguments: {
          operation: 'send',
          requestId: randomUUID(),
          recipientConversationId: 'claude-worker',
          text,
        },
      })) as ToolResult;
      peerQuery = [...calls.keys()].find((handle) => handle !== firstQuery);
      return result;
    },
    /** A tool call the native CLI makes during the peer-started turn. */
    recipientCall(name: string, args: unknown) {
      if (!peerQuery) throw Error('Peer turn has no native query');
      return calls.get(peerQuery)!(name, args);
    },
  };
}

const json = (result: ToolResult) => JSON.parse(result.content[0].text);

it('gives a peer-started SDK turn its own ordinary tool authority after the sender call settles', async () => {
  const f = await fixture();
  const sent = await f.send('Worker result is ready.');
  expect(sent.isError).not.toBe(true);
  const receipt = json(sent);
  expect(receipt).toMatchObject({ status: 'queued', recipientConversationId: 'claude-worker' });

  // Mitzo connection tools, including AgentCommunication and SendSessionMessage.
  const inbox = await f.recipientCall('AgentCommunication', { operation: 'inbox', after: 0 });
  expect(inbox.isError, inbox.content[0].text).not.toBe(true);
  expect(json(inbox).messages).toEqual([
    expect.objectContaining({ messageId: receipt.messageId, status: 'queued' }),
  ]);
  const before = f.recipientConnectionsAuthority.mock.calls.length;
  await f.recipientCall('SendSessionMessage', {
    requestId: randomUUID(),
    sessionId: 'orchestrator',
    text: 'Reached the recipient owner.',
  });
  expect(f.recipientConnectionsAuthority.mock.calls.length).toBeGreaterThan(before);

  // Telos tools use their own SDK server and the recipient's own fence.
  const telos = await f.recipientCall('telos__TelosManageItem', {
    operation: 'read',
    itemId: 'slice',
  });
  expect(f.recipientTelosAuthority).toHaveBeenCalled();
  expect(telos.content[0].text).not.toMatch(/tool_callback_retired|already settled/);

  // No more than the recipient's authority: its own send needs its own approval.
  const reply = await f.recipientCall('AgentCommunication', {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: 'orchestrator',
    text: 'Acknowledged.',
    replyTo: receipt.messageId,
  });
  expect(reply.isError, reply.content[0].text).not.toBe(true);
  expect(f.recipientApprove).toHaveBeenCalledOnce();
  expect(f.senderApprove).toHaveBeenCalledOnce();
  f.recipientApprove.mockImplementationOnce(async (input: unknown) => ({
    behavior: 'deny',
    updatedInput: input,
  }));
  const denied = await f.recipientCall('AgentCommunication', {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: 'orchestrator',
    text: 'Not approved by the recipient operator.',
  });
  expect(denied.isError).toBe(true);
  expect(json(denied)).toMatchObject({ code: 'approval_denied' });

  // The recipient's own authority still fences its tools.
  f.recipientConnectionsAuthority.mockRejectedValueOnce(Error('Recipient authority revoked'));
  const revoked = await f.recipientCall('AgentCommunication', { operation: 'inbox', after: 0 });
  expect(revoked.isError).toBe(true);
});
