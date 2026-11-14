import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, resolvePending } from '@mitzo/harness';
import { createAgentMessageApprover } from '../agent-communication-permission.js';
import { EventStore } from '../event-store.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import {
  setAuthRevocationStore,
  login,
  authenticateToken,
  revokeAuthSession,
  type AuthSession,
} from '../auth.js';
import { sessionAgentCommunicationTools } from '../agent-communication-tools.js';
import type { CodexConversationStore } from '../codex-conversation-store.js';
import { registerAgentMessageRuntime, type AgentMessageRuntime } from '../agent-message-runtime.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCredentialSdkServer, credentialSdkPermission } from '../credential-sdk-tools.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { SdkAgentMessageRuntime } from '../sdk-agent-message-runtime.js';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createInteractiveAuth } from '../interactive-auth-core.js';

const cleanups: Array<() => void> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Real operator, session, binding and receipt owners; no SDK/model/host credentials.
 * Native custody is synthetic and deliberately does not exist for the Claude peer.
 */
function fixture(
  sourceRuntime: 'codex' | 'claude-sdk' = 'codex',
  auth: AuthSession = { id: randomUUID(), expiresAt: Date.now() + 60_000 },
  peerAuth: AuthSession = auth,
  claudeProvider: 'anthropic-vertex' | 'anthropic-claude' = 'anthropic-vertex',
) {
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  cleanups.push(bindAgentLibraryTransport('operator', auth));
  const bindings = [
    {
      id: 'orchestrator',
      provider: sourceRuntime === 'codex' ? 'openai-codex' : claudeProvider,
      harness: sourceRuntime,
    },
    { id: 'claude-worker', provider: claudeProvider, harness: 'claude-sdk' },
    { id: 'codex-worker', provider: 'openai-codex', harness: 'codex' },
  ] as const;
  for (const { id, provider, harness } of bindings) {
    const binding = {
      version: 2,
      account: { accountId: id, provider, profileRevision: 'offline-profile' },
      harness: { implementation: harness },
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
        authSessionId: id === 'orchestrator' ? auth.id : peerAuth.id,
        identity: {},
        initialCommandId: `${id}-initial`,
        admit: vi.fn(async () => ({ dispatched: true })),
        retryInitial: vi.fn(async () => ({ dispatched: false })),
        close() {},
      },
    });
  }
  const native = {
    hasConversation: vi.fn((id: string) =>
      bindings.some((entry) => entry.id === id && entry.harness === 'codex'),
    ),
    readHostCustody: vi.fn((id: string) => ({
      authSessionId: id === 'orchestrator' ? auth.id : peerAuth.id,
    })),
    acceptedProviderTurnForCommand: vi.fn(() => undefined),
    steeringReceiptForRequest: vi.fn(() => undefined),
    commandStatus: vi.fn(() => undefined),
  } as unknown as CodexConversationStore;
  const approve = vi.fn<Parameters<typeof sessionAgentCommunicationTools>[0]['approve']>(
    async (input) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
  );
  const tools = sessionAgentCommunicationTools({
    toolName:
      sourceRuntime === 'claude-sdk'
        ? 'mcp__mitzo-connections__AgentCommunication'
        : 'AgentCommunication',
    events,
    native,
    registry,
    conversationId: 'orchestrator',
    session: registry.get('operator:orchestrator')!,
    assertRuntimeCurrent: async () => {},
    assertRuntimeCurrentSync() {},
    approve,
    startQueued: vi.fn(async () => {}),
  });
  const execute = (input: Record<string, unknown>) =>
    tools.execute(input, new AbortController().signal, {
      turnId: 'original-turn',
      callId: randomUUID(),
    });
  const install = (id: string, runtime: string, state: 'busy' | 'idle' | 'stopped' = 'busy') => {
    const session = registry.get(`operator:${id}`)!;
    const steer = vi.fn<AgentMessageRuntime['steer']>(async () => 'accepted');
    const enqueue = vi.fn<NonNullable<AgentMessageRuntime['enqueue']>>(async () => 'queued');
    const assertCurrent = vi.fn();
    cleanups.push(
      registerAgentMessageRuntime(session, {
        identity: session.ordinaryRuntimeOwner!.identity,
        runtime,
        assertCurrent,
        state: () => state,
        steer,
        enqueue,
      }),
    );
    return { session, steer, enqueue, assertCurrent };
  };
  return {
    events,
    registry,
    auth,
    native,
    approve,
    execute,
    tools,
    install,
    installClaude: (state: 'busy' | 'idle' | 'stopped' = 'busy') =>
      install('claude-worker', 'claude-sdk', state),
  };
}

