import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const services = vi.hoisted(() => ({
  authId: '',
  workspace: undefined as unknown,
  library: undefined as unknown,
  query: vi.fn(),
  requests: [] as Array<{
    options: Record<string, unknown>;
    prompt: AsyncIterable<Record<string, unknown>>;
  }>,
}));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
}));
vi.mock('../agent-library-runtime.js', async (original) => ({
  ...(await original<object>()),
  getAgentLibrary: () => services.library,
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
vi.mock('../credential-sdk-boundary.js', async (original) => ({
  ...(await original<object>()),
  credentialSdkBoundary: () => ({ spawnClaudeCodeProcess: () => new EventEmitter() }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: services.query,
  renameSession: vi.fn(async () => {}),
  getSessionInfo: vi.fn(async (id: string, options: { dir: string }) => ({
    sessionId: id,
    cwd: options.dir,
    summary: 'Offline SDK history',
    lastModified: 1,
  })),
  getSessionMessages: vi.fn(async () => [
    { type: 'user', uuid: 'original-input', message: { role: 'user', content: 'retained input' } },
  ]),
}));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  services.requests.length = 0;
  services.query.mockReset();
});
it('routes first, queued future and cold commands through the actual SDK owner with terminal-only effort options and original thread', async () => {
  const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
  const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true });
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  services.workspace = f.workspace;
  services.library = f.library;
  services.authId = f.auth.id;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('Offline test has no network');
    }),
  );
  let releaseFirst: (() => void) | undefined;
  let first = true;
  const history: string[] = [];
  services.query.mockImplementation((request) => {
    services.requests.push(request);
    const id = request.options.resume ?? request.options.sessionId;
    const closed = { value: false };
    const process = request.options.spawnClaudeCodeProcess({
      signal: request.options.abortController.signal,
    });
    const instance = {
      async *[Symbol.asyncIterator]() {
        for await (const message of request.prompt) {
          if (closed.value) break;
          const inputUuid = `input-${message.mitzoMessageId}`;
          history.push(message.mitzoMessageId);
          yield {
            type: 'user',
            uuid: inputUuid,
            parent_tool_use_id: null,
            message: { role: 'user', content: message.message.content },
          };
          yield {
            type: 'stream_event',
            session_id: id,
            event: { type: 'message_start', message: { id: `assistant-${inputUuid}` } },
          };
          if (first) {
            first = false;
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
              request.options.abortController.signal.addEventListener('abort', resolve, {
                once: true,
              });
            });
          }
          if (closed.value) return;
          yield {
            type: 'assistant',
            session_id: id,
            message: { content: [{ type: 'text', text: 'Offline SDK answer' }] },
          };
          yield { type: 'result', session_id: id, is_error: false };
        }
      },
      close: vi.fn(() => {
        closed.value = true;
        process.emit('close', 0, null);
      }),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setMaxThinkingTokens: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {}),
    };
    return instance;
  });
  const chat = await import('../chat.js');
  cleanups.push(async () => {
    const live = chat.registry.findBySessionId(f.reservation.conversationId);
    live?.session.ordinaryRuntimeOwner?.close();
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
    );
    chat.eventStore.close();
  });
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
  const invoke = (url: string, body: unknown) =>
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
        router as import('express').Router & {
          handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
        }
      ).handle(req, res, (error) => reject(error ?? Error('Unmatched route')));
    });
  const wire = { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id };
  await expect(invoke('/send', wire)).resolves.toMatchObject({
    status: 202,
    body: { dispatched: true, state: 'consumed' },
  });
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'queued',
      selection: { ...wire.selection, model: 'next-model', thinking: 'high' },
      payload: { text: 'Frozen followup' },
    }),
  ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
  expect(services.requests).toHaveLength(1);
  expect(services.requests[0].options.effort).toBe('low');
  releaseFirst!();
  await vi.waitFor(() => expect(history).toEqual([f.request.clientMsgId, 'queued']));
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
      'TERMINAL',
    ),
  );
  expect(services.requests[1].options).toMatchObject({
    resume: f.reservation.conversationId,
    model: 'next-model',
    effort: 'high',
    env: { ANTHROPIC_VERTEX_PROJECT_ID: 'offline-project', CLOUD_ML_REGION: 'offline-region' },
  });
  expect(services.requests[1].options).not.toHaveProperty('sessionId');
  const custody = chat.eventStore.getOrdinaryLocalVertexCustody(f.reservation.conversationId);
  // Emulate the durable state after an acknowledged queue entry was saved and
  // the predecessor reached terminal, before the old driver dispatched its tail.
  const retainedMeta = chat.eventStore.getSession(f.reservation.conversationId)!;
  const frozenTail = chat.eventStore.getOrdinaryLocalVertexCommandAdmission('queued')!;
  chat.eventStore.admitOrdinaryLocalVertexContinuation(
    {
      ...retainedMeta,
      selectedModel: frozenTail.selection.model,
      reasoningEffort: frozenTail.selection.thinking,
      accountBinding: { ...retainedMeta.accountBinding!, model: frozenTail.selection.model },
    },
    frozenTail.binding,
    {
      clientMsgId: 'retained-cold-tail',
      requestFingerprint: 'acknowledged-never-dispatched-tail',
      selection: frozenTail.selection,
      payload: {
        ...chat.eventStore.getSendCommand('queued')!.payload,
        text: 'Original acknowledged tail',
      },
    },
  );
  chat.eventStore.claimOrdinaryLocalVertexCommandDispatch('retained-cold-tail');
  chat.eventStore.completeOrdinaryLocalVertexCommand('retained-cold-tail');
  chat.stopOrdinaryChat(chat.registry.findBySessionId(f.reservation.conversationId)!.clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'cold',
      payload: { text: 'Same retained task' },
    }),
  ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
  await vi.waitFor(() =>
    expect(history).toEqual([f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold']),
  );
  expect(services.requests[2].options).toMatchObject({
    resume: f.reservation.conversationId,
    model: 'next-model',
    effort: 'high',
  });
  expect(services.requests[3].options).toMatchObject({
    resume: f.reservation.conversationId,
    model: 'fixture-model',
    effort: 'low',
  });
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
      'TERMINAL',
    ),
  );
  expect(chat.eventStore.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(
    custody,
  );
  first = true;
  releaseFirst = undefined;
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'active-stop',
      payload: { text: 'Stop this turn' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'saved-after-stop',
      selection: { ...wire.selection, model: 'next-model', thinking: 'high' },
      payload: { text: 'Retain this queued work' },
    }),
  ).resolves.toMatchObject({ status: 202 });
  const stoppedQueryCount = services.requests.length;
  chat.stopOrdinaryChat(chat.registry.findBySessionId(f.reservation.conversationId)!.clientId);
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  await expect(
    invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'after-active-stop',
      payload: { text: 'Do not create a new thread' },
    }),
  ).resolves.toMatchObject({ status: 409 });
  expect(services.requests).toHaveLength(stoppedQueryCount);
  expect(chat.eventStore.getSendCommand('after-active-stop')).toBeUndefined();
  expect(
    chat.eventStore.getExecutionAdmission(f.reservation.conversationId, 'saved-after-stop'),
  ).toBeUndefined();
  expect(chat.eventStore.getSendCommand('saved-after-stop')).toMatchObject({ error: null });
  expect(chat.eventStore.getOrdinaryLocalVertexCommandAdmission('saved-after-stop')).toMatchObject({
    state: 'consumed',
    selection: { model: 'next-model', thinking: 'high' },
  });

  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/health'))).toBe(true);
}, 15_000);
