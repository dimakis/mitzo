import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles } from '../account-profiles.js';
import { agentLibrarySource } from './fixtures/agent-library-source.js';
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
it('dispatches consumed API commands through the actual chat owner and retains transcript on cold changed-model resume', async () => {
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  const { ownedResponsesRuntimeFixture } =
    await import('./fixtures/owned-local-responses-runtime.js');
  const f = await ownedResponsesRuntimeFixture(cleanups, { chatRoute: true });
  Object.assign(f.request.payload, { sourceSnapshots: [agentLibrarySource] });
  services.workspace = f.workspace;
  services.library = f.library;
  services.authId = f.auth.id;
  const chat = await import('../chat.js');
  const responses = await import('../responses-chat-session.js');
  const openChat = vi.spyOn(responses, 'openResponsesChat');
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
  let transportOpen = true;
  const transport = { send: vi.fn(), isOpen: () => transportOpen };
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
  const invoke = (
    url: string,
    body: unknown,
    selectedRouter = router,
    auth: import('../auth.js').AuthSession = f.auth,
  ) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      let status = 200;
      const req = {
        method: 'POST',
        url,
        headers: { 'x-connection-id': f.dependencies.operatorConnectionId },
        body,
      };
      const res = {
        locals: { authSession: auth },
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
  expect(JSON.stringify(requests[0].input)).toContain(
    agentLibrarySource.content.replaceAll('"', '\\"'),
  );
  const publicUser = chat.eventStore
    .getSessionEvents(f.reservation.conversationId)
    .find((event) => event.type === 'user_message');
  expect(publicUser?.payload).toMatchObject({
    text: f.request.payload.text,
    sourceSnapshots: [agentLibrarySource],
  });
  expect(openChat).toHaveBeenCalled();
  for (const [options] of openChat.mock.calls) {
    expect(options.configuredSourceEnv).toBeDefined();
    expect(options.configuredSourceEnv).toEqual(chat.nativeExecutionEnv());
    expect(options.env.MITZO_SESSION_ID).toBeDefined();
  }

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
  const originalConfiguration = structuredClone(f.configuration);
  const exactQueued = {
    ...wire,
    sessionId: f.reservation.conversationId,
    clientMsgId: 'queued',
    selection: structuredClone(queuedSelection),
    payload: { text: 'A queued frozen turn' },
  };
  const retainedReceipt = chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('queued');
  const retainedQueue = native.queue(f.reservation.conversationId, f.reservation.binding);
  const retainedHistory = native.load(f.reservation.conversationId, f.reservation.binding)!.history;
  f.configuration[0].models = [{ id: 'future-C', label: 'Future C', reasoningEfforts: ['low'] }];
  f.configuration[0].label = 'Refreshed label';
  f.writeProfiles();
  await expect(invoke('/continue', exactQueued)).resolves.toMatchObject({
    status: 202,
    body: { dispatched: false, state: 'consumed', sessionId: f.reservation.conversationId },
  });
  await expect(
    invoke('/continue', { ...exactQueued, payload: { text: 'Changed' } }),
  ).resolves.toMatchObject({ status: 409 });
  await expect(
    invoke('/continue', {
      ...exactQueued,
      selection: { ...exactQueued.selection, thinking: 'low' },
    }),
  ).resolves.toMatchObject({ status: 409 });
  await expect(
    invoke('/continue', exactQueued, router, { ...f.auth, id: 'foreign-operator' }),
  ).resolves.toMatchObject({ status: 403 });
  expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('queued')).toEqual(
    retainedReceipt,
  );
  expect(native.queue(f.reservation.conversationId, f.reservation.binding)).toEqual(retainedQueue);
  expect(native.load(f.reservation.conversationId, f.reservation.binding)!.history).toEqual(
    retainedHistory,
  );
  expect(requests).toHaveLength(4);
  f.configuration.splice(0, f.configuration.length, ...originalConfiguration);
  f.writeProfiles();
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
  hangNext = true;
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'full-active',
      payload: { text: 'Stop with a full accepted queue' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  await vi.waitFor(() => expect(requests).toHaveLength(9));
  const { OrdinaryLocalCodexSelectionOwner } =
    await import('../ordinary-local-codex-selection-owner.js');
  const originalCurrent = OrdinaryLocalCodexSelectionOwner.prototype.assertCurrent;
  let validatingFollowup = false,
    releaseFollowup!: () => void,
    entryDeadline!: () => void;
  const followupGate = new Promise<void>((resolve) => {
    releaseFollowup = resolve;
  });
  const selectionProbe = vi
    .spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent')
    .mockImplementation(async function (
      this: InstanceType<typeof OrdinaryLocalCodexSelectionOwner>,
      expected,
    ) {
      if (expected.selection.model === 'next-model') {
        validatingFollowup = true;
        await followupGate;
      }
      return originalCurrent.call(this, expected);
    });
  const originalTimer = globalThis.setTimeout;
  const timerProbe = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 120000) entryDeadline = callback;
    return originalTimer(callback, delay, ...args);
  }) as typeof setTimeout);
  const beforeDeadlineQueue = native.queue(f.reservation.conversationId, f.reservation.binding);
  const activeOwner = chat.registry.findBySessionId(f.reservation.conversationId)!.session
    .ordinaryRuntimeOwner;
  const deadlineFollowup = invoke('/continue', {
    ...wire,
    sessionId: f.reservation.conversationId,
    clientMsgId: 'expired-live-followup',
    selection: { ...wire.selection, model: 'next-model', thinking: 'high' },
    payload: { text: 'Do not accept expired request' },
  });
  await vi.waitFor(() => expect(validatingFollowup).toBe(true));
  entryDeadline();
  releaseFollowup();
  await expect(deadlineFollowup).resolves.toMatchObject({ status: 409 });
  expect(
    chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('expired-live-followup')?.state,
  ).not.toBe('consumed');
  expect(native.queue(f.reservation.conversationId, f.reservation.binding)).toEqual(
    beforeDeadlineQueue,
  );
  expect(
    chat.registry.findBySessionId(f.reservation.conversationId)!.session.ordinaryRuntimeOwner,
  ).toBe(activeOwner);
  expect(
    chat.registry.findBySessionId(f.reservation.conversationId)!.session.abortController.signal
      .aborted,
  ).toBe(false);
  expect(requests).toHaveLength(9);
  selectionProbe.mockRestore();
  timerProbe.mockRestore();
  const accepted: Array<{
    clientMsgId: string;
    selection: { model: string; thinking: string | null };
    payload: { text: string };
  }> = [];
  for (let i = 0; i < 32; i++) {
    const command = {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: `full-saved-${i}`,
      selection:
        i % 2 === 0 ? { ...wire.selection, model: 'next-model', thinking: 'high' } : wire.selection,
      payload: { text: `Preserve accepted FIFO work ${i}` },
    };
    accepted.push(command);
    await expect(invoke('/continue', command)).resolves.toMatchObject({ status: 202 });
  }
  await expect(invoke('/continue', accepted[31])).resolves.toMatchObject({
    status: 202,
    body: { dispatched: false },
  });
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'full-overflow',
    }),
  ).resolves.toMatchObject({ status: 409 });
  expect(
    chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('full-overflow'),
  ).toBeUndefined();
  const receipts = accepted.map((command) =>
    chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(command.clientMsgId),
  );
  await chat.registry.findBySessionId(f.reservation.conversationId)!.session.queryInstance!
    .interrupt!();
  chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.close();
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(
    accepted.map((command) => command.clientMsgId),
  );
  expect(
    queues.readOwnedResponsesQueue(
      chat.eventStore,
      native,
      f.reservation.conversationId,
      f.reservation.binding,
      false,
      chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id),
    ),
  ).toMatchObject({ connected: false, paused: true, queued: 32, canContinue: true });
  const { ConnectionRegistry } = await import('@mitzo/harness');
  const controlRegistry = new ConnectionRegistry();
  controlRegistry.register(f.dependencies.operatorConnectionId, transport);
  chat.setConnectionRegistry(controlRegistry);
  cleanups.push(() => {
    chat.setConnectionRegistry(new ConnectionRegistry());
  });
  queueRouter.post('/:id/codex-queue/continue', async (req, res) => {
    try {
      await chat.continueOwnedLocalResponsesQueue(
        req.params.id,
        res.locals.authSession,
        f.dependencies.operatorConnectionId,
      );
      res.json({ ok: true });
    } catch {
      res.status(409).json({ ok: false });
    }
  });
  await expect(
    Promise.resolve().then(() =>
      chat.continueOwnedLocalResponsesQueue(
        f.reservation.conversationId,
        { ...f.auth, id: 'foreign-login' },
        f.dependencies.operatorConnectionId,
      ),
    ),
  ).rejects.toThrow();
  await expect(
    chat.continueOwnedLocalResponsesQueue(f.reservation.conversationId, f.auth),
  ).rejects.toThrow();
  services.authId = 'different-connection-owner';
  await expect(
    chat.continueOwnedLocalResponsesQueue(
      f.reservation.conversationId,
      f.auth,
      f.dependencies.operatorConnectionId,
    ),
  ).rejects.toThrow();
  services.authId = f.auth.id;
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(
    accepted.map((command) => command.clientMsgId),
  );
  const { OrdinaryLocalResponsesOwnedRuntime } =
    await import('../ordinary-local-responses-owned-runtime.js');
  const originalReopen = OrdinaryLocalResponsesOwnedRuntime.prototype.reopenRetainedQueue;
  let releaseReopen!: () => void;
  const reopenGate = new Promise<void>((resolve) => {
    releaseReopen = resolve;
  });
  const reopening = vi
    .spyOn(OrdinaryLocalResponsesOwnedRuntime.prototype, 'reopenRetainedQueue')
    .mockImplementation(async function (
      this: InstanceType<typeof OrdinaryLocalResponsesOwnedRuntime>,
    ) {
      await reopenGate;
      return originalReopen.call(this);
    });
  const firstContinue = invoke(
    `/${f.reservation.conversationId}/codex-queue/continue`,
    {},
    queueRouter,
  );
  await vi.waitFor(() => expect(reopening).toHaveBeenCalledTimes(1));
  try {
    let racingQueueResult: { status: number } | undefined;
    const racingQueue = invoke(
      `/${f.reservation.conversationId}/codex-queue/continue`,
      {},
      queueRouter,
    ).then((result) => {
      racingQueueResult = result;
      return result;
    });
    await vi.waitFor(() => {
      expect(reopening).toHaveBeenCalledTimes(1);
      expect(racingQueueResult).toMatchObject({ status: 409 });
    });
    await racingQueue;
    await expect(
      invoke('/continue', { ...accepted[31], clientMsgId: 'racing-cold-command' }),
    ).resolves.toMatchObject({ status: 409 });
    expect(reopening).toHaveBeenCalledTimes(1);
    expect(
      chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('racing-cold-command'),
    ).toBeUndefined();
    expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(
      accepted.map((command) => command.clientMsgId),
    );
  } finally {
    transportOpen = false;
    releaseReopen();
  }
  await expect(firstContinue).resolves.toMatchObject({ status: 200 });
  reopening.mockRestore();
  const reopenedClientId = chat.registry.findBySessionId(f.reservation.conversationId)!.clientId;
  expect(chat.registry.isAttached(reopenedClientId)).toBe(false);
  transportOpen = true;
  expect(chat.reattachChat(reopenedClientId, transport)).toBe(true);
  const reopenedSession = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
  expect(reopenedSession.ordinaryRuntimeOwner?.authSessionId).toBe(f.auth.id);
  expect(reopenedSession.queryInstance?.interrupt).toBeTypeOf('function');
  await expect(
    chat.continueOwnedLocalResponsesQueue(
      f.reservation.conversationId,
      { ...f.auth, id: 'foreign-after-reopen' },
      f.dependencies.operatorConnectionId,
    ),
  ).rejects.toThrow('Original');
  await vi.waitFor(() => expect(requests).toHaveLength(41), { timeout: 15000 });
  await vi.waitFor(() =>
    expect(native.queue(f.reservation.conversationId, f.reservation.binding).active).toBeNull(),
  );
  for (let i = 0; i < 32; i++) {
    expect(requests[9 + i].model).toBe(accepted[i].selection.model);
    expect(JSON.stringify(requests[9 + i].input)).toContain(accepted[i].payload.text);
    expect(
      chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(accepted[i].clientMsgId),
    ).toEqual(receipts[i]);
  }
  expect(chat.eventStore.getLatestOrdinaryCommandAdmission(f.reservation.conversationId)).toEqual(
    receipts[31],
  );
  expect(chat.eventStore.getSession(f.reservation.conversationId)?.accountBinding).toEqual(
    f.reservation.binding,
  );
  chat.registry
    .findBySessionId(f.reservation.conversationId)!
    .session.ordinaryRuntimeOwner!.close();
}, 60000);