async function signedOperator() {
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const auth = (await authenticateToken(token!))!;
  cleanups.push(() => revokeAuthSession(auth));
  return auth;
}

it('identifies unavailable sender custody separately from an inaccessible recipient', async () => {
  const f = fixture();
  vi.mocked(f.native.readHostCustody).mockReturnValue(null);
  await expect(f.execute({ operation: 'inbox', after: 0 })).rejects.toMatchObject({
    code: 'sender_custody_unavailable',
    stage: 'ownership',
  });
  expect(f.approve).not.toHaveBeenCalled();
});

it('does not mistake a live isolated-realm owner for primary-operator login provenance', async () => {
  const source = await signedOperator();
  const isolated = createInteractiveAuth({
    passphrase: process.env.AUTH_PASSPHRASE!,
    secret: process.env.AUTH_SECRET!,
    maxAgeHours: 1,
    cookieName: 'isolated_auth',
    realm: { issuer: 'separate-operator', audience: 'separate-operator' },
  });
  const token = await isolated.login(process.env.AUTH_PASSPHRASE!);
  const peer = (await isolated.authenticateToken(token!))!;
  cleanups.push(() => isolated.revokeAuthSession(peer));
  const f = fixture('codex', source, peer);
  const target = f.install('codex-worker', 'codex');
  expect(await f.execute({ operation: 'list', offset: 0 })).toMatchObject({ chats: [] });
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'codex-worker',
      text: 'Must remain isolated.',
    }),
  ).rejects.toMatchObject({ code: 'recipient_unavailable', stage: 'ownership' });
  expect(f.approve).not.toHaveBeenCalled();
  expect(target.steer).not.toHaveBeenCalled();
});

it('reuses only the original peer grant for a correlated reply across verified logins', async () => {
  const auth = await signedOperator(),
    peer = await signedOperator();
  const f = fixture('codex', auth, peer);
  const origin = f.registry.get('operator:orchestrator')!;
  origin.sessionAllowList.add(`agent-communication:adapters-v1:${auth.id}:orchestrator`);
  const message = f.events.agentCommunication.reserve(
    'orchestrator',
    auth.id,
    { turnId: 'origin', callId: 'send' },
    {
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Report milestones.',
    },
  );
  const recipient = f.registry.get('operator:claude-worker')!;
  const prompt = vi.fn();
  recipient.transport.send = prompt;
  const approve = createAgentMessageApprover({
    events: f.events,
    registry: f.registry,
    conversationId: 'claude-worker',
    assertCurrent() {},
  });
  const decision = await approve(
    {
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'orchestrator',
      replyTo: message.messageId,
      text: 'Milestone evidence.',
    },
    new AbortController().signal,
  );
  expect(decision.behavior).toBe('allow');
  expect(prompt).not.toHaveBeenCalled();
  origin.sessionAllowList.clear();
  expect(() => decision.assertCurrent()).toThrow(/permission changed/);
});

