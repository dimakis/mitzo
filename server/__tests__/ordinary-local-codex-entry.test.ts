import { OrdinaryRepositoryPreparationSchema } from '../ordinary-repository-preparation.js';
import { buildAgentProfilePrompt } from '../agent-library-prompt.js';
import { canonicalJson } from '../connections/capabilities/input-validation.js';
import { openShellPhysicalCustodyFingerprint } from '../openshell-codex-custody.js';
import type { ArtifactRuntime } from '../codex-conversation-store.js';
import {
  ordinaryLocalCommandFingerprint,
  ordinaryLocalCodexBootstrapId,
} from '../ordinary-local-codex-admission.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import { contextDigest } from '../agent-context-compiler.js';
import {
  LocalCodexFirstCommandSchema,
  PROFILE_BUILDER_ID,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  PROFILE_BUILDER_REVISION,
} from '@mitzo/protocol';
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
  reserveSandbox: vi.fn(),
  continue: vi.fn(),
  start: vi.fn(),
  startShell: vi.fn(),
  continueShell: vi.fn(),
  shellTarget: vi.fn(),
  shellResumable: false,
  workspace: vi.fn(),
  ordinaryWorkspace: vi.fn(),
  library: vi.fn(),
  profiles: vi.fn(),
  controller: false,
  owner: false,
  root: '/offline/task-host',
  shellCustody: vi.fn(),
  shellArtifact: vi.fn(),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexConversationStore: () => ({
    readHostCustody: (sessionId: string) => ({
      authSessionId: auth.id,
      bootstrapId: ordinaryLocalCodexBootstrapId(
        sessionId,
        store.getOrdinaryCommandAdmission(store.getOrdinaryInitialCommandId(sessionId)!)!
          .requestFingerprint,
      ),
    }),
    readOpenShellCustody: fixtures.shellCustody,
    readArtifactRuntime: fixtures.shellArtifact,
    read: (conversationId: string) => ({
      conversationId,
      cwd: fixtures.shellArtifact() ? '/sandbox/workspaces/task' : '/offline/checkout',
      threadId: 'offline-retained-thread',
    }),
  }),
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
  getOrdinaryWorkspaces: fixtures.ordinaryWorkspace,
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

const publishedDefinition = {
  name: 'Published',
  role: 'agent',
  instructions: 'Use the original checkout.',
  expectedOutput: 'Evidence',
  acceptanceCriteria: ['Preserve ownership'],
  modelPolicyRole: 'agent',
};
const publishedProfile = {
  profileId: 'published',
  revision: 1,
  definition: publishedDefinition,
  contentHash: contextDigest(publishedDefinition),
};

