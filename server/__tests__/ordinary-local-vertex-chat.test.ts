import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { agentLibrarySource } from './fixtures/agent-library-source.js';
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
  Object.assign(f.request.payload, { sourceSnapshots: [agentLibrarySource] });
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
  const providerInputs: string[] = [];
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
          const content = message.message.content;
          providerInputs.push(
            typeof content === 'string'
              ? content
              : content.map((block: { text?: string }) => block.text ?? '').join(''),
          );
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
  const preparationTimers = vi.spyOn(globalThis, 'setTimeout');
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
        method: url === '/capabilities' ? 'GET' : 'POST',
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
  // Public catalog -> production browser builder -> durable transport -> actual router.
  const { ExplicitLocalInventorySchema, prepareLocalFirstCommand } =
    await import('../../frontend/src/lib/explicit-local-chat.js');
  const { createChatRuntimeSelection } =
    await import('../../frontend/src/lib/chat-runtime-selection.js');
  const { SendOutbox } = await import('../../packages/client/src/send-outbox.js');
  const capabilities = await invoke('/capabilities', undefined);
  expect(capabilities.status).toBe(200);
  const inventory = ExplicitLocalInventorySchema.parse(capabilities.body);
  const route = inventory.routes.find((route) => route.harness === 'claude-sdk')!;
  expect(route).toBeDefined();
  const built = prepareLocalFirstCommand(
    {
      ...createChatRuntimeSelection(),
      account: {
        accountId: route.account.accountId,
        model: f.request.selection.model,
        reasoningEffort: f.request.selection.thinking,
      },
      accountReference: route.account,
      agentProfile: f.request.selection.agent,
      execution: { location: 'local', targetId: route.targetId },
      capabilityRevision: inventory.capabilityRevision,
    },
    inventory,
    {
      repositoryWorkspaceId: f.reservation.id,
      clientMsgId: f.request.clientMsgId,
      mode: 'agent',
      text: f.request.payload.text,
      sourceSnapshots: [agentLibrarySource],
    },
  );
  expect(built.reason).toBeUndefined();
  expect(built.request).not.toBeNull();
  const wire = built.request!;
  expect(wire.capabilityRevision).toBe(route.capabilityRevision);
  let persisted: string | null = null;
  const receipts = vi.fn();
  const outbox = new SendOutbox({
    url: '/api/chat/local-codex/send',
    localFirstCommand: true,
    storage: {
      getItem: () => persisted,
      setItem: (_key, value) => {
        persisted = value;
      },
    },
    notify: receipts,
    fetch: async (path, init) => {
      expect(path).toBe('/api/chat/runtime/send');
      const response = await invoke('/send', JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response.body), { status: response.status });
    },
  });
  outbox.start();
  expect(outbox.enqueue(wire, 1, 'public-vertex-draft')).toBe(true);
  await vi.waitFor(
    () => expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ state: 'consumed' })),
    { timeout: 10000 },
  );
  expect(persisted).toBe('[]');
  outbox.stop();
  // HTTP preparation has finished. A late deadline callback cannot abort the
  // admitted conversation or its subsequent frozen followup.
  const deadline = preparationTimers.mock.calls.find(([, delay]) => delay === 120000)?.[0];
  expect(deadline).toBeTypeOf('function');
  if (typeof deadline === 'function') deadline();
  await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
  expect(providerInputs[0]).toContain(agentLibrarySource.content);
  expect(providerInputs[0].split(agentLibrarySource.content)).toHaveLength(2);
  const publicUser = chat.eventStore
    .getSessionEvents(f.reservation.conversationId)
    .find((event) => event.type === 'user_message');
  expect(publicUser?.payload).toMatchObject({
    text: f.request.payload.text,
    sourceSnapshots: [agentLibrarySource],
  });
  const { OrdinaryLocalCodexSelectionOwner } =
    await import('../ordinary-local-codex-selection-owner.js');
  const assertSelection = OrdinaryLocalCodexSelectionOwner.prototype.assertCurrent;
  let releaseAdmission!: () => void;
  let admissionWaiting = false;
  const pendingAuthority = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  const selectionSpy = vi
    .spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent')
    .mockImplementation(async function (
      this: InstanceType<typeof OrdinaryLocalCodexSelectionOwner>,
      expected,
    ) {
      if (expected.selection.model === 'next-model') {
        admissionWaiting = true;
        await pendingAuthority;
      }
      return assertSelection.call(this, expected);
    });
  const expired = invoke('/continue', {
    ...wire,
    sessionId: f.reservation.conversationId,
    clientMsgId: 'expired-followup',
    selection: { ...wire.selection, model: 'next-model', thinking: 'high' },
    payload: { text: 'Never admitted' },
  });
  await vi.waitFor(() => expect(admissionWaiting).toBe(true));
  const followupDeadline = preparationTimers.mock.calls
    .filter(([, delay]) => delay === 120000)
    .at(-1)?.[0];
  expect(followupDeadline).toBeTypeOf('function');
  if (typeof followupDeadline === 'function') followupDeadline();
  releaseAdmission();
  expect((await expired).status).toBe(409);
  expect(chat.eventStore.getSendCommand('expired-followup')).toBeUndefined();
  expect(
    chat.registry.findBySessionId(f.reservation.conversationId)?.session.abortController.signal
      .aborted,
  ).toBe(false);
  expect(services.requests).toHaveLength(1);
  selectionSpy.mockRestore();
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
  expect(services.requests[0].options.allowedTools).toContain(
    'mcp__mitzo-web-access__RequestWebAccess',
  );
  expect(services.requests[0].options.disallowedTools).not.toContain('mcp__mitzo-web-access__*');
  const servers = services.requests[0].options.mcpServers as Record<
    string,
    McpSdkServerConfigWithInstance
  >;
  expect(servers).toHaveProperty('mitzo-web-access');
  const web = servers['mitzo-web-access'];
  const webClient = new Client({ name: 'owned-web-test', version: '1' });
  const [webTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await web.instance.connect(webTransport);
  await webClient.connect(clientTransport);
  cleanups.push(async () => {
    await webClient.close();
    await web.instance.close();
  });
  expect((await webClient.listTools()).tools.map((tool) => tool.name)).toEqual([
    'RequestWebAccess',
  ]);
  expect(
    await webClient.callTool({
      name: 'RequestWebAccess',
      arguments: {
        operation: 'revoke_access',
        url: 'https://example.com',
        reason: 'Remove obsolete access',
      },
    }),
  ).toMatchObject({ isError: false });

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
  expect(services.requests[1].options.mcpServers).toHaveProperty('mitzo-web-access');
  const queriesBeforeStaleSearch = services.query.mock.calls.length;
  expect(
    await webClient.callTool({
      name: 'RequestWebAccess',
      arguments: { operation: 'search', query: 'Research', reason: 'Verify' },
    }),
  ).toMatchObject({ isError: true });
  expect(services.query).toHaveBeenCalledTimes(queriesBeforeStaleSearch);

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

it('a qualified preparation A starts model B on its original checkout and exact retry cannot launch again', async () => {
  vi.resetModules();
  const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
  const f = await ownedVertexRuntimeFixture(cleanups, {
    chatRoute: true,
    ordinaryPreparation: true,
  });
  services.workspace = f.workspace;
  services.library = f.library;
  services.authId = f.auth.id;
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('No offline network');
    }),
  );
  const { nativeStartupSessionId } = await import('../ordinary-repository-startup.js');
  const selection = {
    runOn: 'local' as const,
    runtime: {
      account: f.request.runtime.account,
      harness: 'claude-sdk' as const,
      targetId: 'local-mac',
    },
  };
  const preview = await f.workspace.preview(
    f.reservation.binding,
    'fixture-github',
    'example/repo',
    f.signal.signal,
    selection,
  );
  const ready = await f.workspace.prepare(preview.id, f.reservation.binding, f.signal.signal);
  const original = f.workspace.get(ready.id);
  expect(original.ordinaryPreparation?.originalBinding.model).toBe('fixture-model');
  expect(ready.ordinaryRuntime?.account).toEqual(f.request.runtime.account);
  expect(JSON.stringify(ready)).not.toMatch(
    /credentialDigest|sourceIdentity|adc.json|refresh_token/,
  );
  const claim = vi.spyOn(f.workspace, 'claimReservedHostTask');
  let deferSettingsClose = false;
  let settingsCloseWaiting = false;
  let releaseSettingsClose!: () => void;
  const observedInputs: string[] = [];
  services.query.mockImplementation((request) => {
    services.requests.push(request);
    const id = request.options.sessionId ?? request.options.resume;
    const process = request.options.spawnClaudeCodeProcess({
      signal: request.options.abortController.signal,
    });
    return {
      close: () => {
        if (deferSettingsClose) {
          settingsCloseWaiting = true;
          releaseSettingsClose = () => process.emit('close', 0, null);
        } else process.emit('close', 0, null);
      },
      interrupt: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for await (const message of request.prompt) {
          observedInputs.push(message.mitzoMessageId);
          yield {
            type: 'user',
            uuid: `input-${message.mitzoMessageId}`,
            message: { role: 'user', content: message.message.content },
          };
          yield {
            type: 'result',
            subtype: 'success',
            result: 'Done',
            is_error: false,
            session_id: id,
            uuid: `result-${message.mitzoMessageId}`,
          };
        }
      },
    };
  });
  const chat = await import('../chat.js');
  const sessionId = nativeStartupSessionId(`repository:${ready.id}`);
  cleanups.push(async () => {
    chat.registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner?.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
    chat.eventStore.close();
  });
  const { createOwnedLocalCodexEntryRouter } = await import('../ordinary-local-codex-entry.js');
  const router = createOwnedLocalCodexEntryRouter(
    { isOpen: () => true, isOwnedBy: () => true } as never,
    {
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      connRegistry: {
        get: () => ({ transport: { send: vi.fn(), isOpen: () => true } }),
        watch: vi.fn(),
        setActive: vi.fn(),
      } as never,
    },
    true,
  );
  const invoke = (body: unknown, url = '/send', auth: import('../auth.js').AuthSession = f.auth) =>
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
        router as import('express').Router & {
          handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
        }
      ).handle(req, res, (error) => (error ? reject(error) : resolve({ status: 404, body: {} })));
    });
  const wire = {
    ...f.request,
    runOn: 'local',
    repositoryWorkspaceId: ready.id,
    clientMsgId: 'prepared-first-B',
    selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
  };
  expect(
    (
      await invoke({
        ...wire,
        runtime: {
          ...wire.runtime,
          account: { ...wire.runtime.account, profileRevision: 'changed' },
        },
      })
    ).status,
  ).toBe(409);
  expect(
    (await invoke({ ...wire, runtime: { ...wire.runtime, targetId: 'changed' } })).status,
  ).toBe(409);
  expect(services.requests).toHaveLength(0);
  expect(f.workspace.get(ready.id).state).toBe('ready');
  const accepted = await invoke(wire);
  expect(accepted).toMatchObject({ status: 202, body: { state: 'consumed', sessionId } });
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('TERMINAL'),
  );
  expect(services.requests[0].options.model).toBe('next-model');
  expect(services.requests[0].options.effort).toBe('high');
  const claimed = f.workspace.get(ready.id);
  expect(claimed.binding.model).toBe('next-model');
  expect(claimed.ordinaryPreparation?.originalBinding).toEqual(original.binding);
  expect(claimed.featureBranch).toBe(original.featureBranch);
  expect(claimed.sourceDigest).toBe(original.sourceDigest);
  expect(claimed.directory).toBe(`${f.reservation.taskRoot}/repo-${ready.id}/mgmt`);
  expect(chat.eventStore.getSession(sessionId)?.accountBinding?.model).toBe('next-model');
  const retry = await invoke(wire);
  expect(retry.status).toBe(202);
  expect(claim).toHaveBeenCalledTimes(1);
  expect(services.requests).toHaveLength(1);
  expect((await invoke({ ...wire, payload: { text: 'different frozen command' } })).status).toBe(
    409,
  );
  expect(
    (
      await invoke({
        ...wire,
        selection: { ...wire.selection, model: 'fixture-model', thinking: 'low' },
      })
    ).status,
  ).toBe(409);
  expect(services.requests).toHaveLength(1);
  const originalRuntime = chat.eventStore.getSessionRuntimeBinding(sessionId);
  const originalHistory = chat.eventStore.getSessionEvents(sessionId);
  const revision = claimed.binding.profileRevision;
  f.configuration[0].models = [
    { id: 'future-C', label: 'Current supported C', reasoningEfforts: ['low'] },
  ];
  f.configuration[0].label = 'Updated display label';
  f.writeProfiles();
  const originalReceipt = chat.eventStore.getOrdinaryLocalVertexCommandAdmission(wire.clientMsgId);
  expect(originalReceipt?.state).toBe('consumed');
  const retiredExactRetry = await invoke(wire);
  expect(chat.eventStore.getOrdinaryLocalVertexCommandAdmission(wire.clientMsgId)).toEqual(
    originalReceipt,
  );
  expect(services.requests).toHaveLength(1);
  expect(claim).toHaveBeenCalledTimes(1);
  expect((await invoke({ ...wire, payload: { text: 'changed historical command' } })).status).toBe(
    409,
  );
  expect((await invoke(wire, '/send', { ...f.auth, id: 'foreign-operator' })).status).toBe(403);
  expect(retiredExactRetry).toMatchObject({
    status: 202,
    body: { state: 'consumed', sessionId },
  });

  const { loadAccountProfiles } = await import('../account-profiles.js');
  expect(loadAccountProfiles().resolve('personal', 'future-C').profileRevision).toBe(revision);
  const { localVertexCapabilities, OrdinaryLocalVertexTarget } =
    await import('../ordinary-local-vertex-capabilities.js');
  const current = localVertexCapabilities(loadAccountProfiles(), new OrdinaryLocalVertexTarget(), [
    f.agentProfile,
  ]).inventory();
  expect(
    (
      await invoke(
        {
          ...wire,
          sessionId,
          clientMsgId: 'unavailable-D',
          capabilityRevision: current.capabilityRevision,
          selection: { ...wire.selection, model: 'unavailable-D', thinking: 'low' },
        },
        '/continue',
      )
    ).status,
  ).toBe(409);
  expect(chat.eventStore.getOrdinaryLocalVertexCommandAdmission('unavailable-D')).toBeUndefined();
  expect(services.requests).toHaveLength(1);
  // Expire a real idle SDK settings reopen while the original process-close
  // acknowledgement is pending. No user input exists for this allocated turn.
  deferSettingsClose = true;
  let expireSettings!: () => void;
  const originalTimer = globalThis.setTimeout;
  const timerProbe = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((handler, ms, ...args) => {
      if (ms === 120000 && typeof handler === 'function') expireSettings = () => handler(...args);
      return originalTimer(handler, ms, ...args);
    });
  const expiredSettings = invoke(
    {
      ...wire,
      sessionId,
      clientMsgId: 'expired-settings',
      capabilityRevision: current.capabilityRevision,
      selection: { ...wire.selection, model: 'future-C', thinking: 'low' },
    },
    '/continue',
  );
  await vi.waitFor(() => expect(settingsCloseWaiting).toBe(true));
  expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('RUNNING');
  expireSettings();
  deferSettingsClose = false;
  releaseSettingsClose();
  expect(await expiredSettings).toMatchObject({ status: 409 });
  timerProbe.mockRestore();
  expect(
    chat.eventStore.getExecutionTerminalReason(
      chat.eventStore.getExecutionAdmission(sessionId, 'expired-settings')!.token,
    ),
  ).toBe('abandoned');
  expect(chat.eventStore.getSendCommand('expired-settings')?.error).toBe(
    'Cancelled before SDK dispatch',
  );
  expect(chat.eventStore.hasUncertainOrdinaryCommand(sessionId)).toBe(false);
  expect(observedInputs).toEqual(['prepared-first-B']);
  expect(chat.registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner).toBeDefined();
  const continued = await invoke(
    {
      ...wire,
      clientMsgId: 'future-C',
      sessionId,
      capabilityRevision: current.capabilityRevision,
      selection: { ...wire.selection, model: 'future-C', thinking: 'low' },
    },
    '/continue',
  );
  expect(continued).toMatchObject({ status: 202, body: { state: 'consumed', sessionId } });
  await vi.waitFor(() => expect(services.requests).toHaveLength(3));
  await vi.waitFor(() =>
    expect(
      chat.eventStore.getExecutionTerminalReason(
        chat.eventStore.getExecutionAdmission(sessionId, 'future-C')!.token,
      ),
    ).toBe('completed'),
  );
  expect(services.requests[2].options.resume).toBe(sessionId);
  expect(services.requests[2].options.model).toBe('future-C');
  expect(chat.eventStore.getSessionRuntimeBinding(sessionId)).toEqual(originalRuntime);
  expect(chat.eventStore.getSession(sessionId)?.accountBinding?.model).toBe('next-model');
  expect(chat.eventStore.getSessionEvents(sessionId).slice(0, originalHistory.length)).toEqual(
    originalHistory,
  );
  expect(await invoke(wire)).toMatchObject({
    status: 202,
    body: { state: 'consumed', dispatched: false, sessionId },
  });
  expect(services.requests).toHaveLength(3);
  expect(chat.eventStore.getOrdinaryLocalVertexCommandAdmission(wire.clientMsgId)).toEqual(
    originalReceipt,
  );
  expect((await invoke({ ...wire, sessionId }, '/continue')).status).toBe(409);
  expect(
    (
      await invoke({
        ...wire,
        clientMsgId: 'future-C',
        capabilityRevision: current.capabilityRevision,
        selection: { ...wire.selection, model: 'future-C', thinking: 'low' },
      })
    ).status,
  ).toBe(409);
  expect(services.requests).toHaveLength(3);
  expect(f.workspace.get(ready.id).binding.model).toBe('next-model');
  expect(f.workspace.get(ready.id).directory).toBe(claimed.directory);
  expect(f.workspace.get(ready.id).ordinaryPreparation).toEqual(claimed.ordinaryPreparation);
  expect(claim).toHaveBeenCalledTimes(1);
  chat.registry.findBySessionId(sessionId)!.session.ordinaryRuntimeOwner!.close();
  await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
  expect(
    await invoke(
      {
        ...wire,
        clientMsgId: 'cold-future-C',
        sessionId,
        capabilityRevision: current.capabilityRevision,
        selection: { ...wire.selection, model: 'future-C', thinking: 'low' },
      },
      '/continue',
    ),
  ).toMatchObject({ status: 202, body: { state: 'consumed', sessionId } });
  await vi.waitFor(() => expect(services.requests).toHaveLength(4));
  await vi.waitFor(() =>
    expect(
      chat.eventStore.getExecutionTerminalReason(
        chat.eventStore.getExecutionAdmission(sessionId, 'cold-future-C')!.token,
      ),
    ).toBe('completed'),
  );
  expect(services.requests[3].options.resume).toBe(sessionId);
  expect(observedInputs).toEqual(['prepared-first-B', 'future-C', 'cold-future-C']);
  expect(f.workspace.get(ready.id).directory).toBe(claimed.directory);
}, 20000);