it.each(['codex', 'claude-sdk'] as const)(
  'discovers and messages owned peers across verified logins from %s without changing custody',
  async (engine) => {
    const source = await signedOperator();
    const peer = await signedOperator();
    const f = fixture(engine, source, peer);
    const adapter = f.install('codex-worker', 'codex');
    const before = f.native.readHostCustody(
      'codex-worker',
      f.events.getSession('codex-worker')!.accountBinding!,
    );
    expect(await f.execute({ operation: 'list', offset: 0 })).toMatchObject({
      chats: expect.arrayContaining([expect.objectContaining({ conversationId: 'codex-worker' })]),
    });
    const sent = await f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'codex-worker',
      text: 'Report the current milestone.',
    });
    expect(sent).toMatchObject({ status: 'delivered' });
    expect(adapter.steer).toHaveBeenCalledTimes(1);
    expect(
      f.native.readHostCustody(
        'codex-worker',
        f.events.getSession('codex-worker')!.accountBinding!,
      ),
    ).toEqual(before);
  },
);

it('recognizes its own retained custody after an authorized login change, but denies an unverified operator', async () => {
  const auth = await signedOperator();
  const f = fixture('codex', auth);
  vi.mocked(f.native.readHostCustody).mockReturnValue({
    authSessionId: 'original-creating-login',
  } as never);
  expect(await f.execute({ operation: 'inbox', after: 0 })).toMatchObject({ messages: [] });
  const foreign = fixture(
    'codex',
    { id: 'unverified-other-operator', expiresAt: Date.now() + 60_000 },
    auth,
  );
  foreign.install('codex-worker', 'codex');
  await expect(
    foreign.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'codex-worker',
      text: 'Denied.',
    }),
  ).rejects.toMatchObject({ code: 'recipient_unavailable', stage: 'ownership' });
  expect(foreign.approve).not.toHaveBeenCalled();
});

it('keeps SDK input and ACK receipts correlated across separately authenticated operator logins', async () => {
  const auth = await signedOperator();
  const peer = await signedOperator();
  const f = fixture('codex', auth, peer);
  const session = f.registry.get('operator:claude-worker')!;
  let input: SDKUserMessage | undefined;
  const sdk = new SdkAgentMessageRuntime({
    events: f.events,
    session,
    identity: session.ordinaryRuntimeOwner!.identity,
    operatorAuthSessionId: peer.id,
    assertCurrent() {},
    activeCommandId: () => 'active',
    stopped: () => false,
    push: (value) => {
      input = value;
    },
    enqueue: async () => {},
  });
  cleanups.push(registerAgentMessageRuntime(session, sdk));
  const sent = (await f.execute({
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: 'claude-worker',
    text: 'Milestone report.',
  })) as { messageId: string };
  expect(input).toBeDefined();
  expect(sdk.beforeInput(input!)).toBe(true);
  expect(sdk.observe({ type: 'user', uuid: sent.messageId, message: input!.message })).toBe(true);
  expect(f.events.agentCommunication.read('orchestrator', sent.messageId)).toMatchObject({
    status: 'delivered',
  });
  revokeAuthSession(auth);
  await expect(f.execute({ operation: 'list', offset: 0 })).rejects.toThrow();
});

it('shows an owned live Claude worker with an explicit delivery capability instead of silently omitting it', async () => {
  const f = fixture();
  const result = await f.execute({ operation: 'list', offset: 0 });
  expect(result).toMatchObject({
    chats: expect.arrayContaining([
      expect.objectContaining({
        conversationId: 'claude-worker',
        capability: expect.objectContaining({ runtime: 'claude-sdk' }),
      }),
    ]),
  });
  expect(f.approve).not.toHaveBeenCalled();
});

