import { afterEach, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
it('adopts Gemini through generic REST with original signed checkpoint, isolated workspace, FIFO, Stop and exact cold authority', async () => {
  const { ownedResponsesRuntimeFixture } =
    await import('./fixtures/owned-local-responses-runtime.js');
  const f = await ownedResponsesRuntimeFixture(cleanups, { chatRoute: true, gemini: true });
  services.workspace = f.workspace;
  services.library = f.library;
  services.authId = f.auth.id;
  vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockImplementation(async function (
    this: GoogleAuth,
  ) {
    expect(this.jsonContent).toMatchObject({
      type: 'authorized_user',
      client_id: 'offline-client',
    });
    return 'offline-google-token';
  });
  const chat = await import('../chat.js');
  const responses = await import('../responses-chat-session.js');
  const native = responses.getNativeResponsesStore();
  cleanups.push(() => {
    const live = chat.registry.findBySessionId(f.reservation.conversationId);
    if (live) chat.registry.abort(live.clientId);
    chat.eventStore.close();
    native.close();
  });
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let hold = false;
  let release: () => void = () => {};
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe(
      'https://europe-west1-aiplatform.googleapis.com/v1/projects/original-project/locations/europe-west1/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(init.headers).toMatchObject({ Authorization: 'Bearer offline-google-token' });
    const body = JSON.parse(String(init.body));
    requests.push({ url: String(url), body });
    const receipt = chat.eventStore.getLatestOrdinaryCommandAdmission(f.reservation.conversationId);
    expect(receipt?.state).toBe('consumed');
    const result = () =>
      new Response(
        JSON.stringify({
          responseId: `native-${requests.length}`,
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: `answer-${requests.length}`,
                    thoughtSignature: `signature-${requests.length}`,
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        }),
      );
    if (hold) {
      hold = false;
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(result());
        init.signal?.addEventListener('abort', () => reject(Error('offline stopped')), {
          once: true,
        });
      });
    }
    return result();
  });
  vi.stubGlobal('fetch', fetch);
  const transport = { send: vi.fn(), isOpen: () => true };
  const router = (
    await import('../ordinary-local-codex-entry.js')
  ).createOwnedLocalCodexEntryRouter(
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
    method = 'POST',
    auth = f.auth,
  ) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      let status = 200;
      const req = {
        method,
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
  expect(wire.runtime.harness).toBe('gemini');
  expect(process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED).toBe('1');
  await expect(invoke('/send', wire)).resolves.toMatchObject({
    status: 202,
    body: { state: 'consumed', dispatched: true },
  });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  const original = native.load(f.reservation.conversationId, f.reservation.binding)!;
  expect(original.checkpoint!.input).toContainEqual({
    role: 'model',
    parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
  });
  const command = (id: string, text: string) => ({
    ...wire,
    sessionId: f.reservation.conversationId,
    clientMsgId: id,
    payload: { text },
  });
  for (const [id, selection] of [
    ['different-model', { ...wire.selection, model: 'gemini-2.5-flash', thinking: 'high' }],
    ['different-thinking', { ...wire.selection, thinking: 'high' }],
  ] as const) {
    const invalid = { ...command(id, 'Changed native choice'), selection };
    await expect(invoke('/continue', invalid)).resolves.toMatchObject({ status: 409 });
    expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(id)).toBeUndefined();
    expect(native.load(f.reservation.conversationId, f.reservation.binding)).toEqual(original);
    expect(invalid.selection).toEqual(selection);
  }
  await expect(invoke('/continue', command('follow', 'Same task'))).resolves.toMatchObject({
    status: 202,
  });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  expect(requests[1].body.contents as unknown[]).toContainEqual({
    role: 'model',
    parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
  });
  const cwd = chat.eventStore.getSession(f.reservation.conversationId)!.cwd;
  expect(cwd).toBe(f.reserved.directory);
  expect(cwd).not.toBe(join(f.root, 'source'));
  const firstClient = chat.registry.findBySessionId(f.reservation.conversationId)!.clientId;
  chat.registry.get(firstClient)!.ordinaryRuntimeOwner!.close();
  await vi.waitFor(() =>
    expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
  );
  expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
    true,
  );
  await expect(invoke('/continue', command('cold', 'Retained task'))).resolves.toMatchObject({
    status: 202,
  });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  expect(chat.eventStore.getSession(f.reservation.conversationId)!.cwd).toBe(cwd);
  expect(requests[2].body.contents as unknown[]).toContainEqual({
    role: 'model',
    parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
  });
  hold = true;
  await expect(invoke('/continue', command('held', 'Hold turn'))).resolves.toMatchObject({
    status: 202,
  });
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  await expect(invoke('/continue', command('queued', 'Frozen future'))).resolves.toMatchObject({
    status: 202,
  });
  expect(requests).toHaveLength(4);
  const queues = await import('../ordinary-local-responses-queue.js');
  const queueRouter = (await import('../codex-queue-routes.js')).createCodexQueueRouter({
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
  ).toMatchObject({ queued: 1, model: 'gemini-2.5-pro', reasoningEffort: 'low', retryable: false });
  await expect(
    invoke(`/${f.reservation.conversationId}/codex-queue/queued/cancel`, {}, queueRouter, 'POST', {
      ...f.auth,
      id: randomUUID(),
    }),
  ).resolves.toMatchObject({ status: 409 });
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toContain(
    'queued',
  );
  release();
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
  );
  expect(requests[4].body.contents as unknown[]).toContainEqual({
    role: 'model',
    parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
  });
  hold = true;
  await invoke('/continue', command('stopped', 'Stop active turn'));
  await vi.waitFor(() => expect(requests).toHaveLength(6));
  const live = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
  await responses.getResponsesRuntime(live)!.interrupt();
  await vi.waitFor(() =>
    expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('interrupted'),
  );
  expect(native.queue(f.reservation.conversationId, f.reservation.binding).paused).toBe(true);
  const before = chat.eventStore.getLatestOrdinaryCommandAdmission(f.reservation.conversationId);
  await writeFile(
    join(f.dependencies.privateRoot, 'google-adc.json'),
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'changed',
      client_secret: 'offline',
      refresh_token: 'offline',
    }),
    { mode: 0o600 },
  );
  await expect(
    invoke('/continue', command('authority-lost', 'No new effect')),
  ).resolves.toMatchObject({ status: 409 });
  expect(chat.eventStore.getLatestOrdinaryCommandAdmission(f.reservation.conversationId)).toEqual(
    before,
  );
  expect(requests).toHaveLength(6);
  expect(services.manager.resolveKey).not.toHaveBeenCalled();
}, 15000);
