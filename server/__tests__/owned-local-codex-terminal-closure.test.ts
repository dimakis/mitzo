import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLibraryStore } from '../agent-library-store.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { loadAccountProfiles } from '../account-profiles.js';
import { OrdinaryLocalCodexCapabilityCatalog } from '../ordinary-local-codex-capabilities.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { CodexAppServerClient, type CodexLifecycleTransport } from '../codex-app-server-client.js';
import { getCodexRuntime, getCodexConversationStore } from '../codex-chat-session.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import { ordinaryLocalCodexBootstrapId } from '../ordinary-local-codex-admission.js';

const peers = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({ offline: { command: 'never-launched' } }),
}));
vi.mock('../codex-mcp-tools.js', async (original) => {
  const actual = await original<typeof import('../codex-mcp-tools.js')>();
  return {
    ...actual,
    connectCodexMcpTools: (
      configs: Parameters<typeof actual.connectCodexMcpTools>[0],
      options: Parameters<typeof actual.connectCodexMcpTools>[1],
    ) =>
      actual.connectCodexMcpTools(configs, {
        ...options,
        connect: async () => ({
          listTools: async () => ({
            tools: [{ name: 'offline', inputSchema: { type: 'object' } }],
          }),
          callTool: async () => {
            throw Error('No MCP effects in fixture');
          },
          close: peers.close,
        }),
      }),
  };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model calls');
  },
}));
vi.mock('../auto-rename.js', () => ({ shouldAutoRename: () => false }));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

let chat: typeof import('../chat.js');
let root: string;
const cleanup: Array<() => void> = [];
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-terminal-')));
  mkdirSync(join(root, 'private'), { mode: 0o700 });
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal('fetch', () => {
    throw Error('No network in fixture');
  });
  chat = await import('../chat.js');
});
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => {
  chat.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  peers.close.mockClear();
  const directory = join(root, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const login = join(directory, 'login'),
    privateRoot = join(directory, 'custody'),
    taskRoot = join(directory, 'tasks');
  for (const path of [login, privateRoot, taskRoot]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(
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
  const executablePath = join(directory, 'codex'),
    nativePath = join(directory, 'native.json'),
    targetPath = join(directory, 'target.json');
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]),
    sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(executablePath, bytes, { mode: 0o755 });
  writeFileSync(join(directory, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  writeFileSync(
    nativePath,
    JSON.stringify({ version: 2, executablePath, executableSha256: sha, codeModeHostSha256: sha }),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    targetPath,
    JSON.stringify({
      version: 1,
      targetId: 'mac',
      label: 'Offline',
      hostId: hostname(),
      runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha, sha),
    }),
    { mode: 0o600 },
  );
  const configPath = join(directory, 'profiles.json');
  writeFileSync(
    configPath,
    JSON.stringify([
      {
        id: 'personal',
        label: 'Offline',
        provider: 'openai-codex',
        credentialRef: login,
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'fixture', label: 'Offline' }],
      },
    ]),
    { mode: 0o600 },
  );
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', configPath);
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubEnv('MITZO_CODEX_ENABLED', '1');
  const binding = loadAccountProfiles().resolve('personal', 'fixture');
  const library = new AgentLibraryStore(join(directory, 'library.db'));
  cleanup.push(() => library.close());
  library.saveDraft('user', {
    profileId: 'agent',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Offline',
      descriptor: 'Offline',
      role: 'agent',
      instructions: 'Preserve ownership',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Use evidence'],
      modelPolicyRole: 'agent',
    },
  });
  library.publish('user', { profileId: 'agent', expectedVersion: 1, idempotencyKey: 'publish' });
  const source = join(directory, 'source');
  execFileSync('git', ['init', '-q', '-b', 'main', source]);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
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
  writeFileSync(join(source, 'task.txt'), 'retained task');
  git(source, 'add', 'task.txt');
  git(source, 'commit', '-qm', 'base');
  const baseOid = git(source, 'rev-parse', 'HEAD'),
    inspect = async () => ({ repository: 'owner/repo', baseBranch: 'main', baseOid });
  const workspace = new RepositoryWorkspaces(join(directory, 'repositories'), {
    authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
    inspect,
    prepare: async (_preview, cwd, branch) => {
      cpSync(source, cwd, { recursive: true });
      git(cwd, 'checkout', '-qb', branch);
      return { ...(await inspect()), directory: cwd, featureBranch: branch };
    },
    verify: async () => {},
  });
  cleanup.push(() => workspace.close());
  const cancel = new AbortController();
  const preview = await workspace.preview(binding, 'github', 'owner/repo', cancel.signal),
    prepared = await workspace.prepare(preview.id, binding, cancel.signal);
  const sessionId = randomUUID(),
    commandId = randomUUID(),
    reservation = { id: prepared.id, binding, conversationId: sessionId, taskRoot };
  await workspace.reserveHostTask({ ...reservation, signal: cancel.signal });
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 },
    operatorConnectionId = randomUUID();
  cleanup.push(bindAgentLibraryTransport(operatorConnectionId, auth));
  const env = {
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
  };
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    loadAccountProfiles(),
    new OrdinaryLocalCodexHostRuntime(env).target(),
    'ordinary',
  );
  let lifecycle: CodexLifecycleTransport | undefined,
    nativeClosed = false;
  const rpc = {
    initialize: vi.fn(async () => {}),
    request: vi.fn(async (method: string) => {
      if (method === 'account/read')
        return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list')
        return {
          data: [{ model: 'fixture', displayName: 'Offline', supportedReasoningEfforts: [] }],
          nextCursor: null,
        };
      if (method === 'thread/start')
        return { thread: { id: 'thread' }, model: 'fixture', modelProvider: 'openai' };
      if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
      throw Error('Unexpected provider effect: ' + method);
    }),
    close: vi.fn(() => {
      if (!nativeClosed) {
        nativeClosed = true;
        lifecycle!.onClose(Error('Owned transport closed'));
      }
    }),
  };
  const launch = vi
    .spyOn(CodexAppServerClient, 'launchIsolated')
    .mockImplementation((_home, _env, callbacks) => {
      lifecycle = callbacks;
      return rpc as unknown as CodexAppServerClient;
    });
  let consumer: Awaited<ReturnType<typeof chat.prepareOwnedLocalCodexChat>> | undefined;
  const ended = vi.fn(),
    firstEvent = vi.fn(),
    transport = { send: vi.fn(), isOpen: () => true };
  const driver = new OrdinaryLocalCodexOwnedRuntime({
    enabled: true,
    eventStore: chat.eventStore,
    library,
    workspace,
    reservation,
    commandId,
    operatorConnectionId,
    signal: cancel.signal,
    env,
    privateRoot,
    dispatch: async (input) => {
      consumer = await chat.prepareOwnedLocalCodexChat(transport, sessionId, input, {
        ownerConnectionId: operatorConnectionId,
        onFirstEventOutcome: firstEvent,
        onEnded: () => {
          ended();
          driver.close();
        },
      });
    },
  });
  cleanup.push(() => {
    consumer?.close();
    driver.close();
  });
  await driver.admit({
    clientMsgId: commandId,
    capabilityRevision: catalog.inventory().capabilityRevision,
    runtime: {
      account: catalog.inventory().accounts[0].account,
      harness: 'codex',
      targetId: 'mac',
      mode: 'agent',
    },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'fixture',
      thinking: null,
    },
    payload: { text: 'Offline task' },
  });
  const session = chat.registry.get(sessionId)!;
  const runtime = getCodexRuntime(session)!;
  const run = consumer!.run();
  await vi.waitFor(() => expect(firstEvent).toHaveBeenCalledOnce());
  return {
    auth,
    cancel,
    rpc,
    launch,
    consumer: consumer!,
    run,
    ended,
    sessionId,
    commandId,
    privateRoot,
    workspace,
    reservation,
    runtime,
  };
}

