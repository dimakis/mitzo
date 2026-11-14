import { resetOfflineUserEnvironment } from '../../server/__tests__/fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  sdkFixtureBoundary,
  sdkQueryPeer,
} from '../../server/__tests__/fixtures/sdk-query-peer.js';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Server } from 'node:http';
import { parseServerMessage, type WsMsg } from '../../packages/client/src/index.js';

const services = vi.hoisted(() => ({
  workspace: undefined as unknown,
  library: undefined as unknown,
  query: vi.fn(),
}));
vi.mock('../../server/repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
  getRepositoryWorkspaceCustody: () => services.workspace,
}));
vi.mock('../../server/agent-library-runtime.js', async (original) => ({
  ...(await original<object>()),
  getAgentLibrary: () => services.library,
}));
vi.mock('../../server/mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../../server/credential-sdk-boundary.js', () => ({
  credentialSdkBoundary: (...args: unknown[]) => sdkFixtureBoundary(...(args as [])),
  runtimeFilesystemSdkBoundary: () => undefined,
}));
vi.mock('../../server/claude-account-history.js', () => ({
  readClaudeAccountHistory: async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained' }],
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: services.query,
  getSessionInfo: async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  }),
  getSessionMessages: async () => [{ type: 'user', uuid: 'retained' }],
}));
vi.mock('../../server/keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    async read() {
      return {
        value: 'synthetic-key',
        version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
        managed: true,
      };
    }
  },
}));
vi.mock('../../server/account-use-store.js', () => ({
  getAccountUseStore: () => ({ record() {} }),
}));

const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(resetOfflineUserEnvironment);
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  services.query.mockReset();
});

