import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConnectionRegistry } from '@mitzo/harness';
import { enrolledResponsesOwnerFixture } from './fixtures/enrolled-responses-owner.js';
import { enrolledRepositorySourceFixture } from './fixtures/enrolled-repository-source.js';
import { ordinaryLocalResponsesContractRevision } from '../ordinary-local-responses-capabilities.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

it('creates a continuation-eligible ordinary Responses source through authenticated application HTTP and original owners', async () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  const realFetch = globalThis.fetch;
  try {
    const f = await enrolledResponsesOwnerFixture(cleanup);
    const targetPath = join(f.root, 'responses-target.json');
    await writeFile(
      targetPath,
      JSON.stringify({
        version: 1,
        targetId: 'offline-local',
        label: 'Offline local',
        hostId: hostname(),
        runtimeContractRevision: ordinaryLocalResponsesContractRevision(),
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE', targetPath);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
    vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    const source = await enrolledRepositorySourceFixture(f, cleanup);
    await mkdir(join(f.root, '.claude', 'repository-tasks'), { recursive: true, mode: 0o700 });
    const application = await import('../app.js');
    const chat = await import('../chat.js');
    const responses = await import('../responses-chat-session.js');
    const auth = await import('../auth.js');
    const { getAgentLibrary } = await import('../agent-library-runtime.js');
    const { NativeCommandRegistry } = await import('../native-commands.js');
    const { mountApplicationChatTransport } = await import('../chat-rest-handler.js');
    const { nativeStartupSessionId } = await import('../ordinary-repository-startup.js');
    const sessionId = nativeStartupSessionId(`repository:${source.workspace.id}`);
    const connections = new ConnectionRegistry();
    chat.setConnectionRegistry(connections);
    application.setConnectionsRuntime(f.runtime);
    auth.setAuthRevocationStore(chat.eventStore);
    mountApplicationChatTransport(application.app, application.chatSseRegistry, {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      nativeCommands: new NativeCommandRegistry(),
    });
    cleanup.push(async () => {
      const live = chat.registry.findBySessionId(sessionId);
      if (live) {
        if (!live.session.ordinaryRuntimeOwner?.closeIdle)
          throw Error('Original Responses idle release unavailable');
        await live.session.ordinaryRuntimeOwner.closeIdle();
      }
      connections.dispose();
      chat.setConnectionRegistry(null);
      application.setConnectionsRuntime(null);
      responses.getNativeResponsesStore().close();
      await application.closeIdleApplicationResources();
    });
    const library = getAgentLibrary();
    library.saveDraft('user', {
      profileId: 'source-agent',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'draft',
      definition: {
        name: 'Source agent',
        descriptor: 'Offline assistant',
        role: 'agent',
        instructions: 'Read the repository.',
        expectedOutput: 'Answer',
        acceptanceCriteria: ['Use source'],
        modelPolicyRole: 'agent',
        tools: [],
      },
    });
    library.publish('user', {
      profileId: 'source-agent',
      expectedVersion: 1,
      idempotencyKey: 'publish',
    });
    const providerRequests: unknown[] = [];
    const offlineEndpoints: { loopbackBase?: string } = {};
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (offlineEndpoints.loopbackBase && address.startsWith(`${offlineEndpoints.loopbackBase}/`))
        return realFetch(url, init);
      if (address !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST')
        throw Error(`Unexpected offline application fetch: ${address}`);
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('gpt-6-luna');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer SYNTHETIC_OFFLINE_ENROLLMENT_KEY',
      });
      expect(chat.eventStore.getLatestOrdinaryCommandAdmission(sessionId)?.state).toBe('consumed');
      const live = chat.registry.findBySessionId(sessionId)!;
      await expect(live.session.ordinaryRuntimeOwner!.closeIdle!()).rejects.toThrow(
        'Responses owner is active',
      );
      expect(() => chat.setConnectionRegistry(null)).toThrow('Chat session owners are active');
      expect(chat.registry.findBySessionId(sessionId)?.session).toBe(live.session);
      providerRequests.push(body);
      const events = [
        {
          type: 'response.created',
          response: { id: 'offline-source-response', model: body.model },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text' },
        },
        {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          delta: 'Offline source answer',
        },
        { type: 'response.content_part.done', output_index: 0, content_index: 0 },
        {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Offline source answer' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const server = await listenOnLoopback(application.app);
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected loopback listener');
    const base = `http://127.0.0.1:${address.port}`;
    offlineEndpoints.loopbackBase = base;
    cleanup.push(async () => {
      server.closeAllConnections();
      await closeTestServer(server);
    });
    const token = (await auth.login(process.env.AUTH_PASSPHRASE!))!;
    const headers = { Cookie: `cc_auth=${token}` };
    const streamAbort = new AbortController();
    const stream = await realFetch(`${base}/api/chat/events`, {
      headers,
      signal: streamAbort.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    cleanup.push(async () => {
      streamAbort.abort();
      await reader.cancel().catch(() => undefined);
      await vi.waitFor(() => expect(application.chatSseRegistry.size).toBe(0));
    });
    const welcome = JSON.parse(
      new TextDecoder().decode((await reader.read()).value).split('\ndata: ')[1],
    );
    const capabilityResponse = await realFetch(`${base}/api/chat/runtime/capabilities`, {
      headers,
    });
    const capabilities = await capabilityResponse.json();
    expect(capabilityResponse.status, JSON.stringify(capabilities)).toBe(200);
    const route = capabilities.routes.find(
      (entry: { harness: string; account: { accountId: string } }) =>
        entry.harness === 'responses' && entry.account.accountId === f.binding.accountId,
    );
    expect(route).toBeDefined();
    const command = {
      runOn: 'local',
      repositoryWorkspaceId: source.workspace.id,
      clientMsgId: randomUUID(),
      capabilityRevision: route.capabilityRevision,
      runtime: {
        account: route.account,
        harness: 'responses',
        targetId: 'offline-local',
        mode: 'agent',
      },
      selection: {
        version: 1,
        agent: { profileId: 'source-agent', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'gpt-6-luna',
        thinking: 'low',
      },
      payload: { text: 'Read the repository source.' },
    };
    const sent = await realFetch(`${base}/api/chat/runtime/send`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Connection-ID': welcome.connectionId,
        Origin: base,
      },
      body: JSON.stringify(command),
    });
    const sentBody = await sent.json();
    expect(sent.status, JSON.stringify(sentBody)).toBe(202);
    expect(sentBody).toMatchObject({ dispatched: true, state: 'consumed' });
    await vi.waitFor(() => expect(providerRequests).toHaveLength(1), { timeout: 10000 });
    await vi.waitFor(
      () => expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('TERMINAL'),
      { timeout: 10000 },
    );
    const metaResponse = await realFetch(`${base}/api/sessions/${sessionId}/meta`, { headers });
    const meta = await metaResponse.json();
    expect(metaResponse.status).toBe(200);
    expect(meta).toMatchObject({ runtimeCommandScope: 'conversation' });
    const { ordinaryCodexContinuationStatus } =
      await import('../ordinary-codex-continuation-status.js');
    const actor = (await auth.authenticateToken(token))!;
    expect(ordinaryCodexContinuationStatus(sessionId, actor.id)).toEqual({ available: true });
    expect(
      responses.getNativeResponsesStore().load(sessionId, f.binding)?.history.length,
    ).toBeGreaterThan(0);
  } finally {
    for (const close of cleanup.reverse()) await close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
}, 30000);