it.each([
  ['claude-worker', 'anthropic-vertex'],
  ['codex-worker', 'anthropic-vertex'],
  ['claude-worker', 'anthropic-claude'],
  ['codex-worker', 'anthropic-claude'],
] as const)(
  'routes an explicit SDK profile and restricted skill through MCP to %s from %s',
  async (recipient, provider) => {
    const f = fixture('claude-sdk', undefined, undefined, provider);
    const source = f.registry.get('operator:orchestrator')!;
    const name = 'mcp__mitzo-connections__AgentCommunication';
    const definition = {
      name: 'Steering owner',
      role: 'agent',
      instructions: 'Coordinate owned peers.',
      expectedOutput: 'Receipts',
      acceptanceCriteria: ['Exact authority'],
      modelPolicyRole: 'agent',
      tools: [{ id: 'mitzo:AgentCommunication', version: 1 }],
    } as const;
    expect(() => assertAgentToolRoute(definition as never, 'claude-sdk')).not.toThrow();
    bindAgentToolSelection(source, definition as never, 'claude-sdk');
    source.activeSkillPolicy = new Set([name]);
    source.sessionAllowList.add(`agent-communication:adapters-v1:${f.auth.id}:orchestrator`);
    f.approve.mockImplementation(
      createAgentMessageApprover({
        events: f.events,
        registry: f.registry,
        conversationId: 'orchestrator',
        toolName: name,
        assertCurrent() {},
      }),
    );
    let sdkInput: SDKUserMessage | undefined;
    const recipientSession = f.registry.get(`operator:${recipient}`)!;
    const sdkAdapter =
      recipient === 'claude-worker'
        ? new SdkAgentMessageRuntime({
            events: f.events,
            session: recipientSession,
            identity: recipientSession.ordinaryRuntimeOwner!.identity,
            operatorAuthSessionId: f.auth.id,
            assertCurrent() {},
            activeCommandId: () => 'original-recipient-command',
            stopped: () => false,
            push: (input) => {
              sdkInput = input;
            },
            enqueue: async () => {
              throw Error('Busy SDK steering cannot queue');
            },
          })
        : undefined;
    const target = sdkAdapter
      ? { steer: vi.spyOn(sdkAdapter, 'steer') }
      : f.install(recipient, 'codex');
    if (sdkAdapter) cleanups.push(registerAgentMessageRuntime(recipientSession, sdkAdapter));
    const server = createCredentialSdkServer(() => 'orchestrator', source, f.registry, {
      profilesOnly: true,
      assertCurrent: async () => {},
      assertCurrentSync() {},
      agentCommunication: () => f.tools,
    });
    const client = new Client({ name: 'ordinary-sdk-peer-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'AgentCommunication',
      ]);
      expect(
        credentialSdkPermission(
          name,
          { operation: 'list' },
          'operator:orchestrator',
          f.registry,
          source,
        ),
      ).toMatchObject({ behavior: 'allow' });
      const listed = await client.callTool({
        name: 'AgentCommunication',
        arguments: { operation: 'list', offset: 0 },
      });
      expect(listed.isError).not.toBe(true);
      const sendInput = {
        operation: 'send',
        requestId: randomUUID(),
        recipientConversationId: recipient,
        text: 'Retain your original command.',
      };
      const result = await client.callTool({
        name: 'AgentCommunication',
        arguments: sendInput,
      });
      expect(result.isError).not.toBe(true);
      expect(target.steer).toHaveBeenCalledOnce();
      if (sdkAdapter) {
        const receipt = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(receipt.status).toBe('uncertain');
        expect(sdkInput).toMatchObject({ priority: 'now', uuid: receipt.messageId });
        expect(sdkAdapter.beforeInput(sdkInput!)).toBe(true);
        expect(
          sdkAdapter.observe({ type: 'user', uuid: sdkInput!.uuid, message: sdkInput!.message }),
        ).toBe(true);
        expect(f.events.agentCommunication.read('orchestrator', receipt.messageId).status).toBe(
          'delivered',
        );
      }
      const receipt = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      for (const arguments_ of [
        sendInput,
        { operation: 'lookup', requestId: sendInput.requestId },
        { operation: 'read', messageId: receipt.messageId },
      ]) {
        const read = await client.callTool({ name: 'AgentCommunication', arguments: arguments_ });
        expect(read.isError).not.toBe(true);
        expect(JSON.parse((read.content as Array<{ text: string }>)[0].text)).toMatchObject({
          messageId: receipt.messageId,
          status: 'delivered',
        });
      }
      expect(target.steer).toHaveBeenCalledOnce();
      const waiting = client.callTool({
        name: 'AgentCommunication',
        arguments: { operation: 'wait', after: 0, timeoutMs: 1000 },
      });
      const reply = f.events.agentCommunication.reserve(
        recipient,
        f.auth.id,
        { turnId: 'fixture-reply', callId: 'fixture-reply' },
        {
          requestId: randomUUID(),
          recipientConversationId: 'orchestrator',
          text: 'Synthetic reply.',
          replyTo: receipt.messageId,
        },
      );
      const waited = await waiting;
      expect(waited.isError).not.toBe(true);
      expect(JSON.parse((waited.content as Array<{ text: string }>)[0].text)).toMatchObject({
        changed: true,
        messages: [
          expect.objectContaining({ messageId: reply.messageId, replyTo: receipt.messageId }),
        ],
      });
      const inbox = await client.callTool({
        name: 'AgentCommunication',
        arguments: { operation: 'inbox', after: 0 },
      });
      expect(inbox.isError).not.toBe(true);
      expect(JSON.parse((inbox.content as Array<{ text: string }>)[0].text).messages).toHaveLength(
        1,
      );
      f.events.hideSession(recipient);
      const unavailable = await client.callTool({
        name: 'AgentCommunication',
        arguments: { ...sendInput, requestId: randomUUID() },
      });
      expect(unavailable.isError).toBe(true);
      expect(JSON.parse((unavailable.content as Array<{ text: string }>)[0].text)).toMatchObject({
        code: 'recipient_unavailable',
        stage: 'ownership',
      });
      expect(target.steer).toHaveBeenCalledOnce();
      source.activeSkillPolicy = new Set(['AgentCommunication']);
      expect(
        credentialSdkPermission(
          name,
          { operation: 'list' },
          'operator:orchestrator',
          f.registry,
          source,
        ),
      ).toMatchObject({ behavior: 'deny' });
      expect(
        (
          await client.callTool({
            name: 'AgentCommunication',
            arguments: { operation: 'list', offset: 0 },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.instance.close();
    }
  },
);

it('refuses an unsupported runtime explicitly before approval without queueing or a false receipt', async () => {
  const f = fixture();
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Pause at your next safe boundary.',
    }),
  ).rejects.toMatchObject({ code: 'runtime_unsupported', stage: 'capability' });
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.events.agentCommunication.inbox('claude-worker').messages).toEqual([]);
  expect(
    f.registry.get('operator:claude-worker')!.ordinaryRuntimeOwner!.admit,
  ).not.toHaveBeenCalled();
});

