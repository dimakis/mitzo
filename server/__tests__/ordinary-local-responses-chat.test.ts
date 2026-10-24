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
it('rejects both new and retained OpenAI Responses execution through actual ordinary HTTP admission', async () => {
  vi.resetModules();
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
    chat.eventStore.close();
    native.close();
  });
  const claim = vi.spyOn(f.workspace, 'claimReservedHostTask');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
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
        json(value: unknown) {
          resolve({ status, body: value as Record<string, unknown> });
          return this;
        },
      };
      (
        router as import('express').Router & {
          handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
        }
      ).handle(req, res, (error) => reject(error ?? Error('Unhandled route')));
    });
  const wire = { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id };
  expect(await invoke('/send', wire)).toMatchObject({
    status: 409,
    body: { code: 'new_work_harness_unsupported' },
  });
  const runtime = {
    version: 2 as const,
    account: f.request.runtime.account,
    harness: { implementation: 'responses' as const },
    execution: {
      location: 'local' as const,
      targetId: f.request.runtime.targetId,
      targetRevision: 'retained',
    },
  };
  chat.eventStore.createSessionWithRuntimeBinding(
    {
      sessionId: f.reservation.conversationId,
      accountBinding: f.reservation.binding,
      repositoryWorkspaceId: f.reservation.id,
      cwd: f.reserved.directory,
      initialPrompt: 'Retained original request',
    },
    runtime,
  );
  native.save(f.reservation.conversationId, f.reservation.binding, {
    status: 'interrupted',
    history: [{ role: 'user', content: 'Original history' }],
  });
  expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
    false,
  );
  expect(
    await invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'new-native-required',
    }),
  ).toMatchObject({ status: 409, body: { code: 'bound_route_unavailable' } });
  await expect(
    chat.startOwnedLocalResponsesCommand(transport, 'retired', {
      command: f.request,
      reservation: f.reservation,
      operatorConnectionId: f.dependencies.operatorConnectionId,
      ownerAuthSessionId: f.auth.id,
      resume: true,
    }),
  ).rejects.toThrow('retired');
  expect(claim).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(services.manager.resolveKey).not.toHaveBeenCalled();
  expect(chat.eventStore.getSession(f.reservation.conversationId)?.initialPrompt).toBe(
    'Retained original request',
  );
  expect(native.load(f.reservation.conversationId, f.reservation.binding)?.history).toEqual([
    { role: 'user', content: 'Original history' },
  ]);
});