it.each([
  { name: 'Vertex', personal: false, managed: false, anthropicApi: false },
  { name: 'configured personal subscription', personal: true, managed: false, anthropicApi: false },
  { name: 'managed personal subscription', personal: true, managed: true, anthropicApi: false },
  { name: 'Anthropic Messages API', personal: false, managed: false, anthropicApi: true },
])(
  'two signed clients share the original $name conversation through the public transport and admission owners',
  async (account) => {
    vi.resetModules();
    const { ownedVertexRuntimeFixture } =
      await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, { ...account, chatRoute: true });
    services.workspace = f.workspace;
    services.library = f.library;
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    if (account.personal) {
      const { ClaudeSubscriptionCustody } =
        await import('../../server/claude-subscription-custody.js');
      const capture = ClaudeSubscriptionCustody.capture;
      vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
        capture(env, f.personalExecutable),
      );
      vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    }
    const inputs: string[] = [];
    const queries: Options[] = [];
    let finish: (() => void) | undefined;
    let hold = true;
    const interrupt = vi.fn(async () => {});
    services.query.mockImplementation((request) => {
      queries.push(request.options);
      const sessionId = request.options.sessionId ?? request.options.resume;
      const stream = async function* () {
        for await (const input of request.prompt as AsyncIterable<
          SDKUserMessage & { mitzoMessageId: string }
        >) {
          inputs.push(input.mitzoMessageId);
          yield { ...input, uuid: `input-${input.mitzoMessageId}`, session_id: sessionId };
          if (hold)
            await new Promise<void>((resolve) => {
              finish = resolve;
              request.options.abortController.signal.addEventListener('abort', resolve, {
                once: true,
              });
            });
          yield { type: 'result', session_id: sessionId, is_error: false };
        }
      };
      return Object.assign(sdkQueryPeer(request, stream()), {
        accountInfo: async () => ({
          email: 'person@example.test',
          subscriptionType: 'max',
          apiProvider: 'firstParty',
        }),
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        interrupt,
      });
    });
    const chat = await import('../../server/chat.js');
    const auth = await import('../../server/auth.js');
    const { app, taskStore } = await import('../../server/app.js');
    auth.setAuthRevocationStore(chat.eventStore);
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const connections = new ConnectionRegistry();
    chat.setConnectionRegistry(connections);
    const { SessionSseRegistry } = await import('../../server/session-sse-registry.js');
    const streams = new SessionSseRegistry();
    const { mountApplicationChatTransport } = await import('../../server/chat-rest-handler.js');
    mountApplicationChatTransport(app, streams, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
    } as import('../../server/ws-handler-v2.js').V2HandlerContext);
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Private offline listener required');
    const origin = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
      hold = false;
      finish?.();
      chat.registry
        .findBySessionId(f.reservation.conversationId)
        ?.session.ordinaryRuntimeOwner?.close();
      await vi.waitFor(() =>
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
      );
      streams.destroy();
      connections.dispose();
      chat.setConnectionRegistry(null);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      taskStore.close();
      chat.eventStore.close();
    });
    async function client(token?: string) {
      token ??= (await auth.login(process.env.AUTH_PASSPHRASE!))!;
      const actor = (await auth.authenticateToken(token))!;
      const controller = new AbortController();
      const response = await fetch(`${origin}/api/chat/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const events: Record<string, unknown>[] = [];
      const reader = response.body!.getReader();
      const pump = (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice(6)));
          }
        }
      })().catch((error: Error) => {
        if (!controller.signal.aborted) throw error;
      });
      cleanups.push(async () => {
        controller.abort();
        await pump;
      });
      await vi.waitFor(() => expect(events.some((event) => event.type === 'welcome')).toBe(true));
      const connectionId = events.find((event) => event.type === 'welcome')!.connectionId as string;
      const post = async (path: string, body: object, overrideToken = token!) => {
        const response = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${overrideToken}`,
            'Content-Type': 'application/json',
            'X-Connection-ID': connectionId,
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      return { token, actor, controller, events, connectionId, post };
    }
    const desktop = await client();
    const id = f.reservation.conversationId;
    const wire = { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id };
    expect(await desktop.post('/api/chat/runtime/send', wire)).toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const retained = chat.registry.findBySessionId(id)!;
    const custody = chat.eventStore.getOrdinaryLocalVertexCustody(id)!;
    const initial = chat.eventStore.getSession(id)!;
    expect(custody.authSessionId).toBe(desktop.actor.id);
    const mobile = await client();
    expect(mobile.actor.id).not.toBe(desktop.actor.id);
    expect(
      await mobile.post('/api/chat/switch', { type: 'switch_session', sessionId: id }),
    ).toMatchObject({ status: 200 });
    await vi.waitFor(() =>
      expect(mobile.events).toContainEqual(
        expect.objectContaining({ type: 'session_switched', sessionId: id }),
      ),
    );
    expect(mobile.events.filter((event) => event.type === 'error')).toEqual([]);
    expect(chat.registry.findBySessionId(id)?.session).toBe(retained.session);
    expect(retained.session.ownerConnectionId).toBe(desktop.connectionId);
    expect(queries).toHaveLength(1);
    expect(inputs).toEqual([wire.clientMsgId]);
    const parsed = mobile.events.map((event) =>
      parseServerMessage(
        event as WsMsg,
        { currentSessionId: id },
        { onSessionAssigned() {}, onSessionExpired() {} },
        id,
      ),
    );
    expect(
      parsed.flatMap((result) => result.messagesActions).some((action) => action.type === 'ERROR'),
    ).toBe(false);
    // Opening and navigating never command a second provider query or move execution.
    await mobile.post('/api/chat/switch', { type: 'switch_session', sessionId: null });
    await mobile.post('/api/chat/switch', { type: 'switch_session', sessionId: id });
    const { registerPending, hasPending } = await import('../../server/permissions.js');
    const decide = vi.fn();
    const permId = `approval-${id}`;
    registerPending(permId, 'Bash', decide, { command: 'pwd' }, undefined, id);
    cleanups.push(async () => {
      (await import('../../server/permissions.js')).removePending(permId);
    });
    expect(
      await mobile.post('/api/chat/permission', {
        type: 'permission_response',
        sessionId: id,
        permId,
        decision: 'once',
      }),
    ).toMatchObject({ status: 200 });
    expect(decide).toHaveBeenCalledOnce();
    expect(hasPending(permId)).toBe(false);
    const queued = {
      ...wire,
      sessionId: id,
      clientMsgId: `queued-${id}`,
      payload: { text: 'Retain mobile work' },
    };
    expect(await mobile.post('/api/chat/runtime/continue', queued)).toMatchObject({ status: 202 });
    const raced = {
      ...queued,
      clientMsgId: `race-${id}`,
      payload: { text: 'One command, two concurrent requests' },
    };
    const retries = await Promise.all([
      desktop.post('/api/chat/runtime/continue', raced),
      mobile.post('/api/chat/runtime/continue', raced),
    ]);
    // Existing in-flight admission may refuse the overlapping retry. Reconcile
    // with the same command ID after acceptance; never manufacture a new input.
    expect(retries.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(await mobile.post('/api/chat/runtime/continue', raced)).toMatchObject({ status: 202 });
    expect(inputs).toEqual([wire.clientMsgId]);
    expect(await mobile.post('/api/chat/stop', { type: 'stop', sessionId: id })).toMatchObject({
      status: 200,
    });
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    expect(await mobile.post(`/api/sessions/${id}/codex-queue/continue`, {})).toMatchObject({
      status: 409,
    });
    hold = false;
    finish!();
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    const metadata = await fetch(`${origin}/api/sessions/${id}/meta`, {
      headers: { Authorization: `Bearer ${mobile.token}` },
    }).then((response) => response.json());
    expect(metadata.codexQueue).toMatchObject({
      paused: true,
      connected: true,
      queued: 2,
      canContinue: true,
    });
    expect(await mobile.post(`/api/sessions/${id}/codex-queue/continue`, {})).toMatchObject({
      status: 200,
    });
    await vi.waitFor(() =>
      expect(inputs).toEqual([wire.clientMsgId, queued.clientMsgId, raced.clientMsgId]),
    );
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    expect(chat.eventStore.getOrdinaryLocalVertexCustody(id)).toEqual(custody);
    expect(chat.eventStore.getSession(id)).toMatchObject({
      cwd: initial.cwd,
      accountBinding: initial.accountBinding,
      repositoryWorkspaceId: initial.repositoryWorkspaceId,
    });
    expect(chat.registry.findBySessionId(id)?.session.ordinaryRuntimeOwner?.authSessionId).toBe(
      desktop.actor.id,
    );
    // A fresh transport/login can replay, including after its old connection cleans up.
    mobile.controller.abort();
    const renewed = await client();
    expect(
      await renewed.post('/api/chat/reconnect', {
        type: 'reconnect',
        sessions: [{ sessionId: id, lastSeq: 0 }],
      }),
    ).toMatchObject({ status: 200 });
    await vi.waitFor(() =>
      expect(renewed.events).toContainEqual(
        expect.objectContaining({ type: 'session_reconnect_snapshot', sessionId: id }),
      ),
    );
    const count = queries.length;
    expect(await renewed.post('/api/chat/runtime/continue', queued)).toMatchObject({ status: 202 });
    expect(queries).toHaveLength(count);
    // Cold reopening is observational. Explicit Send resumes the retained SDK
    // session/account/workspace after terminal proof, preserving immutable custody.
    chat.registry.findBySessionId(id)!.session.ordinaryRuntimeOwner!.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
    await renewed.post('/api/chat/switch', { type: 'switch_session', sessionId: id });
    expect(queries).toHaveLength(count);
    const cold = {
      ...queued,
      clientMsgId: `cold-${id}`,
      payload: { text: 'Continue the retained conversation' },
    };
    expect(await renewed.post('/api/chat/runtime/continue', cold)).toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(inputs.at(-1)).toBe(cold.clientMsgId));
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    expect(queries.at(-1)).toMatchObject({ resume: id, cwd: initial.cwd });
    expect(chat.eventStore.getOrdinaryLocalVertexCustody(id)).toEqual(custody);
    // An authentic login cannot borrow another transport, and revocation still wins.
    expect(
      await renewed.post('/api/chat/stop', { type: 'stop', sessionId: id }, desktop.token),
    ).toMatchObject({ status: 403 });
    auth.revokeAuthSession(renewed.actor);
    expect(await renewed.post('/api/chat/stop', { type: 'stop', sessionId: id })).toMatchObject({
      status: 401,
    });
  },
  30_000,
);