it.each(['busy', 'idle'] as const)(
  'routes an owned Claude %s recipient through its adapter and retains the exact receipt',
  async (state) => {
    const f = fixture();
    const adapter = f.installClaude(state);
    const input = {
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Coordinate at a safe boundary.',
    };
    const result = await f.execute(input);
    expect(result).toMatchObject({ status: state === 'busy' ? 'delivered' : 'queued' });
    expect(adapter.steer).toHaveBeenCalledTimes(state === 'busy' ? 1 : 0);
    expect(adapter.enqueue).toHaveBeenCalledTimes(state === 'idle' ? 1 : 0);
    expect(await f.execute(input)).toEqual(result);
    expect(f.approve).toHaveBeenCalledTimes(1);
  },
);

it('refuses a stopped runtime without enqueueing or recovering it', async () => {
  const f = fixture();
  const adapter = f.installClaude('stopped');
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Do not resume implicitly.',
    }),
  ).rejects.toMatchObject({ code: 'recipient_stopped' });
  expect(f.approve).not.toHaveBeenCalled();
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(adapter.enqueue).not.toHaveBeenCalled();
});

it('refuses a replaced recipient owner after approval without invoking its adapter', async () => {
  const f = fixture();
  const adapter = f.installClaude();
  f.approve.mockImplementation(async (input) => {
    adapter.session.ordinaryRuntimeOwner = {
      ...adapter.session.ordinaryRuntimeOwner!,
      identity: {},
    };
    return { behavior: 'allow', updatedInput: input };
  });
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Original owner only.',
    }),
  ).rejects.toThrow();
  expect(adapter.steer).not.toHaveBeenCalled();
});

