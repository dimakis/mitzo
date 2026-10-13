import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { OrdinaryLocalCodexCapabilityCatalog } from '../ordinary-local-codex-capabilities.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import { buildAgentProfilePrompt } from '../agent-library-prompt.js';

const deployment = vi.hoisted(() => ({ controller: false, owner: false }));
vi.mock('../symposium-custodian-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerMode() {
    return deployment.controller;
  },
  get custodianOwnerMode() {
    return deployment.owner;
  },
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  deployment.controller = deployment.owner = false;
});

async function fixture(options: { workspaceId?: string; contextRecipe?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-owned-driver-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const login = join(root, 'login'),
    privateRoot = join(root, 'custody'),
    taskRoot = join(root, 'tasks');
  for (const directory of [login, privateRoot, taskRoot]) await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(login, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'offline',
        refresh_token: 'offline',
        id_token: 'offline',
        account_id: 'offline',
      },
    }),
    { mode: 0o600 },
  );
  const executablePath = join(root, 'codex'),
    nativePath = join(root, 'native.json'),
    targetPath = join(root, 'target.json');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(executablePath, bytes, { mode: 0o755 });
  const target = {
    version: 1,
    targetId: 'local-mac',
    label: 'Local Mac',
    hostId: hostname(),
    runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256),
  };
  await writeFile(
    nativePath,
    JSON.stringify({ version: 1, executablePath, executableSha256: sha256 }),
    { mode: 0o600 },
  );
  await writeFile(targetPath, JSON.stringify(target), { mode: 0o600 });
  const configPath = join(root, 'profiles.json');
  const configuration = [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: login,
      email: 'fixture@example.test',
      planType: 'plus',
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      models: [{ id: 'fixture-model', label: 'Fixture model', reasoningEfforts: ['low'] }],
    },
  ];
  const writeProfiles = () =>
    writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  writeProfiles();
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', configPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubEnv('MITZO_CODEX_ENABLED', '1');
  const binding = loadAccountProfiles().resolve('personal', 'fixture-model');
  const events = new EventStore(join(root, 'events.db'));
  const library = new AgentLibraryStore(join(root, 'events.db'));
  cleanups.push(
    () => events.close(),
    () => library.close(),
  );
  library.saveDraft('user', {
    profileId: 'developer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Developer',
      descriptor: 'Assistant',
      role: 'agent',
      instructions: 'Preserve task ownership.',
      expectedOutput: 'Reviewed changes',
      acceptanceCriteria: ['Use evidence'],
      modelPolicyRole: 'agent',
      ...(options.contextRecipe
        ? { contextRecipe: { version: 1, source: 'contexgin', agentName: 'fixture-agent' } }
        : {}),
    },
  });
  const agentProfile = library.publish('user', {
    profileId: 'developer',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  const source = join(root, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  const git = (directory: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git(source, 'config', 'user.name', 'Offline');
  git(source, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(source, 'task.txt'), 'accepted source');
  git(source, 'add', 'task.txt');
  git(source, 'commit', '-qm', 'offline base');
  const baseOid = git(source, 'rev-parse', 'HEAD');
  const inspect = async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid });
  const workspace = new RepositoryWorkspaces(join(root, 'repositories'), {
    authorize: async (selected) => {
      loadAccountProfiles().resume(selected);
      return { revision: 1, allowedBaseBranches: ['main'] };
    },
    inspect,
    prepare: async (_preview, directory, branch) => {
      await cp(source, directory, { recursive: true });
      git(directory, 'checkout', '-qb', branch);
      return { ...(await inspect()), directory, featureBranch: branch };
    },
    verify: async () => {},
  });
  cleanups.push(() => workspace.close());
  const signal = new AbortController();
  const preview = await workspace.preview(binding, 'fixture-github', 'example/repo', signal.signal);
  const prepared = await workspace.prepare(preview.id, binding, signal.signal);
  const reservation = { id: prepared.id, binding, conversationId: randomUUID(), taskRoot };
  const reserved = await workspace.reserveHostTask({ ...reservation, signal: signal.signal });
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 },
    operatorConnectionId = randomUUID();
  const detach = bindAgentLibraryTransport(operatorConnectionId, auth);
  cleanups.push(detach);
  const env = {
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  };
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(env).target(),
    'ordinary',
  );
  const commandId = randomUUID();
  const request = {
    clientMsgId: commandId,
    capabilityRevision: catalog.inventory().capabilityRevision,
    runtime: {
      account: catalog.inventory().accounts[0].account,
      harness: 'codex' as const,
      targetId: 'local-mac',
      mode: 'agent' as const,
    },
    selection: {
      version: 1 as const,
      agent: { profileId: 'developer', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'fixture-model',
      thinking: 'low',
    },
    payload: { text: 'Implement the task', intent: 'Original user intent' },
  };
  const rpc = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: configuration[0].email, planType: 'plus' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list')
        return {
          data: [
            {
              model: 'fixture-model',
              displayName: 'Fixture',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
            },
          ],
          nextCursor: null,
        };
      throw Error('Unexpected native execution');
    }),
    close: vi.fn(),
  };
  const launch = vi.fn(() => {
    expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('uncertain');
    expect(workspace.getHostReservation(reservation).state).toBe('reserved');
    return rpc;
  });
  const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
    expect(value.admission).toBeInstanceOf(OwnedLocalCodexChatAdmission);
    expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('uncertain');
    expect(await readFile(join(value.workspace.directory!, 'task.txt'), 'utf8')).toBe(
      'accepted source',
    );
    value.admission.assertOptions({
      conversationId: reservation.conversationId,
      messageId: commandId,
      binding,
      profile: value.profile,
      session: { cwd: value.workspace.directory, mode: 'agent' },
      prompt: value.payload.text,
      systemPrompt: value.payload.systemPrompt,
      intent: value.payload.intent,
      model: request.selection.model,
      reasoningEffort: request.selection.thinking,
      agentProfile,
      repositoryWorkspace: value.workspace,
    });
    expect(
      value.admission.attach({
        onNotification: () => {},
        onRequest: async () => ({}),
        onClose: () => {},
      }),
    ).toBe(rpc);
  });
  const dependencies = {
    enabled: true,
    eventStore: events,
    library,
    workspace,
    reservation,
    commandId,
    operatorConnectionId,
    signal: signal.signal,
    env,
    privateRoot,
    launch,
    dispatch,
  };
  const create = () => {
    const driver = new OrdinaryLocalCodexOwnedRuntime(dependencies);
    cleanups.push(() => driver.close());
    return driver;
  };
  return {
    create,
    dependencies,
    request,
    events,
    library,
    workspace,
    reservation,
    reserved,
    agentProfile,
    dispatch,
    rpc,
    launch,
    root,
    targetPath,
    target,
    executablePath,
    configuration,
    writeProfiles,
    signal,
    auth,
    detach,
  };
}