it.each([
  { tools: [] },
  { tools: [{ id: 'mitzo:Read', version: 1 }] },
  {
    tools: [
      {
        id: `mcp:11111111-1111-4111-8111-111111111111:${'a'.repeat(64)}`,
        version: 1,
        revision: '33333333-3333-4333-8333-333333333333',
      },
    ],
  },
])(
  'advertises supported explicit tool profiles on the actual Local Codex route: %j',
  async ({ tools }) => {
    const definition = { ...publishedDefinition, tools };
    const profile = { ...publishedProfile, definition, contentHash: contextDigest(definition) };
    fixtures.library.mockReturnValue({
      version: () => profile,
      list: () => ({ versions: [profile] }),
    });
    const response = await invoke('GET', '/capabilities', undefined);
    expect(response.status).toBe(200);
    const route = (
      response.body as {
        routes: Array<{
          location?: string;
          harness: string;
          agentProfiles: unknown[];
          agentProfileRejections: unknown[];
        }>;
      }
    ).routes.find(
      (entry: { location?: string; harness: string }) =>
        (entry.location ?? 'local') === 'local' && entry.harness === 'codex',
    );
    expect(route?.agentProfiles).toContainEqual({ profileId: 'published', revision: 1 });
    expect(route?.agentProfileRejections).not.toContainEqual(
      expect.objectContaining({ agent: { profileId: 'published', revision: 1 } }),
    );
  },
);
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
  fixtures.shellCustody.mockReturnValue(null);
  fixtures.shellArtifact.mockReturnValue(null);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  fixtures.controller = fixtures.owner = false;
  auth = { id: `owned-entry-login-${++sequence}`, expiresAt: Date.now() + 600_000 };
  fixtures.profiles.mockReturnValue(profiles);
  fixtures.library.mockReturnValue({ version: () => publishedProfile });
  fixtures.workspace.mockReturnValue({
    get: () => ({ state: 'claimed' }),
    reserveHostTask: fixtures.reserve,
    reserveOrdinarySandboxTask: fixtures.reserveSandbox,
  });
  fixtures.reserveSandbox.mockResolvedValue(undefined);
  fixtures.reserve.mockResolvedValue({ state: 'reserved' });
  fixtures.start.mockImplementation(async (_transport, _client, args) => {
    const activeProfiles = fixtures.profiles() as AccountProfiles;
    const resolved = new OrdinaryLocalCodexCapabilityCatalog(
      activeProfiles,
      target,
      'ordinary',
    ).resolve(args.command.runtime);
    const activeBinding = activeProfiles.resolve(
      args.command.runtime.account.accountId,
      args.command.selection.model,
    );
    if (resolved.status !== 'compatible') throw Error('Fixture route incompatible');
    store.admitOrdinaryLocalCommand(
      {
        sessionId: args.reservation.conversationId,
        cwd: '/offline/checkout',
        repositoryWorkspaceId: workspaceId,
        accountBinding: activeBinding,
      },
      resolved.binding,
      {
        clientMsgId: args.commandId,
        requestFingerprint: ordinaryLocalCommandFingerprint('codex', args.command, {
          workspace: { workspaceId, cwd: '/offline/checkout' },
        }),
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
const invoke = (
  method: string,
  url: string,
  body: unknown,
  login: string | null = auth.id,
  workspaceDefaults = false,
) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let status = 200;
    const req = {
      method,
      url,
      query: workspaceDefaults ? { workspaceDefaults: '1' } : {},
      headers: {
        'x-connection-id': 'entry-stream',
      },
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

it('exposes and dispatches API billing through the actual Local Codex entry', async () => {
  const api = new AccountProfiles(
    [
      {
        id: 'work',
        label: 'Work API',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'offline-test', account: 'work' },
        models: [{ id: 'fixture', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  fixtures.profiles.mockReturnValue(api);
  fixtures.library.mockReturnValue({
    version: () => publishedProfile,
    list: () => ({ versions: [publishedProfile] }),
  });
  const apiCatalog = new OrdinaryLocalCodexCapabilityCatalog(api, target, 'ordinary');
  const request = {
    ...input(),
    capabilityRevision: apiCatalog.inventory().capabilityRevision,
    runtime: { ...input().runtime, account: apiCatalog.inventory().accounts[0].account },
  };
  const capabilities = await invoke('GET', '/capabilities', undefined);
  expect(capabilities.status).toBe(200);
  expect((capabilities.body as { accounts: Array<{ account: unknown }> }).accounts).toContainEqual(
    expect.objectContaining({ account: request.runtime.account }),
  );
  expect((await send(request)).status).toBe(202);
  expect(fixtures.start).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    expect.objectContaining({
      command: expect.objectContaining({
        runtime: expect.objectContaining({ harness: 'codex', account: request.runtime.account }),
      }),
    }),
  );
});

it('dispatches explicit Local with server-owned identities through the existing wrapper', async () => {
  const response = await send();
  expect(response.status).toBe(202);
  const sessionId = nativeStartupSessionId(`repository:${workspaceId}`);
  const resolution = catalog.resolve(input().runtime);
  if (resolution.status !== 'compatible') throw Error('Expected configured fixture route');
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
        runtimeBinding: resolution.binding,
        commandFingerprint: createHash('sha256')
          .update(JSON.stringify(LocalCodexFirstCommandSchema.parse(input())))
          .digest('hex'),
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
it('observes exact consumed receipts without reserving, starting or resubmitting a command', async () => {
  expect((await invoke('POST', '/send/receipt', input())).status).toBe(409);
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
  await send();
  const starts = fixtures.start.mock.calls.length,
    reservations = fixtures.reserve.mock.calls.length;
  const result = await invoke('POST', '/send/receipt', input());
  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({ state: 'consumed', dispatched: false });
  expect(fixtures.start).toHaveBeenCalledTimes(starts);
  expect(fixtures.reserve).toHaveBeenCalledTimes(reservations);
  expect(
    (await invoke('POST', '/send/receipt', { ...input(), payload: { text: 'changed' } })).status,
  ).toBe(409);
});
it('returns an exact consumed duplicate without changing original receipt', async () => {
  expect((await send()).status).toBe(202);
  const original = store.getOrdinaryLocalCommandAdmission(input().clientMsgId);

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
  const eligible = publishedProfile;
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
    agentProfiles: [
      expect.objectContaining({
        kind: 'builtin',
        profileId: DEFAULT_MITZO_PROFILE_ID,
        revision: DEFAULT_MITZO_PROFILE_REVISION,
      }),
      expect.objectContaining({
        kind: 'builtin',
        profileId: PROFILE_BUILDER_ID,
        revision: PROFILE_BUILDER_REVISION,
      }),
      expect.objectContaining({ kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 2 }),
      expect.objectContaining({ kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 }),
      eligible,
    ],
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

it.each(['user'])(
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

it('admits the exact builtin namespace through the same entry and reservation owners', async () => {
  const response = await send({
    ...input(),
    selection: {
      ...input().selection,
      agent: { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 },
    },
  });
  expect(response.status).toBe(202);
  expect(fixtures.reserve).toHaveBeenCalledOnce();
  expect(fixtures.start).toHaveBeenCalledOnce();
});

it('explains the unavailable native pack continuation barrier before source or native effects', async () => {
  const response = await send({
    ...input(),
    selection: { ...input().selection, context: { source: 'packs', revision: 'pack-recipe' } },
  });
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({
    code: 'native_context_unavailable',
    error: expect.stringContaining('trusted native continuation barrier'),
  });
  expect(fixtures.reserve).not.toHaveBeenCalled();
  expect(fixtures.start).not.toHaveBeenCalled();
});

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

function configuredShell(
  targetId = 'shell',
  includeLocal = false,
  presetConfigured = false,
  next = false,
) {
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
    ...(presetConfigured
      ? {
          agentContextPresets: {
            'fixture-agent': {
              version: 1 as const,
              source: 'workspace' as const,
              files: ['README.md'],
              tokenBudget: 1000,
              required: [],
              excluded: [],
            },
          },
        }
      : {}),
  } satisfies OpenShellRuntimeConfig;
  const shellProfiles = new AccountProfiles(
    [
      ...(includeLocal
        ? [
            {
              id: 'personal',
              label: 'Personal',
              provider: 'openai-codex' as const,
              credentialRef: '/offline/login',
              email: 'fixture@example.test',
              planType: 'plus',
              models: [
                { id: 'fixture', label: 'Offline' },
                ...(next ? [{ id: 'supported-next', label: 'Supported next' }] : []),
              ],
            },
          ]
        : []),
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
        models: [
          { id: 'fixture', label: 'Offline' },
          ...(next ? [{ id: 'supported-next', label: 'Supported next' }] : []),
        ],
      },
    ],
    { codexEnabled: true },
  );
  const target = ordinaryOpenShellCodexTarget({
    targetId,
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
    version: () => publishedProfile,
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
      targetId,
      mode: 'agent',
    },
    selection: { ...input().selection, permission: { mode: 'agent', revision: 0 } },
  };
  const admittedBinding = {
    version: 2,
    account: request.runtime.account,
    harness: { implementation: 'codex' },
    execution: { location: 'openshell', targetId, targetRevision: target.targetRevision },
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

it.each([
  ['1', 'malformed'],
  ['1', 'stale'],
  ['0', 'disabled'],
] as const)(
  'preserves Local capabilities with %s OpenShell and a %s declaration',
  async (enabled, reason) => {
    vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', enabled);
    fixtures.shellTarget.mockImplementation(() => {
      throw Error(reason);
    });
    fixtures.library.mockReturnValue({ list: () => ({ versions: [] }) });
    router = createOwnedLocalCodexEntryRouter(
      streams,
      {
        connRegistry: conns,
        sessionRegistry: sessions,
        eventStore: store,
      },
      true,
    );
    const response = await invoke('GET', '/capabilities', undefined);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      routes: expect.arrayContaining([
        expect.objectContaining({ location: 'local', targetId: 'host' }),
      ]),
      locations: expect.arrayContaining([
        expect.objectContaining({ location: 'openshell', status: 'unavailable' }),
      ]),
    });
    expect(fixtures.shellTarget).toHaveBeenCalledTimes(enabled === '1' ? 1 : 0);
    expect(fixtures.startShell).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'isolates duplicate target IDs and requires the OpenShell preset before effects (configured=%s)',
  async (configured) => {
    const { request } = configuredShell('host', true, configured);
    const definition = {
      ...publishedDefinition,
      contextRecipe: {
        version: 1 as const,
        source: 'contexgin' as const,
        agentName: 'fixture-agent',
      },
    };
    const profile = { ...publishedProfile, definition, contentHash: contextDigest(definition) };
    fixtures.library.mockReturnValue({
      version: () => profile,
      list: () => ({ versions: [profile] }),
    });
    const response = await invoke('GET', '/capabilities', undefined);
    expect(response.status).toBe(200);
    const routes = (response.body as { routes: Array<Record<string, unknown>> }).routes;
    expect(
      routes.find((route) => route.targetId === 'host' && route.location === 'local'),
    ).toMatchObject({
      agentProfiles: expect.arrayContaining([{ profileId: 'published', revision: 1 }]),
    });
    expect(
      routes.find((route) => route.targetId === 'host' && route.location === 'openshell'),
    ).toMatchObject(
      configured
        ? {
            agentProfiles: expect.arrayContaining([{ profileId: 'published', revision: 1 }]),
          }
        : {
            agentProfileRejections: expect.arrayContaining([
              {
                agent: { profileId: 'published', revision: 1 },
                reason: 'sandbox_context_preset_unconfigured',
              },
            ]),
          },
    );
    expect(
      (
        await invoke('POST', '/send', {
          ...request,
          selection: {
            ...request.selection,
            context: { source: 'contexgin', revision: contextDigest(definition.contextRecipe) },
          },
        })
      ).status,
    ).toBe(configured ? 202 : 409);
    expect(fixtures.startShell).toHaveBeenCalledTimes(configured ? 1 : 0);
    expect(fixtures.reserve).not.toHaveBeenCalled();
    if (!configured)
      expect(store.getSession(nativeStartupSessionId(`repository:${workspaceId}`))).toBeNull();
  },
);

it('keeps Local inventory when the qualified OpenShell preset declaration becomes unreadable', async () => {
  configuredShell('shell', true);
  const configured = fixtures.shellTarget.getMockImplementation()!;
  fixtures.shellTarget.mockImplementationOnce(configured).mockImplementation(() => {
    throw Error('Preset declaration changed');
  });
  const response = await invoke('GET', '/capabilities', undefined);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    routes: expect.arrayContaining([
      expect.objectContaining({ location: 'local', targetId: 'host' }),
    ]),
  });
  expect(fixtures.shellTarget).toHaveBeenCalledTimes(2);
});

it('reserves a qualified OpenShell preparation model B before admission and an exact retry cannot claim or launch twice', async () => {
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', '');
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  const shell = configuredShell('shell', false, false, true);
  const verify = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'verifySubscriptionSignIn')
    .mockResolvedValue(Date.now() + 60000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-prepared-shell-')));
  const source = join(root, 'source');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', source, ...args],
      { encoding: 'utf8' },
    ).trim();
  let workspace: RepositoryWorkspaces | undefined;
  try {
    await mkdir(source);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Offline');
    git('config', 'user.email', 'offline@example.invalid');
    await writeFile(join(source, 'task.txt'), 'original prepared source');
    git('add', '.');
    git('commit', '-qm', 'offline');
    const oid = git('rev-parse', 'HEAD');
    const { captureOrdinaryRepositoryPreparation, assertOrdinaryRepositoryPreparation } =
      await import('../ordinary-repository-preparation-authority.js');
    workspace = new RepositoryWorkspaces(join(root, 'private'), {
      authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
      inspect: async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid: oid }),
      prepare: async (_preview, path, branch) => {
        await cp(source, path, { recursive: true });
        execFileSync('git', ['-C', path, 'checkout', '-qb', branch]);
        return {
          repository: 'example/repo',
          baseBranch: 'main',
          baseOid: oid,
          directory: path,
          featureBranch: branch,
        };
      },
      ordinaryPreparation: {
        capture: captureOrdinaryRepositoryPreparation,
        assert: assertOrdinaryRepositoryPreparation,
      },
    });
    fixtures.workspace.mockReturnValue(workspace);
    const accountA = shell.shellProfiles.resolve('brokered', 'fixture');
    const preview = await workspace.preview(
      accountA,
      'fixture-github',
      'example/repo',
      new AbortController().signal,
      {
        runOn: 'openshell',
        runtime: { account: shell.request.runtime.account, harness: 'codex', targetId: 'shell' },
      },
    );
    const ready = await workspace.prepare(preview.id, accountA, new AbortController().signal);
    expect(ready.ordinaryRuntime?.execution.location).toBe('openshell');
    const original = workspace.get(ready.id);
    const claim = vi.spyOn(workspace, 'claim');
    let launches = 0;
    fixtures.startShell.mockImplementation(async (_transport, _client, args) => {
      const record = workspace!.get(ready.id);
      expect(record.binding.model).toBe('supported-next');
      expect(record.ordinaryPreparation?.originalBinding).toEqual(accountA);
      expect(record.ordinaryFirstReservation?.conversationId).toBe(args.meta.sessionId);
      const artifact = {
        runtime: {
          sandboxName: 'offline-owned',
          sandboxId: 'offline-resource',
          workdir: shell.config.workdir,
          appServerCommand: '/sandbox/run-mitzo-subscription-app-server',
          cli: shell.config.cli,
          gateway: shell.config.gateway,
          workspace: shell.config.workspace,
          gatewayInsecure: false,
        },
        route: {
          kind: 'chatgpt-subscription',
          provider: 'provider',
          providerType: 'openai-codex-oauth',
          providerId: 'provider-id',
          grantId: 'grant-id',
          model: args.command.selection.model,
        },
      } satisfies ArtifactRuntime;
      fixtures.shellArtifact.mockReturnValue(artifact);
      fixtures.shellCustody.mockReturnValue({
        authSessionId: auth.id,
        binding: shell.admittedBinding,
        workspace: { workspaceId: ready.id, cwd: shell.config.workdir },
        physicalIdentitySha256: openShellPhysicalCustodyFingerprint(artifact),
      });
      const command = {
        ...args.command,
        payload: {
          ...args.command.payload,
          systemPrompt: buildAgentProfilePrompt(args.meta.agentProfile.definition),
        },
      };
      const expected = {
        binding: shell.admittedBinding,
        workspace: { workspaceId: ready.id, cwd: shell.config.workdir },
        selection: args.command.selection,
        agentProfile: args.meta.agentProfile,
      };
      const admission = {
        clientMsgId: args.command.clientMsgId,
        requestFingerprint: `ordinary-openshell-codex-v1:${createHash('sha256')
          .update(canonicalJson(JSON.parse(JSON.stringify({ request: command, expected }))))
          .digest('hex')}`,
        selection: args.command.selection,
        payload: command.payload,
      };
      const receipt = store.admitOrdinaryOpenShellCommand(
        { ...args.meta, cwd: shell.config.workdir },
        shell.admittedBinding as never,
        admission,
      );
      if (receipt.admission.state === 'consumed')
        return { dispatched: true, sessionId: args.meta.sessionId };
      await workspace!.claim(
        ready.id,
        args.meta.accountBinding,
        args.meta.sessionId,
        '/unused/offline/sandbox-root',
        true,
      );
      store.claimOrdinaryOpenShellCommandDispatch(admission.clientMsgId);
      launches++;
      store.completeOrdinaryOpenShellCommand(admission.clientMsgId);
      return { dispatched: true, sessionId: args.meta.sessionId };
    });
    const request = {
      ...shell.request,
      repositoryWorkspaceId: ready.id,
      selection: { ...shell.request.selection, model: 'supported-next' },
    };
    verify.mockResolvedValueOnce(Date.now() - 1);
    expect((await invoke('POST', '/send', request)).status).toBe(409);
    expect(workspace.get(ready.id)).toEqual(original);
    expect(claim).not.toHaveBeenCalled();
    expect(launches).toBe(0);
    const accepted = await invoke('POST', '/send', request);
    expect(accepted.status).toBe(202);
    expect(verify).toHaveBeenCalled();
    expect((await invoke('POST', '/send', request)).status).toBe(202);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
    expect(
      (await invoke('POST', '/send', { ...request, payload: { text: 'different frozen command' } }))
        .status,
    ).toBe(409);
    const claimed = workspace.get(ready.id);
    expect(claimed.binding.model).toBe('supported-next');
    expect(claimed.ordinaryPreparation?.originalBinding).toEqual(accountA);
    expect(claimed.sourceDigest).toBe(original.sourceDigest);
    expect(claimed.featureBranch).toBe(original.featureBranch);
    expect(
      (
        await invoke('POST', '/send', {
          ...request,
          selection: { ...request.selection, model: 'fixture' },
        })
      ).status,
    ).toBe(409);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(launches).toBe(1);
  } finally {
    workspace?.close();
    verify.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

async function configuredDefaultShell() {
  const shell = configuredShell();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'default-shell-public-')));
  const taskRoot = join(root, 'tasks');
  await mkdir(taskRoot, { mode: 0o700 });
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', taskRoot);
  const binding = shell.shellProfiles.resolve('brokered', 'fixture');
  const forbidden = vi.fn(async () => {
    throw Error('No repository authority for default chat');
  });
  const capture = vi.fn(async () =>
    OrdinaryRepositoryPreparationSchema.parse({
      version: 1 as const,
      originalBinding: binding,
      runtimeBinding: shell.admittedBinding,
      credentialDigest: 'a'.repeat(64),
      sandboxWorkdir: shell.config.workdir,
    }),
  );
  const workspaces = new RepositoryWorkspaces(join(root, 'owner'), {
    authorize: forbidden,
    inspect: forbidden,
    prepare: forbidden,
    ordinaryPreparation: { capture, assert: async () => {} },
  });
  fixtures.ordinaryWorkspace.mockReturnValue(workspaces);
  const request = { ...shell.request };
  Reflect.deleteProperty(request, 'repositoryWorkspaceId');
  return { shell, root, taskRoot, binding, forbidden, capture, workspaces, request };
}

it('bounds default OpenShell preparation and dispatch by one overall startup deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const { root, capture, workspaces, request } = await configuredDefaultShell();
  const originalCapture = capture.getMockImplementation()!;
  capture.mockImplementation(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
    return originalCapture();
  });
  let abortedAtDeadline = false;
  fixtures.startShell.mockImplementation(async (_transport, _client, args) => {
    await vi.advanceTimersByTimeAsync(30_001);
    abortedAtDeadline = args.signal.aborted;
    args.signal.throwIfAborted();
    return { dispatched: true, sessionId: args.meta.sessionId };
  });
  try {
    const response = await invoke('POST', '/send', request);
    expect(fixtures.startShell).toHaveBeenCalledOnce();
    expect(abortedAtDeadline).toBe(true);
    expect(response.status).toBe(409);
  } finally {
    vi.useRealTimers();
    workspaces.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts a fresh OpenShell chat through ordinary mgmt custody without selecting a repository', async () => {
  const { shell, root, taskRoot, binding, forbidden, capture, workspaces, request } =
    await configuredDefaultShell();
  fixtures.startShell.mockImplementation(async (_transport, _client, args) => {
    const record = workspaces.getOrdinaryWorkspace(args.meta.ordinaryWorkspaceId);
    await workspaces.claimOrdinaryWorkspace({
      id: record.id,
      conversationId: record.conversationId,
      binding,
      taskRoot,
      signal: new AbortController().signal,
    });
    const artifact = {
      runtime: {
        sandboxName: 'default-mgmt-owned',
        sandboxId: 'default-resource',
        workdir: shell.config.workdir,
        appServerCommand: '/sandbox/run-mitzo-subscription-app-server',
        cli: shell.config.cli,
        gateway: shell.config.gateway,
        workspace: shell.config.workspace,
        gatewayInsecure: false,
      },
      route: {
        kind: 'chatgpt-subscription',
        provider: 'provider',
        providerType: 'openai-codex-oauth',
        providerId: 'provider-id',
        grantId: 'grant-id',
        model: 'fixture',
      },
    } satisfies ArtifactRuntime;
    fixtures.shellArtifact.mockReturnValue(artifact);
    fixtures.shellCustody.mockReturnValue({
      workspaceKind: 'ordinary',
      authSessionId: auth.id,
      binding: shell.admittedBinding,
      workspace: { workspaceId: record.id, cwd: shell.config.workdir },
      physicalIdentitySha256: openShellPhysicalCustodyFingerprint(artifact),
    });
    const command = {
      ...args.command,
      payload: {
        ...args.command.payload,
        systemPrompt: buildAgentProfilePrompt(args.meta.agentProfile.definition),
      },
    };
    const expected = {
      binding: shell.admittedBinding,
      workspace: { workspaceId: record.id, cwd: shell.config.workdir },
      selection: command.selection,
      agentProfile: args.meta.agentProfile,
    };
    store.admitPreparedOrdinaryWorkspaceCommand(
      args.preparationOperationId,
      args.meta,
      shell.admittedBinding,
      {
        clientMsgId: args.command.clientMsgId,
        requestFingerprint: `ordinary-openshell-codex-v1:${createHash('sha256')
          .update(canonicalJson(JSON.parse(JSON.stringify({ request: command, expected }))))
          .digest('hex')}`,
        selection: args.command.selection,
        payload: command.payload,
      },
    );
    store.claimOrdinaryOpenShellCommandDispatch(args.command.clientMsgId);
    store.completeOrdinaryOpenShellCommand(args.command.clientMsgId);
    return { dispatched: true, sessionId: record.conversationId };
  });
  try {
    const legacyCapabilities = await invoke('GET', '/capabilities', undefined);
    expect(legacyCapabilities.body).not.toHaveProperty('defaultOpenShellWorkspace');
    const capabilities = await invoke('GET', '/capabilities', undefined, auth.id, true);
    expect(capabilities.body).toMatchObject({ defaultOpenShellWorkspace: true });
    const accepted = await invoke('POST', '/send', request);
    expect(accepted.status).toBe(202);
    const meta = store.getSession((accepted.body as { sessionId: string }).sessionId)!;
    expect(meta.ordinaryWorkspaceId).toBeTruthy();
    expect(meta.repositoryWorkspaceId).toBeUndefined();
    expect(meta.cwd).toBe(shell.config.workdir);
    expect(fixtures.startShell.mock.calls[0][2].preparationOperationId).toBeTruthy();
    expect(await invoke('POST', '/send/receipt', request)).toMatchObject({
      status: 202,
      body: { dispatched: false, state: 'consumed', sessionId: meta.sessionId },
    });
    expect(await invoke('POST', '/send', request)).toMatchObject({
      status: 202,
      body: { dispatched: false },
    });
    expect(
      (await invoke('POST', '/send', { ...request, payload: { text: 'Changed frozen command' } }))
        .status,
    ).toBe(409);
    expect(fixtures.startShell).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
    expect(fixtures.reserveSandbox).not.toHaveBeenCalled();
    expect(fixtures.reserve).not.toHaveBeenCalled();
  } finally {
    workspaces.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('observes an unknown default OpenShell receipt without preparing or allocating a workspace', async () => {
  const { root, capture, workspaces, request } = await configuredDefaultShell();
  const reserve = vi.spyOn(workspaces, 'reserveOrdinaryWorkspace');
  const prepare = vi.spyOn(store, 'prepareOrdinaryWorkspaceSession');
  try {
    expect(await invoke('POST', '/send/receipt', request)).toMatchObject({
      status: 409,
      body: { code: 'receipt_pending' },
    });
    expect(capture).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(fixtures.startShell).not.toHaveBeenCalled();
  } finally {
    workspaces.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('redirects paid reasoning slash intent to the selected product action before workspace or provider effects', async () => {
  const request = input();
  request.payload.text = '/deliberate Explain the tradeoffs';
  const result = await send(request);
  expect(result).toMatchObject({
    status: 409,
    body: {
      code: 'paid_reasoning_entry_required',
      action: { endpoint: '/api/chat/send', selection: 'phaseSelections', preserveDraft: true },
    },
  });
  expect(fixtures.start).not.toHaveBeenCalled();
  expect(fixtures.reserve).not.toHaveBeenCalled();
});