it('refuses denied approval before reserving or dispatching cross-runtime input', async () => {
  const f = fixture();
  const adapter = f.installClaude();
  f.approve.mockImplementation(async (input) => ({ behavior: 'deny', updatedInput: input }));
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Not approved.',
    }),
  ).rejects.toMatchObject({ code: 'approval_denied', stage: 'approval' });
  expect(f.events.agentCommunication.inbox('claude-worker').messages).toEqual([]);
  expect(adapter.steer).not.toHaveBeenCalled();
});
it.each([
  ['claude-worker', 1],
  ['codex-worker', 0],
] as const)(
  'does not broaden a pre-existing native-only grant when addressing %s',
  async (recipient, expectedPrompts) => {
    const f = fixture();
    const source = f.registry.get('operator:orchestrator')!;
    source.sessionAllowList.add(`agent-communication:${f.auth.id}:orchestrator`);
    const prompts: unknown[] = [];
    source.transport.send = (event) => {
      if (event.type === 'permission_request') {
        prompts.push(event);
        queueMicrotask(() =>
          resolvePending(event.permId as string, 'once', undefined, event.sessionId as string),
        );
      }
    };
    const approve = createAgentMessageApprover({
      events: f.events,
      registry: f.registry,
      conversationId: 'orchestrator',
      assertCurrent() {},
    });
    expect(
      await approve(
        {
          operation: 'send',
          requestId: randomUUID(),
          recipientConversationId: recipient,
          text: 'Keep original approval scope.',
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(prompts).toHaveLength(expectedPrompts);
  },
);
it.each([false, true])(
  'correlated SDK replies require the expanded audience grant rather than an old native-only grant (%s)',
  async (expanded) => {
    const f = fixture();
    const origin = f.registry.get('operator:orchestrator')!;
    origin.sessionAllowList.add(`agent-communication:${f.auth.id}:orchestrator`);
    if (expanded)
      origin.sessionAllowList.add(`agent-communication:adapters-v1:${f.auth.id}:orchestrator`);
    const message = f.events.agentCommunication.reserve(
      'orchestrator',
      f.auth.id,
      { turnId: 'origin-turn', callId: 'origin-call' },
      {
        requestId: randomUUID(),
        recipientConversationId: 'claude-worker',
        text: 'Original peer exchange.',
      },
    );
    const source = f.registry.get('operator:claude-worker')!;
    const prompts: unknown[] = [];
    source.transport.send = (event) => {
      if (event.type === 'permission_request') {
        prompts.push(event);
        queueMicrotask(() =>
          resolvePending(event.permId as string, 'once', undefined, event.sessionId as string),
        );
      }
    };
    const approve = createAgentMessageApprover({
      events: f.events,
      registry: f.registry,
      conversationId: 'claude-worker',
      assertCurrent() {},
    });
    expect(
      await approve(
        {
          operation: 'send',
          requestId: randomUUID(),
          recipientConversationId: 'orchestrator',
          replyTo: message.messageId,
          text: 'Explicit correlated reply.',
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ behavior: 'allow' });
    expect(prompts).toHaveLength(expanded ? 0 : 1);
  },
);
it('keeps a known revoked runtime visible as unavailable and refuses a new send with an explicit authorization diagnostic', async () => {
  const f = fixture();
  const target = f.installClaude();
  target.assertCurrent.mockImplementation(() => {
    throw Error('private target authority detail');
  });
  expect(await f.execute({ operation: 'list', offset: 0 })).toMatchObject({
    chats: expect.arrayContaining([
      expect.objectContaining({
        conversationId: 'claude-worker',
        availability: 'unavailable',
        capability: expect.objectContaining({ reason: 'runtime_authority_unavailable' }),
      }),
    ]),
  });
  await expect(
    f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'Do not dispatch after revocation.',
    }),
  ).rejects.toMatchObject({ code: 'recipient_authority_unavailable', stage: 'authorization' });
  expect(target.steer).not.toHaveBeenCalled();
});

it('never resubmits an uncertain cross-runtime message or silently falls back to queueing', async () => {
  const f = fixture();
  const adapter = f.installClaude();
  adapter.steer.mockResolvedValue('uncertain');
  const input = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: 'claude-worker',
    text: 'Original uncertain request.',
  };
  const first = await f.execute(input);
  expect(first).toMatchObject({ status: 'uncertain' });
  expect(await f.execute(input)).toEqual(first);
  expect(adapter.steer).toHaveBeenCalledOnce();
  expect(adapter.enqueue).not.toHaveBeenCalled();
  expect(f.approve).toHaveBeenCalledOnce();
});

it('does not downgrade an exact provider ACK that races idle admission completion', async () => {
  const f = fixture();
  const adapter = f.installClaude('idle');
  adapter.enqueue.mockImplementation(async (message: unknown) => {
    f.events.agentCommunication.recordForHost(
      (message as { messageId: string }).messageId,
      'delivered',
    );
    return 'queued';
  });
  expect(
    await f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: 'claude-worker',
      text: 'ACK arrives during admission.',
    }),
  ).toMatchObject({ status: 'delivered' });
});

