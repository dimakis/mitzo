import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { AccountProfiles } from '../account-profiles.js';
import {
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from '../ordinary-openshell-codex-route.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
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
  continue: vi.fn(),
  start: vi.fn(),
  startShell: vi.fn(),
  continueShell: vi.fn(),
  shellTarget: vi.fn(),
  shellResumable: false,
  workspace: vi.fn(),
  library: vi.fn(),
  profiles: vi.fn(),
  controller: false,
  owner: false,
  root: '/offline/task-host',
}));
vi.mock('../chat.js', () => ({
  startOwnedLocalCodexCommand: fixtures.start,
  sendOwnedLocalCodexCommand: fixtures.continue,
  canResumeOwnedLocalCodexDriver: () => false,
  BASE_REPO: fixtures.root,
}));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  loadOrdinaryOpenShellCodexTarget: fixtures.shellTarget,
}));
vi.mock('../ordinary-openshell-codex-entry.js', () => ({
  startOwnedOpenShellCodexCommand: fixtures.startShell,
  sendOwnedOpenShellCodexCommand: fixtures.continueShell,
  canResumeOwnedOpenShellCodexDriver: () => fixtures.shellResumable,
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
  fixtures.shellTarget.mockReturnValue(undefined);
  fixtures.shellResumable = false;
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
      versions: [
        eligible,
        { ...eligible, kind: 'builtin' },
        { ...eligible, profileId: 'recipe', definition: { contextRecipe: {} } },
      ],
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

it.each(['builtin', 'user'])(
  'refuses caller agent namespace %s before any lazy/source owner',
  async (kind) => {
    const response = await send({
      ...input(),
      selection: { ...input().selection, agent: { ...input().selection.agent, kind } },
    });
    expect(response.status).toBe(400);
    expect(fixtures.profiles).not.toHaveBeenCalled();
    expect(fixtures.library).not.toHaveBeenCalled();
    expect(fixtures.reserve).not.toHaveBeenCalled();
    expect(fixtures.start).not.toHaveBeenCalled();
  },
);

it('refuses a builtin catalog result before reserving the published user-profile task', async () => {
  fixtures.library.mockReturnValue({
    version: () => ({ kind: 'builtin', definition: { name: 'Published' } }),
  });
  expect((await send()).status).toBe(409);
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
});

it('admits a follow-up only through the original live authenticated owner without reserving another checkout', async () => {
  expect((await send()).status).toBe(202);
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  sessions.register('retained-live', {
    transport: conns.get('entry-stream')!.transport,
    abortController: new AbortController(),
    sessionId,
    mode: 'ask',
    sessionAllowList: new Set(),
    ownedLocalAuthSessionId: auth.id,
  });
  fixtures.continue.mockImplementation(async (args) => {
    const resolution = catalog.resolve(args.command.runtime);
    if (resolution.status !== 'compatible') throw new Error('Expected a compatible runtime');
    store.admitOrdinaryLocalContinuation(
      {
        sessionId,
        cwd: '/offline/checkout',
        repositoryWorkspaceId: workspaceId,
        accountBinding: binding,
      },
      resolution.binding,
      {
        clientMsgId: args.command.clientMsgId,
        requestFingerprint: 'next-command',
        selection: args.command.selection,
        payload: args.command.payload,
      },
    );
    store.claimOrdinaryLocalCommandDispatch(args.command.clientMsgId);
    store.completeOrdinaryLocalCommand(args.command.clientMsgId);
    return { dispatched: true, sessionId };
  });
  fixtures.reserve.mockClear();
  fixtures.start.mockClear();
  const response = await invoke('POST', '/continue', {
    ...input(),
    sessionId,
    clientMsgId: 'next-command',
    payload: { text: 'Follow up' },
  });
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    ok: true,
    sessionId,
    clientMsgId: 'next-command',
    state: 'consumed',
  });
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
  expect(fixtures.continue).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId,
      operatorConnectionId: expect.any(String),
      command: expect.objectContaining({ clientMsgId: 'next-command' }),
    }),
  );
});
it('refuses cold or foreign follow-up entry until its original custody owner is available', async () => {
  expect((await send()).status).toBe(202);
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  const response = await invoke('POST', '/continue', {
    ...input(),
    sessionId,
    clientMsgId: 'next-command',
  });
  expect(response.status).toBe(409);
  expect(fixtures.continue).not.toHaveBeenCalled();
  sessions.register('foreign-live', {
    transport: conns.get('entry-stream')!.transport,
    abortController: new AbortController(),
    sessionId,
    mode: 'ask',
    sessionAllowList: new Set(),
    ownedLocalAuthSessionId: 'foreign',
  });
  expect(
    (await invoke('POST', '/continue', { ...input(), sessionId, clientMsgId: 'next-command' }))
      .status,
  ).toBe(403);
  expect(fixtures.continue).not.toHaveBeenCalled();
});

