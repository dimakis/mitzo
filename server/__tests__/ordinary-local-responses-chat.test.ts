import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
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
vi.mock('../connections-runtime.js', () => ({
  getConnectionsRuntime: () => ({ openAIEnrollmentAuthority: services.manager }),
}));
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
it('dispatches consumed API commands through the actual chat owner and retains transcript on cold changed-model resume', async () => {
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  const { ownedResponsesRuntimeFixture } =
    await import('./fixtures/owned-local-responses-runtime.js');
  const f = await ownedResponsesRuntimeFixture(cleanups, { chatRoute: true });
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
  const requests: Record<string, unknown>[] = [];
  let hangNext = false;
  let completeHeld: (() => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      expect(
        chat.eventStore.getLatestOrdinaryCommandAdmission(f.reservation.conversationId)?.state,
      ).toBe('consumed');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer offline-exact-key' });
      if (hangNext) {
        hangNext = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'response.created', response: { id: 'offline-stopped-response', model: body.model } })}\n\n`,
                ),
              );
              completeHeld = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`,
                  ),
                );
                controller.close();
              };
              init.signal?.addEventListener(
                'abort',
                () => controller.error(Error('offline stopped')),
                { once: true },
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return response(body.model);
    }),
  );
  const transport = { send: vi.fn(), isOpen: () => true };
  const options = {
    command: f.request,
    reservation: f.reservation,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    ownerAuthSessionId: f.auth.id,
  };
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
  const wire = { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id };
  await expect(invoke('/send', wire)).resolves.toMatchObject({
    status: 202,
    body: { dispatched: true, state: 'consumed' },
  });
  const liveClientId = chat.registry.findBySessionId(f.reservation.conversationId)!.clientId;
  await expect(
    chat.startOwnedLocalResponsesCommand(transport, 'retry-client', options),
  ).resolves.toMatchObject({ dispatched: false });
  expect(chat.registry.get(liveClientId)?.ordinaryRuntimeOwner).toBeDefined();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  const firstHistory = native.load(f.reservation.conversationId, f.reservation.binding)!.history;
  expect(firstHistory.some((message) => message.role === 'assistant')).toBe(true);
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'next',
      selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
      payload: { text: 'Continue the same task' },
    }),
  ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  expect(requests[1]).toMatchObject({
    model: 'next-model',
    reasoning: { effort: 'high' },
    store: false,
  });
  chat.registry.get(liveClientId)!.ordinaryRuntimeOwner!.close();
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
    true,
  );
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'cold',
      selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
      payload: { text: 'Resume retained task' },
    }),
  ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  expect(
    native.load(f.reservation.conversationId, f.reservation.binding)!.history.length,
  ).toBeGreaterThan(firstHistory.length);
  expect(chat.eventStore.getSession(f.reservation.conversationId)?.accountBinding).toEqual(
    f.reservation.binding,
  );
  hangNext = true;
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'held',
      payload: { text: 'Hold the active turn' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  const queuedSelection = { ...f.request.selection, model: 'next-model', thinking: 'high' };
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'queued',
      selection: queuedSelection,
      payload: { text: 'A queued frozen turn' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  queuedSelection.model = f.request.selection.model;
  expect(requests).toHaveLength(4);
  const queues = await import('../ordinary-local-responses-queue.js');
  const absentCustody = new (await import('../native-responses-store.js')).NativeResponsesStore(
    ':memory:',
  );
  expect(
    queues.readOwnedResponsesQueue(
      chat.eventStore,
      absentCustody,
      f.reservation.conversationId,
      f.reservation.binding,
      true,
    ),
  ).toMatchObject({ paused: true, connected: false, queued: 0 });
  absentCustody.close();

  const { assertOwnedCodexQueueControl } = await import('../owned-codex-queue-control.js');
  const queueRouter = (await import('../codex-queue-routes.js')).createCodexQueueRouter({
    authorizeMutation: (id, authorization) =>
      assertOwnedCodexQueueControl(
        {
          runtimeBinding: (sessionId) => chat.eventStore.getSessionRuntimeBinding(sessionId),
          accountBinding: (sessionId) => chat.eventStore.getSession(sessionId)?.accountBinding,
          custody: (sessionId, account) => native.readOrdinaryCustody(sessionId, account),
        },
        id,
        authorization,
      ),
    binding: () => f.reservation.binding,
    overview: (id, binding) =>
      queues.readOwnedResponsesQueueOverview(chat.eventStore, native, id, binding),
    cancel: (id, binding, commandId, auth) =>
      queues.cancelOwnedResponsesQueuedCommand(
        chat.eventStore,
        native,
        id,
        binding,
        commandId,
        auth,
      ),
    retry: async () => 'unavailable',
    reattach: async () => 'unavailable',
  });

  expect(
    queues.readOwnedResponsesQueue(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
      true,
    ),
  ).toMatchObject({ queued: 1, connected: true, retryable: false });
  expect(
    queues.readOwnedResponsesQueueOverview(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
    ),
  ).toMatchObject({ queued: [{ id: 'queued', preview: 'A queued frozen turn' }] });
  expect(() =>
    queues.cancelOwnedResponsesQueuedCommand(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
      'queued',
      { ...f.auth, id: 'other-login' },
    ),
  ).toThrow('Original');
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'cancel-queued',
      payload: { text: 'Never send this queued message' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  expect(
    queues.cancelOwnedResponsesQueuedCommand(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
      'held',
      f.auth,
    ),
  ).toBe('not_queued');
  await expect(
    invoke(`/${f.reservation.conversationId}/codex-queue/cancel-queued/cancel`, {}, queueRouter),
  ).resolves.toMatchObject({ status: 200, body: { ok: true, status: 'cancelled' } });
  expect(
    queues.readOwnedResponsesQueueOverview(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
    ).cancelledIds,
  ).toContain('cancel-queued');
  expect(
    chat.eventStore.getExecutionAdmission(f.reservation.conversationId, 'queued'),
  ).toBeUndefined();
  completeHeld!();
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  expect(requests[4]).toMatchObject({ model: 'next-model', reasoning: { effort: 'high' } });
  await vi.waitFor(() =>
    expect(native.queue(f.reservation.conversationId, f.reservation.binding).active).toBeNull(),
  );
  hangNext = true;
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'stop-turn',
      payload: { text: 'A turn stopped before completion' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  await vi.waitFor(() => expect(requests).toHaveLength(6));
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'cold-queued',
      selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
      payload: { text: 'Retained queued tail' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  expect(requests).toHaveLength(6);
  await chat.registry.findBySessionId(f.reservation.conversationId)!.session.queryInstance!
    .interrupt!();
  expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('interrupted');
  const stopped = chat.eventStore.getExecutionAdmission(f.reservation.conversationId, 'stop-turn')!;
  expect(chat.eventStore.getExecutionTerminalReason(stopped.token)).toBe('interrupted');
  chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.close();
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
    true,
  );
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'after-stop',
      payload: { text: 'Inspect retained state after Stop' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  await vi.waitFor(() => expect(requests).toHaveLength(8));
  expect(requests[6]).toMatchObject({ model: 'next-model', reasoning: { effort: 'high' } });
  expect(requests[7]).toMatchObject({ model: f.request.selection.model });
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.close();
}, 15000);