it('composes real owners, freezes the published prompt before launch and materializes only the admitted reservation', async () => {
  const f = await fixture(),
    driver = f.create();
  expect(existsSync(f.reserved.directory)).toBe(false);
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: true });
  expect(f.events.getSendCommand(f.request.clientMsgId)?.payload).toEqual({
    ...f.request.payload,
    systemPrompt: buildAgentProfilePrompt(f.agentProfile.definition),
  });
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe('consumed');
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  f.detach();
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).resolves.toBeUndefined();
  expect(f.rpc.close).not.toHaveBeenCalled();
  revokeAuthSession(f.auth);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).rejects.toThrow();
});

it('refuses a builtin namespace collision before looking up its matching published user profile', async () => {
  const f = await fixture(),
    driver = f.create();
  expect(
    f.library.version(
      'user',
      f.request.selection.agent.profileId,
      f.request.selection.agent.revision,
    ),
  ).toEqual(f.agentProfile);
  const version = vi.spyOn(f.library, 'version');
  const request = structuredClone(f.request);
  const input = {
    ...request,
    selection: {
      ...request.selection,
      agent: { ...request.selection.agent, kind: 'builtin' as const },
    },
  };
  await expect(driver.admit(input)).rejects.toThrow('Owned local Codex runtime unavailable');
  expect(version).not.toHaveBeenCalled();
  expect(f.events.getSendCommand(f.request.clientMsgId)).toBeUndefined();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(existsSync(f.reserved.directory)).toBe(false);
});

