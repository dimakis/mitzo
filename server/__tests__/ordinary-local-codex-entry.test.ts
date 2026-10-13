import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { AccountProfiles } from '../account-profiles.js';
import {
  OrdinaryLocalCodexCapabilityCatalog,
  OrdinaryLocalCodexTarget,
} from '../ordinary-local-codex-capabilities.js';
import { createOwnedLocalCodexEntryRouter } from '../ordinary-local-codex-entry.js';
import { ConnectionRegistry, SessionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import {
  claimTransportConnection,
  releaseTransportConnection,
} from '../transport-auth-ownership.js';
import {
  bindAgentLibraryTransport,
  captureAgentLibraryAuthorization,
} from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import {
  nativeStartupSessionId,
  reserveRepositoryStartup,
} from '../ordinary-repository-startup.js';

const fixtures = vi.hoisted(() => ({
  reserve: vi.fn(),
  start: vi.fn(),
  workspace: vi.fn(),
  library: vi.fn(),
  profiles: vi.fn(),
  controller: false,
  owner: false,
  root: '/offline/task-host',
}));
vi.mock('../chat.js', () => ({
  startOwnedLocalCodexCommand: fixtures.start,
  BASE_REPO: fixtures.root,
}));
vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: fixtures.profiles,
}));
vi.mock('../agent-library-runtime.js', () => ({ getAgentLibrary: fixtures.library }));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: fixtures.workspace,
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: undefined,
  get custodianControllerMode() {
    return fixtures.controller;
  },
  get custodianOwnerMode() {
    return fixtures.owner;
  },
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  operatorAuthMiddleware: (_req: unknown, res: express.Response, next: express.NextFunction) =>
    res.locals.authSession
      ? next()
      : res.status(401).json({ error: 'Interactive authentication required' }),
}));
vi.mock('../connections-router.js', () => ({
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../ordinary-local-codex-capabilities.js', async (original) => ({
  ...(await original<object>()),
  loadOrdinaryLocalCodexTarget: () => target,
}));

const target = new OrdinaryLocalCodexTarget({
  version: 1,
  targetId: 'host',
  label: 'Local',
  hostId: 'fixture',
  runtimeContractRevision: 'contract',
});
const profiles = new AccountProfiles(
  [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: '/offline/login',
      email: 'fixture@example.test',
      planType: 'plus',
      models: [{ id: 'fixture', label: 'Offline' }],
    },
  ],
  { codexEnabled: true },
);
const binding = profiles.resolve('personal', 'fixture');
const catalog = new OrdinaryLocalCodexCapabilityCatalog(profiles, target, 'ordinary');
const workspaceId = 'cf414b54-96b4-42e7-bda4-74c55ad94ddf';
let sequence = 0;
let auth = { id: 'owned-entry-login', expiresAt: Date.now() + 600_000 };
let router: express.Router;
let store: EventStore;
let conns: ConnectionRegistry;
let streams: SessionSseRegistry;
let release: () => void;
let sessions: SessionRegistry;
const input = () => ({
  runOn: 'local',
  capabilityRevision: catalog.inventory().capabilityRevision,
  runtime: {
    account: catalog.inventory().accounts[0].account,
    harness: 'codex',
    targetId: 'host',
    mode: 'ask',
  },
  selection: {
    version: 1,
    model: 'fixture',
    thinking: null,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'ask', revision: 0 },
  },
  repositoryWorkspaceId: workspaceId,
  clientMsgId: 'owned-entry-command',
  payload: { text: 'Work on this repository' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  fixtures.controller = fixtures.owner = false;
  auth = { id: `owned-entry-login-${++sequence}`, expiresAt: Date.now() + 600_000 };
  fixtures.profiles.mockReturnValue(profiles);
  fixtures.library.mockReturnValue({ version: () => ({ definition: { name: 'Published' } }) });
  fixtures.workspace.mockReturnValue({ reserveHostTask: fixtures.reserve });
  fixtures.reserve.mockResolvedValue({ state: 'reserved' });
  fixtures.start.mockImplementation(async (_transport, _client, args) => {
    const resolved = catalog.resolve(args.command.runtime);
    if (resolved.status !== 'compatible') throw Error('Fixture route incompatible');
    store.admitOrdinaryLocalCommand(
      {
        sessionId: args.reservation.conversationId,
        cwd: '/offline/checkout',
        repositoryWorkspaceId: workspaceId,
        accountBinding: binding,
      },
      resolved.binding,
      {
        clientMsgId: args.commandId,
        requestFingerprint: 'offline-command',
        selection: args.command.selection,
        payload: args.command.payload,
      },
    );
    store.claimOrdinaryLocalCommandDispatch(args.commandId);
    store.completeOrdinaryLocalCommand(args.commandId);
    return { dispatched: true, sessionId: args.reservation.conversationId };
  });
  store = new EventStore(':memory:');
  conns = new ConnectionRegistry();
  streams = new SessionSseRegistry();
  const response = {
    write: vi.fn(() => true),
    end: vi.fn(),
    writableEnded: false,
  } as unknown as express.Response;
  streams.add('entry-stream', response, auth.id);
  conns.register('entry-stream', { send: vi.fn(), isOpen: () => true });
  claimTransportConnection('entry-stream', auth.id);
  release = bindAgentLibraryTransport('entry-stream', auth);
  sessions = new SessionRegistry();
  router = createOwnedLocalCodexEntryRouter(streams, {
    connRegistry: conns,
    sessionRegistry: sessions,
    eventStore: store,
  });
});
afterEach(() => {
  streams.remove('entry-stream');
  release();
  releaseTransportConnection('entry-stream', auth.id);
  store.close();
  vi.unstubAllEnvs();
});
const invoke = (method: string, url: string, body: unknown, login: string | null = auth.id) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const req = {
      method,
      url,
      headers: { 'x-connection-id': 'entry-stream' },
      body,
    } as unknown as express.Request;
    const res = {
      locals: login ? { authSession: { ...auth, id: login } } : {},
      status(code: number) {
        status = code;
        return this;
      },
      set() {
        return this;
      },
      json(value: unknown) {
        resolve({ status, body: value });
        return this;
      },
    } as unknown as express.Response;
    const handler = router as express.Router & {
      handle(req: express.Request, res: express.Response, next: (error?: unknown) => void): void;
    };
    handler.handle(req, res, (error) => reject(error ?? Error('Route did not handle request')));
  });

