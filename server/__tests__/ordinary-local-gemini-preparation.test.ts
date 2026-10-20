import { GoogleAuth } from 'google-auth-library';
import { afterEach, expect, it, vi } from 'vitest';
const services = vi.hoisted(() => ({
  authId: '',
  workspace: undefined as unknown,
  library: undefined as unknown,
  manager: { manages: () => true, resolveKey: vi.fn(async () => 'offline-exact-key') },
}));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
}));
vi.mock('../agent-library-runtime.js', async (original) => ({
  ...(await original<object>()),
  getAgentLibrary: () => services.library,
}));
vi.mock('../connections-runtime.js', () => {
  const runtime = { openAIEnrollmentAuthority: services.manager };
  return { getConnectionsRuntime: () => runtime };
});
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
  operatorAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../connections-router.js', async (original) => ({
  ...(await original<object>()),
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../transport-auth-ownership.js', async (original) => ({
  ...(await original<object>()),
  liveTransportAuthSessionId: () => services.authId,
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No alternate SDK');
  },
}));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  services.manager.resolveKey.mockClear();
});
function response(model: string) {
  const events = [
    { type: 'response.created', response: { id: 'offline-response', model } },
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
      delta: 'Offline answer',
    },
    { type: 'response.content_part.done', output_index: 0, content_index: 0 },
    {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Offline answer' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

it.each(['checkout', 'mcp'] as const)(
  'refuses a Gemini entry deadline during awaited %s preparation before token or provider dispatch',
  async (phase) => {
    vi.resetModules();
    const token = vi
      .spyOn(GoogleAuth.prototype, 'getAccessToken')
      .mockResolvedValue('offline-google-token');
    const { ownedResponsesRuntimeFixture } =
      await import('./fixtures/owned-local-responses-runtime.js');
    const f = await ownedResponsesRuntimeFixture(cleanups, { chatRoute: true, gemini: true });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    const chat = await import('../chat.js');
    const native = (await import('../responses-chat-session.js')).getNativeResponsesStore();
    cleanups.push(() => {
      const live = chat.registry.findBySessionId(f.reservation.conversationId);
      if (live) chat.registry.abort(live.clientId);
      chat.eventStore.close();
      native.close();
    });
    const fetch = vi.fn(async () => response('fixture-model'));
    vi.stubGlobal('fetch', fetch);
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deadline!: () => void;
    const originalTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 120000) deadline = callback;
      return originalTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    if (phase === 'checkout') {
      const originalClaim = f.workspace.claimReservedHostTask.bind(f.workspace);
      vi.spyOn(f.workspace, 'claimReservedHostTask').mockImplementation(async (input) => {
        entered = true;
        await gate;
        return originalClaim(input);
      });
    } else {
      const connector = await import('../codex-mcp-tools.js');
      const originalConnect = connector.connectCodexMcpTools;
      vi.spyOn(connector, 'connectCodexMcpTools').mockImplementation(async (...args) => {
        entered = true;
        await gate;
        return originalConnect(...args);
      });
    }
    const transport = { send: vi.fn(), isOpen: () => true };
    const { createOwnedLocalCodexEntryRouter } = await import('../ordinary-local-codex-entry.js');
    const router = createOwnedLocalCodexEntryRouter(
      { isOpen: () => true, isOwnedBy: () => true } as never,
      {
        sessionRegistry: chat.registry,
        eventStore: chat.eventStore,
        connRegistry: { get: () => ({ transport }), watch: vi.fn(), setActive: vi.fn() } as never,
      },
      true,
    );
    const invoke = (url: string, body: unknown, selectedRouter = router) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        let status = 200;
        const req = {
          method: 'POST',
          url,
          headers: { 'x-connection-id': f.dependencies.operatorConnectionId },
          body,
        };
        const res = {
          locals: { authSession: f.auth },
          set() {
            return this;
          },
          status(code: number) {
            status = code;
            return this;
          },
          json(value: Record<string, unknown>) {
            resolve({ status, body: value });
            return this;
          },
        };
        (
          selectedRouter as import('express').Router & {
            handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
          }
        ).handle(req, res, (error) => reject(error ?? Error('Unmatched route')));
      });
    const pending = invoke('/send', {
      ...f.request,
      runOn: 'local',
      repositoryWorkspaceId: f.reservation.id,
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(deadline).toBeTypeOf('function');
    deadline();
    release();
    await expect(pending).resolves.toMatchObject({ status: 409 });
    await new Promise((resolve) => originalTimer(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(services.manager.resolveKey).not.toHaveBeenCalled();
    expect(
      chat.eventStore.getExecutionAdmission(f.reservation.conversationId, f.request.clientMsgId),
    ).toBeUndefined();
    expect(
      chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(f.request.clientMsgId)?.state,
    ).toBe('uncertain');
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull();
  },
  15000,
);