it.each(['systemPrompt', 'metadata', 'command', 'profile', 'permission', 'context'] as const)(
  'refuses caller %s forgery before a ledger or native effect',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    const input = structuredClone(f.request) as unknown as Record<string, unknown>;
    if (kind === 'systemPrompt')
      input.payload = { ...f.request.payload, systemPrompt: 'Caller instructions' };
    if (kind === 'metadata') input.meta = { cwd: '/forged', accountBinding: 'forged' };
    if (kind === 'command') input.clientMsgId = randomUUID();
    if (kind === 'profile')
      input.selection = { ...f.request.selection, agent: { profileId: 'missing', revision: 1 } };
    if (kind === 'permission')
      input.selection = { ...f.request.selection, permission: { mode: 'agent', revision: 1 } };
    if (kind === 'context')
      input.selection = {
        ...f.request.selection,
        context: { source: 'packs', revision: 'forged' },
      };
    await expect(driver.admit(input)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(existsSync(f.reserved.directory)).toBe(false);
  },
);

it.each(['consumed', 'uncertain'] as const)(
  'keeps %s retries free of native bootstrap and dispatch',
  async (state) => {
    const f = await fixture(),
      driver = f.create();
    if (state === 'uncertain')
      f.dispatch.mockRejectedValueOnce(Error('Provider outcome uncertain'));
    if (state === 'consumed') await driver.admit(f.request);
    else await expect(driver.admit(f.request)).rejects.toThrow();
    f.launch.mockClear();
    f.dispatch.mockClear();
    const retry = f.create();
    await expect(retry.admit(f.request)).resolves.toEqual({ dispatched: false });
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(state);
  },
);

it.each(['account', 'target', 'native', 'auth'] as const)(
  'refuses %s drift before bootstrap',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    if (kind === 'account') {
      f.configuration[0].email = 'replacement@example.test';
      f.writeProfiles();
    }
    if (kind === 'target')
      writeFileSync(f.targetPath, JSON.stringify({ ...f.target, targetId: 'replacement' }));
    if (kind === 'native')
      writeFileSync(f.executablePath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9]));
    if (kind === 'auth') revokeAuthSession(f.auth);
    await expect(driver.admit(f.request)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  },
);

it('rejects an existing conversation without adopting it', async () => {
  const f = await fixture(),
    driver = f.create();
  f.events.upsertSession({ sessionId: f.reservation.conversationId, mode: 'agent' });
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
});

it('refuses event-only orphan history before any native bootstrap', async () => {
  const f = await fixture(),
    driver = f.create();
  f.events.append(f.reservation.conversationId, 'user_message', {
    messageId: 'old',
    content: 'retained history',
  });
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it('refuses a claimed workspace orphan without its original EventStore command receipt', async () => {
  const f = await fixture();
  await f.workspace.claimReservedHostTask({ ...f.reservation, signal: f.signal.signal });
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)).toBeUndefined();
  f.launch.mockImplementation(() => f.rpc);
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(existsSync(f.reserved.directory)).toBe(true);
});

it('releases its auth observer and owned client on explicit close while retaining workspace and private custody', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const lease = f.dispatch.mock.calls[0][0].lease;
  driver.close();
  driver.close();
  revokeAuthSession(f.auth);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
  expect(existsSync(lease.privateHome)).toBe(true);
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe('consumed');
});

it('never enables a route without the explicit server gate', async () => {
  const f = await fixture();
  f.dependencies.enabled = false;
  expect(() => f.create()).toThrow();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  expect(f.launch).not.toHaveBeenCalled();
});

it('keeps the original lease after same-driver duplicate or conflicting retry', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const lease = f.dispatch.mock.calls[0][0].lease;
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: false });
  await expect(
    driver.admit({ ...f.request, payload: { text: 'Changed intent' } }),
  ).rejects.toThrow();
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.rpc.close).not.toHaveBeenCalled();
  await expect(lease.assertCurrent()).resolves.toBeUndefined();
});