it('refuses an expired sending operator before discovering or dispatching peer work', async () => {
  const f = fixture();
  f.auth.expiresAt = Date.now() - 1;
  await expect(f.execute({ operation: 'list', offset: 0 })).rejects.toThrow(/authentication/);
  expect(f.approve).not.toHaveBeenCalled();
});

it.each([
  ['claude-worker', 'claude-sdk'],
  ['codex-worker', 'codex'],
] as const)('routes an owned SDK sender to its %s runtime owner', async (id, runtime) => {
  const f = fixture('claude-sdk');
  const target = f.install(id, runtime);
  expect(
    await f.execute({
      operation: 'send',
      requestId: randomUUID(),
      recipientConversationId: id,
      text: 'Cross-runtime reply.',
    }),
  ).toMatchObject({ status: 'delivered' });
  expect(target.steer).toHaveBeenCalledOnce();
});

it.each(['cold', 'hidden', 'foreign'] as const)(
  'does not recover or disclose a %s peer through the shared runtime inventory',
  async (state) => {
    const f = fixture();
    const target = f.installClaude();
    if (state === 'cold') delete target.session.ordinaryRuntimeOwner;
    else if (state === 'hidden') {
      f.events.hideSession('claude-worker');
      expect(f.events.getSession('claude-worker')?.isHidden).toBe(true);
    } else
      target.session.ordinaryRuntimeOwner = {
        ...target.session.ordinaryRuntimeOwner!,
        authSessionId: 'foreign',
      };
    const listed = await f.execute({ operation: 'list', offset: 0 });
    expect(listed).toMatchObject({
      chats: expect.not.arrayContaining([
        expect.objectContaining({ conversationId: 'claude-worker' }),
      ]),
    });
    await expect(
      f.execute({
        operation: 'send',
        requestId: randomUUID(),
        recipientConversationId: 'claude-worker',
        text: 'Do not revive.',
      }),
    ).rejects.toMatchObject({ code: 'recipient_unavailable' });
    expect(target.steer).not.toHaveBeenCalled();
    expect(target.enqueue).not.toHaveBeenCalled();
  },
);