it('combines trusted routes for the existing picker while retaining OpenShell as an unavailable default', async () => {
  fixtures.library.mockReturnValue({ list: () => ({ versions: [] }) });
  router = createOwnedLocalCodexEntryRouter(
    streams,
    { connRegistry: conns, sessionRegistry: sessions, eventStore: store },
    true,
  );
  const response = await invoke('GET', '/capabilities', undefined);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    defaultLocation: 'openshell',
    locations: expect.arrayContaining([
      { location: 'openshell', status: 'unavailable', reason: 'OpenShell is not enabled.' },
    ]),
  });
  const combined = response.body as { routes: Array<{ capabilityRevision: string }> };
  expect(
    combined.routes.every(
      (route) => route.capabilityRevision === catalog.inventory().capabilityRevision,
    ),
  ).toBe(true);
});

function configuredShell() {
  const config = {
    cli: '/fixture/openshell',
    image: 'fixture-image',
    policy: '/fixture/policy',
    seed: '/fixture/seed',
    workspace: 'fixture-workspace',
    gateway: 'fixture-gateway',
    gatewayInsecure: false,
    workdir: '/sandbox/workspaces/task',
    serviceProviders: [],
    grantableServiceProviders: [],
    createDetached: true,
    sandboxIdLength: 24,
    webSearch: 'disabled',
  } satisfies OpenShellRuntimeConfig;
  const shellProfiles = new AccountProfiles(
    [
      {
        id: 'brokered',
        label: 'Personal ChatGPT',
        provider: 'openai-codex',
        email: 'fixture@example.test',
        planType: 'plus',
        sandboxProvider: 'provider',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        models: [{ id: 'fixture', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'shell',
    runtimeContractRevision: 'contract',
    config,
    openaiApi: 'disabled',
  });
  const projection = projectOrdinaryOpenShellCodexCapabilities({
    profiles: shellProfiles,
    target,
    deployment: 'ordinary',
  });
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  fixtures.shellTarget.mockReturnValue({ target, config });
  fixtures.profiles.mockReturnValue(shellProfiles);
  fixtures.library.mockReturnValue({
    version: () => ({
      profileId: 'published',
      revision: 1,
      contentHash: 'a'.repeat(64),
      definition: {
        name: 'Published',
        role: 'developer',
        instructions: 'Use this task workspace.',
        expectedOutput: 'Tested changes',
        acceptanceCriteria: ['Offline tests pass'],
        modelPolicyRole: 'worker',
      },
    }),
    list: () => ({ versions: [] }),
  });
  router = createOwnedLocalCodexEntryRouter(
    streams,
    { connRegistry: conns, sessionRegistry: sessions, eventStore: store },
    true,
  );
  const request = {
    ...input(),
    runOn: 'openshell',
    capabilityRevision: projection.inventory.capabilityRevision,
    runtime: {
      account: projection.inventory.accounts[0].account,
      harness: 'codex',
      targetId: 'shell',
      mode: 'agent',
    },
    selection: { ...input().selection, permission: { mode: 'agent', revision: 0 } },
  };
  const admittedBinding = {
    version: 2,
    account: request.runtime.account,
    harness: { implementation: 'codex' },
    execution: { location: 'openshell', targetId: 'shell', targetRevision: target.targetRevision },
  };
  fixtures.startShell.mockImplementation(async (_transport, _client, args) => {
    const meta = { ...args.meta, cwd: config.workdir };
    const admission = {
      clientMsgId: args.command.clientMsgId,
      requestFingerprint: 'offline-shell-' + args.command.clientMsgId,
      selection: args.command.selection,
      payload: args.command.payload,
    };
    if (args.resume) store.admitOrdinaryOpenShellContinuation(meta, admittedBinding, admission);
    else store.admitOrdinaryOpenShellCommand(meta, admittedBinding, admission);
    store.claimOrdinaryOpenShellCommandDispatch(admission.clientMsgId);
    store.completeOrdinaryOpenShellCommand(admission.clientMsgId);
    return { dispatched: true, sessionId: meta.sessionId };
  });
  return { request, config, shellProfiles, admittedBinding };
}
it('dispatches the generic OpenShell route with original account billing and no Local checkout effects', async () => {
  const { request, config, shellProfiles } = configuredShell();
  expect((await invoke('POST', '/send', request)).status).toBe(202);
  expect(fixtures.startShell).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    expect.objectContaining({
      meta: expect.objectContaining({
        cwd: config.workdir,
        accountBinding: shellProfiles.resolve('brokered', 'fixture'),
      }),
      resume: false,
    }),
  );
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
  const capabilities = await invoke('GET', '/capabilities', undefined);
  expect(capabilities.status).toBe(200);
  expect(capabilities.body).toMatchObject({
    defaultLocation: 'openshell',
    locations: expect.arrayContaining([{ location: 'openshell', status: 'configured' }]),
    targets: expect.arrayContaining([
      {
        targetId: 'shell',
        targetRevision: expect.any(String),
        label: 'OpenShell',
        location: 'openshell',
        harness: 'codex',
      },
    ]),
  });
  expect(JSON.stringify(capabilities.body)).not.toContain(config.gateway);
});
it('reopens an OpenShell follow-up only with original cold custody and freezes a separate command receipt', async () => {
  const { request } = configuredShell();
  expect((await invoke('POST', '/send', request)).status).toBe(202);
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  const next = {
    ...request,
    sessionId,
    clientMsgId: 'shell-next',
    payload: { text: 'Second publication' },
  };
  expect((await invoke('POST', '/continue', next)).status).toBe(409);
  fixtures.shellResumable = true;
  expect((await invoke('POST', '/continue', next)).status).toBe(202);
  expect(fixtures.startShell.mock.calls[1][2]).toMatchObject({
    resume: true,
    meta: { sessionId, repositoryWorkspaceId: workspaceId },
  });
  expect(store.getOrdinaryOpenShellCommandAdmission('shell-next')).toMatchObject({
    state: 'consumed',
  });
  expect(store.getSessionRuntimeBinding(sessionId)).toMatchObject({
    execution: { location: 'openshell' },
  });
  expect(fixtures.reserve).not.toHaveBeenCalled();
});
it('keeps usable Local choices visible when an enabled OpenShell target is unavailable', async () => {
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  fixtures.library.mockReturnValue({ list: () => ({ versions: [] }) });
  router = createOwnedLocalCodexEntryRouter(
    streams,
    { connRegistry: conns, sessionRegistry: sessions, eventStore: store },
    true,
  );
  const response = await invoke('GET', '/capabilities', undefined);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    accounts: expect.arrayContaining([{ ...catalog.inventory().accounts[0] }]),
    locations: expect.arrayContaining([
      {
        location: 'openshell',
        status: 'unavailable',
        reason: 'The configured OpenShell route is unavailable.',
      },
    ]),
  });
  expect(fixtures.shellTarget).toHaveBeenCalled();
  expect(fixtures.startShell).not.toHaveBeenCalled();
});