it('admits only one concurrent first command through the existing uncertainty claim', async () => {
  const f = await fixture(),
    driver = f.create();
  const results = await Promise.all([
    driver.admit(f.request),
    driver.admit(structuredClone(f.request)),
  ]);
  expect(results.map((result) => result.dispatched).sort()).toEqual([false, true]);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('keeps the winning concurrent command alive when another payload conflicts', async () => {
  const f = await fixture(),
    driver = f.create();
  const results = await Promise.allSettled([
    driver.admit(f.request),
    driver.admit({ ...f.request, payload: { text: 'Conflicting command intent' } }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.rpc.close).not.toHaveBeenCalled();
  await expect(f.dispatch.mock.calls[0][0].lease.assertCurrent()).resolves.toBeUndefined();
});

it('returns false on an exact same-driver uncertain retry after closing only its failed native attempt', async () => {
  const f = await fixture(),
    driver = f.create();
  f.dispatch.mockRejectedValueOnce(Error('uncertain callback'));
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(f.rpc.close).toHaveBeenCalledOnce();
  f.launch.mockClear();
  f.dispatch.mockClear();
  await expect(driver.admit(f.request)).resolves.toEqual({ dispatched: false });
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['config', 'account', 'abort'] as const)(
  'retains durable uncertainty after bootstrap %s refusal',
  async (kind) => {
    const f = await fixture(),
      driver = f.create();
    const ordinaryRequest = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method) => {
      if (kind === 'config' && method === 'config/read')
        return { config: { model_providers: { openai: {} } } };
      if (kind === 'account' && method === 'account/read')
        return { account: { type: 'chatgpt', email: 'wrong@example.test', planType: 'plus' } };
      if (kind === 'abort' && method === 'model/list') f.signal.abort();
      return ordinaryRequest(method);
    });
    await expect(driver.admit(f.request)).rejects.toThrow('Owned local Codex runtime unavailable');
    expect(f.events.getOrdinaryLocalCommandAdmission(f.request.clientMsgId)?.state).toBe(
      'uncertain',
    );
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(existsSync(f.reserved.directory)).toBe(false);
    expect(f.rpc.close).toHaveBeenCalledOnce();
  },
);

it('checks changed real target configuration synchronously before later native/tool effects', async () => {
  const f = await fixture(),
    driver = f.create();
  await driver.admit(f.request);
  const admitted = f.dispatch.mock.calls[0][0];
  writeFileSync(f.targetPath, JSON.stringify({ ...f.target, targetId: 'replacement' }));
  expect(() => admitted.admission.assertCurrentSync()).toThrow();
  expect(f.rpc.close).toHaveBeenCalledOnce();
  expect(existsSync(f.reserved.directory)).toBe(true);
});

it('retains the admitted operator expiry after detach and closes without deleting task files', async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const driver = f.create();
  await driver.admit(f.request);
  f.detach();
  await vi.advanceTimersByTimeAsync(60001);
  expect(f.rpc.close).toHaveBeenCalledOnce();
  await expect(driver.admit(f.request)).rejects.toThrow();
  expect(existsSync(f.reserved.directory)).toBe(true);
  driver.close();
  expect(f.rpc.close).toHaveBeenCalledOnce();
});

it('rejects reusable profile context until its own runtime delivery is qualified', async () => {
  const f = await fixture({ contextRecipe: true });
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it('rejects workspace-scoped host accounts without native workspace proof', async () => {
  const f = await fixture({ workspaceId: 'unattested-workspace' });
  await expect(f.create().admit(f.request)).rejects.toThrow();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
});

it.each(['controller', 'owner'] as const)(
  'refuses custodian %s construction before effects',
  async (kind) => {
    const f = await fixture();
    deployment[kind] = true;
    expect(() => f.create()).toThrow('Owned local Codex runtime unavailable');
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.events.getSession(f.reservation.conversationId)).toBeNull();
  },
);