const send = (body: unknown = input(), login: string | null = auth.id) =>
  invoke('POST', '/send', body, login);

it('dispatches explicit Local with server-owned identities through the existing wrapper', async () => {
  const response = await send();
  expect(response.status).toBe(202);
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  expect(fixtures.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      id: workspaceId,
      binding,
      conversationId: sessionId,
      taskRoot: '/offline/task-host/.claude/repository-tasks',
      signal: expect.any(AbortSignal),
    }),
  );
  expect(fixtures.start).toHaveBeenCalledWith(
    conns.get('entry-stream')!.transport,
    `entry-stream:${sessionId}`,
    expect.objectContaining({
      commandId: input().clientMsgId,
      ownerConnectionId: 'entry-stream',
      reservation: {
        id: workspaceId,
        binding,
        conversationId: sessionId,
        taskRoot: '/offline/task-host/.claude/repository-tasks',
      },
      command: expect.objectContaining({
        payload: { text: input().payload.text },
        runtime: {
          account: expect.objectContaining({
            accountId: 'personal',
            provider: 'openai-codex',
            profileRevision: binding.profileRevision,
          }),
          harness: 'codex',
          targetId: 'host',
          mode: 'ask',
        },
      }),
    }),
  );
  expect(conns.get('entry-stream')!.activeSession).toBe(sessionId);
});
it.each(['', '0', 'true'])('stays off for gate %s before any lazy owner', async (gate) => {
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', gate);
  expect((await send()).status).toBe(503);
  expect(fixtures.profiles).not.toHaveBeenCalled();
  expect(fixtures.library).not.toHaveBeenCalled();
  expect(fixtures.workspace).not.toHaveBeenCalled();
});
it.each(['controller', 'owner'] as const)(
  'refuses custodian %s before lazy owners',
  async (mode) => {
    fixtures[mode] = true;
    expect((await send()).status).toBe(503);
    expect(fixtures.workspace).not.toHaveBeenCalled();
    expect(fixtures.library).not.toHaveBeenCalled();
  },
);
it('refuses foreign, absent and closed SSE authority before lazy owners', async () => {
  expect((await send(input(), 'foreign')).status).toBe(403);
  expect((await send(input(), null)).status).toBe(401);
  streams.remove('entry-stream');
  expect((await send()).status).toBe(403);
  expect(fixtures.profiles).not.toHaveBeenCalled();
  expect(fixtures.workspace).not.toHaveBeenCalled();
});
it.each([
  'cwd',
  'executablePath',
  'credentialRef',
  'auth',
  'verifier',
  'sessionId',
  'contextBlocks',
  'extraTools',
])('rejects caller %s before owners', async (key) => {
  expect((await send({ ...input(), [key]: 'forbidden' })).status).toBe(400);
  expect(fixtures.workspace).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
});
it('refuses stale capabilities and unsupported published context before reservation', async () => {
  expect((await send({ ...input(), capabilityRevision: 'stale' })).status).toBe(409);
  fixtures.library.mockReturnValue({ version: () => ({ definition: { contextRecipe: {} } }) });
  expect((await send()).status).toBe(409);
  expect(fixtures.reserve).not.toHaveBeenCalled();
});
it('does not rewrite command receipts or discard reservations on uncertain failure', async () => {
  fixtures.start.mockRejectedValue(Error('private native configuration'));
  const fail = vi.spyOn(store, 'failSendCommand');
  const response = await send();
  expect(response.status).toBe(409);
  expect(JSON.stringify(response.body)).not.toContain('private');
  expect(fail).not.toHaveBeenCalled();
  expect(fixtures.reserve).toHaveBeenCalledTimes(1);
});
it('refuses a foreign or unmarked live owner before lazy/source effects', async () => {
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  sessions.register('live', {
    transport: conns.get('entry-stream')!.transport,
    abortController: new AbortController(),
    sessionId,
    mode: 'ask',
    sessionAllowList: new Set(),
    ownedLocalAuthSessionId: 'another-login',
  });
  expect((await send()).status).toBe(403);
  expect(fixtures.profiles).not.toHaveBeenCalled();
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
  delete sessions.get('live')!.ownedLocalAuthSessionId;
  expect((await send()).status).toBe(403);
});
it('refuses unavailable models and thinking before reserving source', async () => {
  expect(
    (await send({ ...input(), selection: { ...input().selection, model: 'missing' } })).status,
  ).toBe(409);
  expect(
    (await send({ ...input(), selection: { ...input().selection, thinking: 'unsupported' } }))
      .status,
  ).toBe(409);
  expect(fixtures.reserve).not.toHaveBeenCalled();
});
it('shares the early repository exclusion before lazy/preflight effects', async () => {
  const unlock = reserveRepositoryStartup(nativeStartupSessionId(`repository:${workspaceId}`));
  try {
    expect((await send()).status).toBe(409);
    expect(fixtures.profiles).not.toHaveBeenCalled();
    expect(fixtures.reserve).not.toHaveBeenCalled();
  } finally {
    unlock();
  }
  expect((await send()).status).toBe(202);
});
it('retains current auth through stream detach and releases only entry lifetime', async () => {
  fixtures.reserve.mockImplementationOnce(async () => {
    release();
    streams.remove('entry-stream');
    conns.remove('entry-stream');
    return { state: 'reserved' };
  });
  const realStart = fixtures.start.getMockImplementation()!;
  fixtures.start.mockImplementationOnce(async (...args) => {
    captureAgentLibraryAuthorization(args[2].operatorConnectionId).assertCurrent();
    return realStart(...args);
  });
  expect((await send()).status).toBe(202);
  const args = fixtures.start.mock.calls[0][2];
  expect(args.signal.aborted).toBe(false);
  expect(() => captureAgentLibraryAuthorization(args.operatorConnectionId)).toThrow();
});
it('aborts retained preparation on logout before bootstrap/dispatch', async () => {
  let preparationSignal: AbortSignal | undefined;
  fixtures.reserve.mockImplementationOnce(async (args) => {
    preparationSignal = args.signal;
    revokeAuthSession(auth);
    return { state: 'reserved' };
  });
  expect((await send()).status).toBe(409);
  expect(preparationSignal?.aborted).toBe(true);
  expect(fixtures.start).not.toHaveBeenCalled();
});
it('returns an exact consumed duplicate without changing original receipt', async () => {
  expect((await send()).status).toBe(202);
  const original = store.getOrdinaryLocalCommandAdmission(input().clientMsgId);
  fixtures.start.mockResolvedValueOnce({
    dispatched: false,
    sessionId: nativeStartupSessionId(`repository:${workspaceId}`),
  });
  const response = await send();
  expect(response.body).toEqual(
    expect.objectContaining({ ok: true, dispatched: false, state: 'consumed' }),
  );
  expect(store.getOrdinaryLocalCommandAdmission(input().clientMsgId)).toEqual(original);
});
it('bounds startup cancellation without attaching it to the HTTP/SSE lifetime', async () => {
  vi.useFakeTimers();
  try {
    fixtures.reserve.mockImplementationOnce(
      (args) =>
        new Promise((resolve) =>
          args.signal.addEventListener('abort', () => resolve({ state: 'reserved' }), {
            once: true,
          }),
        ),
    );
    const pending = send();
    await vi.advanceTimersByTimeAsync(120000);
    expect((await pending).status).toBe(409);
    expect(fixtures.start).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('projects configuration-only eligible account tuples and published profiles without native effects', async () => {
  const personal = {
    id: 'personal',
    label: 'Personal',
    provider: 'openai-codex' as const,
    credentialRef: '/offline/login',
    email: 'fixture@example.test',
    planType: 'plus',
    models: [{ id: 'fixture', label: 'Offline' }],
  };
  fixtures.profiles.mockReturnValue(
    new AccountProfiles(
      [personal, { ...personal, id: 'workspace', workspaceId: 'sandbox-owned' }],
      { codexEnabled: true },
    ),
  );
  const eligible = {
    profileId: 'published',
    revision: 1,
    contentHash: 'a'.repeat(64),
    definition: { name: 'Published' },
  };
  fixtures.library.mockReturnValue({
    list: () => ({
      versions: [eligible, { ...eligible, profileId: 'recipe', definition: { contextRecipe: {} } }],
    }),
  });
  const response = await invoke('GET', '/capabilities', undefined);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    agentProfiles: [eligible],
  });
  const inventory = response.body as {
    accounts: Array<{ account: { accountId: string } }>;
    routes: Array<{ account: { accountId: string } }>;
  };
  expect(inventory.accounts.map(({ account }) => account.accountId)).toEqual(['personal']);
  expect(inventory.routes.every(({ account }) => account.accountId === 'personal')).toBe(true);
  expect(fixtures.workspace).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
});