it.each(['checkout', 'SDK setup'] as const)(
  'holds an aborted entry preparation without dispatching after deferred %s returns',
  async (stage) => {
    vi.resetModules();
    const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    const chat = await import('../chat.js');
    cleanups.push(() => chat.eventStore.close());
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('Offline test has no network');
      }),
    );
    const controller = new AbortController();
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checkoutSignal: AbortSignal | undefined;
    if (stage === 'checkout') {
      const original = f.workspace.claimReservedHostTask.bind(f.workspace);
      vi.spyOn(f.workspace, 'claimReservedHostTask').mockImplementation(async (input) => {
        checkoutSignal = input.signal;
        await deferred;
        return original(input);
      });
    } else {
      const { OrdinaryLocalVertexSdkAuthority } =
        await import('../ordinary-local-vertex-sdk-authority.js');
      const original = OrdinaryLocalVertexSdkAuthority.prototype.assertCurrent;
      let calls = 0;
      vi.spyOn(OrdinaryLocalVertexSdkAuthority.prototype, 'assertCurrent').mockImplementation(
        async function (this: InstanceType<typeof OrdinaryLocalVertexSdkAuthority>, signal) {
          if (++calls === 2) {
            checkoutSignal = signal;
            await deferred;
          }
          return original.call(this, signal);
        },
      );
    }
    const { startOwnedLocalVertexCommand } = await import('../ordinary-local-vertex-entry.js');
    const pending = startOwnedLocalVertexCommand(
      { send: vi.fn(), isOpen: () => true },
      'offline-client',
      {
        command: f.request,
        reservation: f.reservation,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        ownerAuthSessionId: f.auth.id,
        ownerConnectionId: f.dependencies.operatorConnectionId,
        signal: controller.signal,
      },
    );
    const observed = pending.then(
      () => 'accepted',
      () => 'refused',
    );
    await vi.waitFor(() => expect(checkoutSignal).toBeDefined());
    controller.abort(new Error('Entry preparation deadline'));
    const aborted = checkoutSignal!.aborted;
    release();
    expect(aborted).toBe(true);
    expect(await observed).toBe('refused');
    expect(services.query).not.toHaveBeenCalled();
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull();
    expect(
      chat.eventStore.getOrdinaryLocalVertexCommandAdmission(f.request.clientMsgId)?.state,
    ).toBe('uncertain');
    expect(
      chat.eventStore.getExecutionAdmission(f.reservation.conversationId, f.request.clientMsgId),
    ).toBeUndefined();
  },
);
