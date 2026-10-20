import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { join } from 'node:path';

const services = vi.hoisted(() => ({
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
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model calls');
  },
}));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('preserves actual started Responses repository continuation metadata when only Local Codex is disabled', async () => {
  vi.resetModules();
  const calls: Array<{
    url: string;
    method: string | undefined;
    bodyType: string;
    body: unknown;
  }> = [];
  const unexpectedUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method,
        bodyType: typeof init?.body,
        body: init?.body,
      });
      if (String(url) !== 'https://api.openai.com/v1/responses') {
        unexpectedUrls.push(String(url));
        throw Error('Unexpected offline provider URL: ' + String(url));
      }
      const events = [
        { type: 'response.created', response: { id: 'metadata-response', model: 'fixture-model' } },
        {
          type: 'response.completed',
          response: { output: [], usage: { input_tokens: 1, output_tokens: 0 } },
        },
      ];
      return new Response(
        events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  const { AccountProfiles } = await import('../account-profiles.js');
  const { credentials } = await import('../credentials.js');
  const fallbackCredential = vi
    .spyOn(credentials, 'resolve')
    .mockRejectedValue(Error('No host credential fallback'));
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  const { ownedResponsesRuntimeFixture } =
    await import('./fixtures/owned-local-responses-runtime.js');
  const f = await ownedResponsesRuntimeFixture(cleanup, { chatRoute: true });
  services.workspace = f.workspace;
  services.library = f.library;
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', join(f.root, 'internal-token'));
  vi.stubEnv('MITZO_KNOWLEDGE_LIBRARY_CONFIG', undefined);
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  const { createTelosCanonicalData } = await import('./fixtures/telos-canonical-advisor.js');
  const canonical = createTelosCanonicalData();
  cleanup.push(() => canonical.close());
  vi.stubEnv('TELOS_DB_PATH', canonical.dbPath);
  const chat = await import('../chat.js');
  const application = await import('../app.js');
  const auth = await import('../auth.js');
  auth.setAuthRevocationStore(chat.eventStore);
  const token = (await auth.login('test-passphrase-for-vitest'))!;
  const actor = (await auth.authenticateToken(token))!;
  expect(actor).toBeTruthy();
  const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
  const unbind = bindAgentLibraryTransport(f.dependencies.operatorConnectionId, actor);
  cleanup.push(unbind);
  const { getNativeResponsesStore } = await import('../responses-chat-session.js');
  const native = getNativeResponsesStore();
  cleanup.push(() => {
    const live = chat.registry.findBySessionId(f.reservation.conversationId);
    if (live) chat.registry.abort(live.clientId);
    auth.revokeAuthSession(actor);
    chat.eventStore.close();
    application.taskStore.close();
    native.close();
  });
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  const launch = vi.spyOn(CodexAppServerClient, 'launchIsolated').mockImplementation(() => {
    throw Error('No Local Codex launch');
  });
  const { repositoryPreparedCommandStatus } = await import('../repository-prepared-command.js');
  const firstOnlyAuthority = vi.fn(() => {
    throw Error('Local Codex preparation authority is inapplicable to Responses');
  });
  const firstOnlyWorkspace = vi.fn(() => {
    throw Error('No Local Codex workspace qualification');
  });
  let unstartedHint: ReturnType<typeof repositoryPreparedCommandStatus> | undefined;
  const createSession = chat.eventStore.createSessionWithRuntimeBinding.bind(chat.eventStore);
  vi.spyOn(chat.eventStore, 'createSessionWithRuntimeBinding').mockImplementation(
    (meta, binding) => {
      createSession(meta, binding);
      if (meta.sessionId !== f.reservation.conversationId) return;
      // Observe the real atomic new-session owner BEFORE it records the initial command.
      // Pre-seeding a separate bound session would violate the new-session admission rule.
      expect(chat.eventStore.getSessionRuntimeBinding(meta.sessionId)?.harness.implementation).toBe(
        'responses',
      );
      expect(chat.eventStore.getOrdinaryInitialCommandId(meta.sessionId)).toBeUndefined();
      expect(calls).toEqual([]);
      unstartedHint = repositoryPreparedCommandStatus({
        events: chat.eventStore,
        workspaces: firstOnlyWorkspace,
        sessionId: meta.sessionId,
        signal: new AbortController().signal,
        assertCurrent: firstOnlyAuthority,
      });
    },
  );
  const transport = { send: vi.fn(), isOpen: () => true };
  await expect(
    chat.startOwnedLocalResponsesCommand(transport, 'metadata-responses', {
      command: f.request,
      reservation: f.reservation,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      ownerAuthSessionId: actor.id,
    }),
  ).resolves.toMatchObject({ dispatched: true });
  expect(unstartedHint).toBeDefined();
  expect.soft(await unstartedHint).toEqual({ prepared: false });
  expect.soft(firstOnlyAuthority).not.toHaveBeenCalled();
  expect.soft(firstOnlyWorkspace).not.toHaveBeenCalled();
  await vi.waitFor(
    () => {
      expect(unexpectedUrls).toEqual([]);
      expect(calls).toHaveLength(1);
    },
    { timeout: 5_000 },
  );
  expect(calls[0]).toMatchObject({
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    bodyType: 'string',
  });
  expect(JSON.parse(String(calls[0].body))).toMatchObject({
    model: f.reservation.binding.model,
    stream: true,
    store: false,
    input: expect.arrayContaining([{ role: 'user', content: f.request.payload.text }]),
  });
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  const { ordinaryCodexContinuationStatus } =
    await import('../ordinary-codex-continuation-status.js');
  expect(ordinaryCodexContinuationStatus(f.reservation.conversationId, actor.id)).toEqual({
    available: true,
  });
  expect(chat.eventStore.getOrdinaryInitialCommandId(f.reservation.conversationId)).toBe(
    f.request.clientMsgId,
  );
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(f.reservation.conversationId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'completed',
    }),
  );
  const beforeHistory = structuredClone(
    native.load(f.reservation.conversationId, f.reservation.binding),
  );
  expect(JSON.stringify(beforeHistory?.history)).toContain(f.request.payload.text);
  const beforeAdmission = chat.eventStore.getOrdinaryCommandAdmission(f.request.clientMsgId);
  const get = () =>
    request(application.app)
      .get('/api/sessions/' + f.reservation.conversationId + '/meta')
      .set('Authorization', 'Bearer ' + token);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  const enabled = await get();
  expect(enabled.status).toBe(200);
  expect(enabled.body.runtimeCommandScope).toBe('conversation');
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  expect(ordinaryCodexContinuationStatus(f.reservation.conversationId, actor.id)).toEqual({
    available: true,
  });
  const disabled = await get();
  expect(disabled.status).toBe(200);
  expect(disabled.body.runtimeBinding).toEqual(enabled.body.runtimeBinding);
  expect(disabled.body.runtimeCommandScope).toBe('conversation');
  expect(disabled.body.runtimeCommandReason).toBeUndefined();
  expect(chat.eventStore.getOrdinaryCommandAdmission(f.request.clientMsgId)).toEqual(
    beforeAdmission,
  );
  expect(native.load(f.reservation.conversationId, f.reservation.binding)).toEqual(beforeHistory);
  expect(calls).toHaveLength(1);
  expect(services.manager.resolveKey).toHaveBeenCalledOnce();
  expect(fallbackCredential).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
}, 20_000);