it.each(['expiry', 'revocation', 'abort'] as const)(
  'terminates the real owned conversation, stream and MCP owner on %s without recovery or custody cleanup',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = await fixture();
    expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
    expect(peers.close).not.toHaveBeenCalled();
    expect(f.launch).toHaveBeenCalledOnce();
    const store = getCodexConversationStore();
    const custody = store.readHostCustody(f.sessionId, f.reservation.binding)!;
    expect(custody).not.toBeNull();
    const authBytes = readFileSync(join(custody.login.privateHome, 'auth.json'));
    if (kind === 'expiry') await vi.advanceTimersByTimeAsync(f.auth.expiresAt - Date.now() + 1);
    if (kind === 'revocation') revokeAuthSession(f.auth);
    if (kind === 'abort') f.cancel.abort();
    expect(f.rpc.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledOnce(), { timeout: 300 });
    await f.run;
    expect(peers.close).toHaveBeenCalledOnce();
    expect(chat.registry.findBySessionId(f.sessionId)).toBeNull();
    expect(chat.eventStore.getSession(f.sessionId)?.state).toBe('ENDED');
    expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
    expect(f.runtime.queue()).toMatchObject([{ id: f.commandId, status: 'interrupted' }]);
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'thread/resume')).toEqual([]);
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    expect(existsSync(f.workspace.getHostReservation(f.reservation).directory)).toBe(true);
    const privateHome = join(
      f.privateRoot,
      'host-login-' +
        ordinaryLocalCodexBootstrapId(
          f.sessionId,
          chat.eventStore.getOrdinaryLocalCommandAdmission(f.commandId)!.requestFingerprint,
        ),
    );
    expect(existsSync(join(privateHome, 'auth.json'))).toBe(true);
    expect(custody.login.privateHome).toBe(privateHome);
    expect(readFileSync(join(privateHome, 'auth.json'))).toEqual(authBytes);
    expect(store.readHostCustody(f.sessionId, f.reservation.binding)).toEqual(custody);
    expect(existsSync(custody.executable.path)).toBe(true);
    expect(custody.executable.codeModeHost).toBeDefined();
    expect(existsSync(custody.executable.codeModeHost!.path)).toBe(true);
    await expect(
      f.runtime.send({ id: 'unadmitted-recovery', prompt: 'Never dispatch' }),
    ).rejects.toThrow();
    expect(f.launch).toHaveBeenCalledOnce();
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    f.consumer.close();
    expect(f.ended).toHaveBeenCalledOnce();
    expect(peers.close).toHaveBeenCalledOnce();
  },
);
