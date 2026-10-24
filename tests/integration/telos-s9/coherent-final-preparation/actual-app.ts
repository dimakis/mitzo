import { afterEach, expect, vi } from 'vitest';
import request from 'supertest';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  rm,
  copyFile,
  chmod,
  readFile,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installPrivatePublicationTransport } from './private-publication-runtime.js';
import type { CodexLifecycleTransport } from '../../../../server/codex-app-server-client.js';
import type { GithubRepositoryCommand } from '../../../../server/github-repository-source.js';
import { initializeFreshPrivateAppFiles } from './fresh-private-files.js';
import { observePrivateTodoCommandFailure } from './private-command-diagnostics.js';
import { installPrivateCanonicalReadCli } from './joined-canonical-cli.js';
import {
  installJoinedChatTransport,
  createJoinedFrontend,
  createJoinedBrowser,
} from './joined-browser-target.js';

const effects = vi.hoisted(() => ({
  repository: undefined as GithubRepositoryCommand | undefined,
  diagnose: undefined as
    | ((
        runner: import('../../../../server/protected-sdk-command.js').ProtectedSdkCommandRunner,
      ) => import('../../../../server/protected-sdk-command.js').ProtectedSdkCommandRunner)
    | undefined,
}));
// Replace the GitHub command boundary only. Parse/validate/import/custody and
// account/connection authorization are the original production implementations.
vi.mock('../../../../server/github-repository-source.js', async (original) => {
  const actual = await original<typeof import('../../../../server/github-repository-source.js')>();
  const run: GithubRepositoryCommand = (...args) => {
    if (!effects.repository) throw Error('Private GitHub effect not installed');
    return effects.repository(...args);
  };
  return {
    ...actual,
    inspectGithubRepositorySource: (selected: string, signal: AbortSignal) =>
      actual.inspectGithubRepositorySource(selected, signal, run),
    prepareGithubRepositorySource: (
      ...args: Parameters<typeof actual.prepareGithubRepositorySource>
    ) => actual.prepareGithubRepositorySource(args[0], args[1], args[2], args[3], run),
  };
});
vi.mock(
  '../../../../server/connections/capabilities/github-publish-pr-transport.js',
  async (original) => {
    const actual =
      await original<
        typeof import('../../../../server/connections/capabilities/github-publish-pr-transport.js')
      >();
    return {
      ...actual,
      GitHubCliHostPublisher: class extends actual.GitHubCliHostPublisher {
        constructor() {
          super((...args) => {
            if (!effects.repository) throw Error('Private GitHub effect not installed');
            return effects.repository(...args);
          });
        }
      },
    };
  },
);
vi.mock('../../../../server/protected-sdk-command.js', async (original) => {
  const actual = await original<typeof import('../../../../server/protected-sdk-command.js')>();
  return {
    ...actual,
    createWorkspaceRuntimeCommandRunner: (
      ...args: Parameters<typeof actual.createWorkspaceRuntimeCommandRunner>
    ) => {
      const runner = actual.createWorkspaceRuntimeCommandRunner(...args);
      return runner && effects.diagnose ? effects.diagnose(runner) : runner;
    },
  };
});
vi.mock('../../../../server/internal-token.js', () => ({
  INTERNAL_TOKEN: 'synthetic-only-ordinary-native-token',
  isValidInternalToken: (value: unknown) => value === 'synthetic-only-ordinary-native-token',
  createSignalCallbackToken: vi.fn(() => 'synthetic-callback'),
  revokeSignalCallbackToken: vi.fn(),
  isValidSignalCallbackToken: () => false,
}));
// Source-mode MCP children run from a deliberately empty non-Git task cwd.
// Resolve the test loader absolutely; preserve the real bundled MCP source,
// stdio transport, tool registration and callback implementation.
vi.mock('../../../../server/mcp-entrypoint.js', async (original) => {
  const actual = await original<typeof import('../../../../server/mcp-entrypoint.js')>();
  const { createRequire } = await import('node:module');
  const loader = createRequire(import.meta.url).resolve('tsx');
  return {
    ...actual,
    resolveBundledMcpEntrypoint: (url: string, name: string) => {
      const entry = actual.resolveBundledMcpEntrypoint(url, name);
      return {
        command: process.execPath,
        args: entry.args.map((arg) => (arg === 'tsx' ? loader : arg)),
      };
    },
  };
});
vi.mock('../../../../server/mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: () => {
    throw Error('No SDK or real model execution');
  },
  listSessions: async () => [],
  getSessionInfo: async () => null,
  getSessionMessages: async () => {
    throw Error('No external SDK history fallback');
  },
  renameSession: async () => {
    throw Error('No external SDK session rename');
  },
}));
vi.mock('../../../../server/auto-rename.js', async (original) => ({
  ...(await original<typeof import('../../../../server/auto-rename.js')>()),
  generateSessionName: async () => {
    throw Error('No automatic model naming');
  },
  createAnthropicClient: () => {
    throw Error('No automatic model naming client');
  },
}));
vi.mock('../../../../server/notify.js', () => ({
  sendTurnCompleteNotification: vi.fn(async () => {}),
}));
vi.mock('../../../../server/pushover.js', () => ({
  sendTurnCompleteNotification: vi.fn(async () => {}),
}));
vi.mock('../../../../server/goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));
vi.mock('../../../../server/account-session-name.js', () => ({
  accountSessionName: vi.fn(async () => {
    throw Error('No model-backed session naming');
  }),
}));

const cleanup: Array<() => void | Promise<void>> = [];
const finalEventOwners: Array<(priorCleanupSucceeded: boolean) => Promise<void>> = [];
const privateFilesCleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  // The signed-session decision happens after all initial session/resource
  // shutdown, while the original EventStore revocation writer is still open.
  for (const close of finalEventOwners.splice(0).reverse()) {
    try {
      await close(errors.length === 0);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const close of privateFilesCleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  effects.repository = undefined;
  effects.diagnose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors, 'Private App teardown failed');
});
const exec = promisify(execFile);
export async function createActualApp(kind: 'repository' | 'non-git') {
  const originalFetch = globalThis.fetch;
  vi.resetModules();
  const root = await realpath(await mkdtemp(join(tmpdir(), 's9-coherent-')));
  if (process.env.S9_COHERENT_PID_PATH)
    await writeFile(process.env.S9_COHERENT_PID_PATH, JSON.stringify({ pid: process.pid, root }), {
      mode: 0o600,
      flag: 'wx',
    });
  let cleanupTransferred = !!process.env.S9_COHERENT_PID_PATH;
  privateFilesCleanup.push(() =>
    cleanupTransferred ? undefined : rm(root, { recursive: true, force: true }),
  );
  let successfulColdHandoff = false;
  const records: Array<{ stage: string; facts: Record<string, unknown> }> = [];
  const record = async (stage: string, facts: Record<string, unknown>) => {
    records.push({ stage, facts });
    if (process.env.S9_COHERENT_EVIDENCE_DIR)
      await writeFile(
        join(process.env.S9_COHERENT_EVIDENCE_DIR, kind + '.json'),
        JSON.stringify(records, null, 2),
      );
  };
  const canonicalPath = join(root, 'telos.db');
  // Exclusive real birth precedes every canonical/EventStore/TaskStore owner.
  initializeFreshPrivateAppFiles(root, canonicalPath, (db) => {
    const stamp = '2026-10-16T10:00:00';
    db.prepare(
      `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,profile,priority,context_hints,first_seen,last_seen,created_at,updated_at)
      VALUES('studio','Home studio','Record music','Make music','["Approved plan"]','manual',8,'{}',?,?,?,?)`,
    ).run(stamp, stamp, stamp, stamp);
    db.prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES('studio',NULL,'active',?)`,
    ).run(stamp);
  });
  await record('fresh-files-before-application-import', {
    canonicalPath,
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  });
  const loginRoot = join(root, 'login'),
    privateRoot = join(root, 'native-custody'),
    taskRoot = join(root, 'tasks');
  for (const path of [loginRoot, privateRoot, taskRoot]) await mkdir(path, { mode: 0o700 });
  await writeFile(
    join(loginRoot, 'auth.json'),
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
  const selectedArtifact = process.env.S9_CODEX_NATIVE_FIXTURE;
  if (!selectedArtifact || !isAbsolute(selectedArtifact))
    throw Error(
      'Explicit absolute S9_CODEX_NATIVE_FIXTURE required for the qualified offline artifact',
    );
  await copyFile(selectedArtifact, executablePath);
  await chmod(executablePath, 0o755);
  const sha256 = createHash('sha256')
    .update(await readFile(executablePath))
    .digest('hex');
  const { assertQualifiedNativeMacExecutionArtifact } =
    await import('../../../../server/codex-native-artifact-qualification.js');
  assertQualifiedNativeMacExecutionArtifact(sha256);
  // The companion belongs only to the deterministic fake RPC boundary. It has
  // its own measured identity and is never qualified or executed as native code.
  const companion = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  await writeFile(join(root, 'codex-code-mode-host'), companion, { mode: 0o755 });
  const codeModeHostSha256 = createHash('sha256').update(companion).digest('hex');
  await record('qualified-offline-native-artifact-private-copy', {
    selectedArtifact,
    executablePath,
    executableSha256: sha256,
    codeModeHostSha256,
    companionQualified: false,
    providerRpc: 'deterministic fake; no model/account/provider calls',
  });
  await writeFile(
    nativePath,
    JSON.stringify({
      version: 2,
      executablePath,
      executableSha256: sha256,
      codeModeHostSha256,
    }),
    { mode: 0o600 },
  );
  const { ordinaryLocalCodexHostContractRevision } =
    await import('../../../../server/ordinary-local-codex-host-runtime.js');
  await writeFile(
    targetPath,
    JSON.stringify({
      version: 1,
      targetId: 'ordinary-fixture-local',
      label: 'Offline local',
      hostId: hostname(),
      runtimeContractRevision: ordinaryLocalCodexHostContractRevision(sha256, codeModeHostSha256),
    }),
    { mode: 0o600 },
  );
  const profilesPath = join(root, 'profiles.json');
  await writeFile(
    profilesPath,
    JSON.stringify([
      {
        id: 'ordinary-personal',
        label: 'Offline personal',
        provider: 'openai-codex',
        credentialRef: loginRoot,
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'fixture-model', label: 'Offline model', reasoningEfforts: ['low'] }],
      },
    ]),
    { mode: 0o600 },
  );
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    TELOS_DB_PATH: canonicalPath,
    MITZO_CODEX_PRIVATE_DIR: privateRoot,
    MITZO_ORDINARY_TASK_ROOT: taskRoot,
    MITZO_ACCOUNT_PROFILES_FILE: profilesPath,
    MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB: '',
    MITZO_CODEX_ENABLED: '1',
    MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '1',
    MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE: nativePath,
    MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE: targetPath,
    MITZO_REPOSITORY_WORKSPACES_ENABLED: kind === 'repository' ? '1' : '0',
  }))
    vi.stubEnv(key, value);
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
    'MITZO_WORKSPACE_RUNTIME_CONFIG',
    'MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER',
    'MITZO_SYMPOSIUM_CUSTODIAN_OWNER',
  ])
    vi.stubEnv(key, undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No external network/model calls');
    }),
  );
  effects.diagnose = (runner) =>
    observePrivateTodoCommandFailure(
      runner,
      { fixtureRoot: root, canonicalDb: canonicalPath },
      record,
    );
  const cli = await installPrivateCanonicalReadCli(root, canonicalPath);
  await record('accepted-private-cli', { cli });
  const native = await import('../../../../server/codex-app-server-client.js');
  type Actor = {
    lifecycle: CodexLifecycleTransport;
    threadId: string;
    turnId: string;
    tools: Array<{ name: string; description: string }>;
    rpc: ReturnType<typeof fakeRpc>;
  };
  const actors: Actor[] = [];
  const metadata = async (method: string) => {
    if (method === 'account/read')
      return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Offline fixture',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
        ],
        nextCursor: null,
      };
    throw Error('Unexpected provider effect ' + method);
  };
  function fakeRpc(
    lifecycle: CodexLifecycleTransport,
    threadId: string,
    turnId: string,
    tools: Actor['tools'],
  ) {
    return {
      initialize: vi.fn(async () => {}),
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'thread/start')
          tools.push(...((params?.dynamicTools as Actor['tools']) ?? []));
        if (method === 'thread/start' || method === 'thread/resume')
          return { thread: { id: threadId }, model: 'fixture-model', modelProvider: 'openai' };
        if (method === 'turn/start') return { turn: { id: turnId } };
        if (method === 'turn/interrupt') return {};
        return metadata(method);
      }),
      notify: vi.fn(),
      respond: vi.fn(),
      close: vi.fn(() => lifecycle.onClose?.(Error('Offline native closed'))),
    };
  }
  vi.spyOn(native.CodexAppServerClient, 'launchIsolated').mockImplementation(
    (_home, _env, lifecycle) => {
      if (!lifecycle) throw Error('Original native lifecycle required');
      const threadId = 'coherent-thread-' + (actors.length + 1),
        turnId = 'coherent-turn-' + (actors.length + 1),
        tools: Actor['tools'] = [];
      const rpc = fakeRpc(lifecycle, threadId, turnId, tools);
      actors.push({ lifecycle, threadId, turnId, tools, rpc });
      return rpc as unknown as ReturnType<typeof native.CodexAppServerClient.launchIsolated>;
    },
  );
  vi.spyOn(native.CodexAppServerClient, 'launchPreflight').mockImplementation(
    () =>
      ({
        initialize: vi.fn(async () => {}),
        request: vi.fn(metadata),
        notify: vi.fn(),
        close: vi.fn(),
      }) as unknown as ReturnType<typeof native.CodexAppServerClient.launchPreflight>,
  );
  for (const method of ['launch', 'launchOpenShell'] as const)
    vi.spyOn(native.CodexAppServerClient, method).mockImplementation(() => {
      throw Error('Alternate provider process forbidden');
    });
  const profiles = (await import('../../../../server/account-profiles.js')).loadAccountProfiles();
  await profiles.refresh(true);
  const binding = profiles.resolve('ordinary-personal', 'fixture-model');
  const { OrdinaryLocalCodexCapabilityCatalog } =
    await import('../../../../server/ordinary-local-codex-capabilities.js');
  const { OrdinaryLocalCodexHostRuntime } =
    await import('../../../../server/ordinary-local-codex-host-runtime.js');
  const catalog = new OrdinaryLocalCodexCapabilityCatalog(
    profiles,
    new OrdinaryLocalCodexHostRuntime().target(),
    'ordinary',
  );
  let connectionId: string | undefined,
    sourceRoot: string | undefined,
    sourceOid: string | undefined;
  if (kind === 'repository') {
    sourceRoot = join(root, 'synthetic-source');
    await mkdir(sourceRoot, { mode: 0o700 });
    const git = async (...args: string[]) =>
      (
        await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', sourceRoot!, ...args], {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        })
      ).stdout.trim();
    await git('init', '-b', 'main');
    await writeFile(join(sourceRoot, 'README.md'), 'Synthetic canonical repository.\n');
    await git('add', 'README.md');
    await git(
      '-c',
      'user.name=Offline',
      '-c',
      'user.email=offline@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Synthetic source',
    );
    sourceOid = await git('rev-parse', 'HEAD');
    effects.repository = async (command, args, signal) => {
      signal.throwIfAborted();
      await record('external-github-command', { command, args });
      if (command === 'gh') {
        if (args.join(' ') === 'api user')
          return { stdout: JSON.stringify({ login: 'offline-owner' }), stderr: '' };
        const resource = args.at(-1);
        if (resource === 'repos/owner/project')
          return {
            stdout: JSON.stringify({
              full_name: 'owner/project',
              default_branch: 'main',
              size: 1,
              archived: false,
            }),
            stderr: '',
          };
        if (resource === 'repos/owner/project/branches/main')
          return {
            stdout: JSON.stringify({ name: 'main', commit: { sha: sourceOid } }),
            stderr: '',
          };
        throw Error('Unexpected fake GitHub request');
      }
      if (command !== 'git') throw Error('Unexpected external executable');
      const local = args.map((arg) =>
        arg === 'https://github.com/owner/project.git' ? sourceRoot! : arg,
      );
      return exec('git', [...local], {
        signal,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'protocol.file.allow',
          GIT_CONFIG_VALUE_0: 'always',
        },
        maxBuffer: 64 * 1024 * 1024,
      });
    };
    const { createConnectionsRuntime, setConnectionsRuntime } =
      await import('../../../../server/connections-runtime.js');
    const runtime = createConnectionsRuntime({
      directory: join(root, 'connections'),
      eligibleAccountIds: () => [binding.accountId],
      cli: join(root, 'NO-OPENSHELL-EXECUTABLE'),
      workspace: 'offline',
    });
    const connection = runtime.store.create({
      ownerId: 'operator',
      templateId: 'github-readonly',
      templateVersion: 1,
      label: 'Offline GitHub',
      endpoint: 'https://api.github.com',
      gatewayProviderName: 'offline',
      desiredAccountIds: [binding.accountId],
      publicConfig: {
        allowedRepositories: ['owner/project'],
        allowedBaseBranches: ['main'],
      },
    });
    connectionId = runtime.store.transition(
      connection.id,
      connection.revision,
      { status: 'active', identity: 'offline-owner', verifiedAt: Date.now() },
      { operation: 'fixture-provision', outcome: 'verified-external-fake', actor: 'operator' },
    ).id;
    setConnectionsRuntime(runtime);
    cleanup.push(() => {
      setConnectionsRuntime(null);
      runtime.store.close();
    });
  }
  const publicationState: { owner?: ReturnType<typeof installPrivatePublicationTransport> } = {};
  const application = await import('../../../../server/app.js');
  const chat = await import('../../../../server/chat.js');
  const auth = await import('../../../../server/auth.js');
  auth.setAuthRevocationStore(chat.eventStore);
  const initialAuth: {
    session: Awaited<ReturnType<typeof auth.authenticateToken>>;
    token?: string;
  } = { session: null };
  finalEventOwners.push(async (priorCleanupSucceeded) => {
    const preserve = successfulColdHandoff && priorCleanupSucceeded;
    const errors: unknown[] = [];
    try {
      if (initialAuth.session) {
        if (preserve) {
          expect(initialAuth.token).toBeDefined();
          expect(await auth.authenticateToken(initialAuth.token!)).toEqual(initialAuth.session);
        } else auth.revokeAuthSession(initialAuth.session);
      }
      await record('initial-signed-session-release-before-event-owner-close', {
        operatorId: initialAuth.session?.id ?? null,
        preservedForCold: preserve,
        initialSessions: chat.registry.getActiveSessions().length,
      });
    } catch (error) {
      errors.push(error);
      // An unsuccessful handoff/cleanup must retain ordinary logout semantics.
      if (preserve && initialAuth.session) {
        try {
          auth.revokeAuthSession(initialAuth.session);
        } catch (revokeError) {
          errors.push(revokeError);
        }
      }
    }
    try {
      chat.eventStore.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, 'Initial signed-session/EventStore release failed');
  });
  const connections = await installJoinedChatTransport(
    application.app,
    chat,
    application.chatSseRegistry,
  );
  let ownersClosed = false;
  const closeLiveOwners = async () => {
    if (ownersClosed) return;
    ownersClosed = true;
    const errors: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const active of chat.registry.getActiveSessions())
      await attempt(() => chat.stopOrdinaryChat(active.clientId));
    await attempt(() =>
      vi.waitFor(() => expect(chat.registry.getActiveSessions()).toHaveLength(0)),
    );
    await attempt(() => publicationState.owner?.close());
    if (actors.length)
      await attempt(async () =>
        (await import('../../../../server/codex-chat-session.js'))
          .getCodexConversationStore()
          .close(),
      );
    await attempt(async () =>
      (await import('../../../../server/agent-library-runtime.js')).closeAgentLibrary(),
    );
    await attempt(async () =>
      (
        await import('../../../../server/repository-workspace-runtime.js')
      ).closeIdleRepositoryWorkspaces(),
    );
    await attempt(() => application.taskStore.close());
    if (errors.length) throw new AggregateError(errors, 'Awaited initial App cleanup failed');
  };
  cleanup.push(closeLiveOwners);

  const { TaskOrchestrator } = await import('../../../../server/task-orchestrator.js');
  application.setOrchestrator(
    new TaskOrchestrator({
      store: application.taskStore,
      getClientId: () => {
        throw Error('Legacy scheduler must not select a worker');
      },
      setTaskContext: () => {
        throw Error('Legacy scheduler must not mutate task context');
      },
      clearTaskContext: () => {},
      broadcastStatus: (status) => connections.broadcastAll({ type: 'loop_status', ...status }),
      broadcastTasks: () => {
        const event = { type: 'task_state' as const, tasks: application.taskStore.getTree() };
        connections.broadcastAll(event);
        application.sseRegistry.broadcast('task_state', event);
      },
    }),
  );
  const rawFront = await createJoinedFrontend(application.app, root);
  let frontClosed = false;
  const front = {
    ...rawFront,
    async close() {
      if (frontClosed) return;
      frontClosed = true;
      await rawFront.close();
    },
  };
  vi.stubEnv('PORT', String(front.port));
  cleanup.push(() => front.close());
  const login = await request(front.server)
    .post('/api/auth/login')
    .send({ passphrase: 'test-passphrase-for-vitest' });
  expect(login.status).toBe(200);
  const token = login.body.token as string;
  expect(typeof token).toBe('string');
  const authenticated = await auth.authenticateToken(token);
  if (!authenticated) throw Error('Real operator authentication required');
  initialAuth.session = authenticated;
  initialAuth.token = token;
  const connectionIdTransport = randomUUID();
  const { bindAgentLibraryTransport } =
    await import('../../../../server/agent-library-transport.js');
  cleanup.push(bindAgentLibraryTransport(connectionIdTransport, authenticated));
  const { claimTransportConnection, releaseTransportConnection } =
    await import('../../../../server/transport-auth-ownership.js');
  claimTransportConnection(connectionIdTransport, authenticated.id);
  const { SseTransport } = await import('../../../../server/sse-transport.js');
  const streamMessages: Record<string, unknown>[] = [];
  const originalSend = application.chatSseRegistry.sendTo.bind(application.chatSseRegistry);
  vi.spyOn(application.chatSseRegistry, 'sendTo').mockImplementation((id, message) => {
    streamMessages.push(message);
    return originalSend(id, message);
  });
  const stream = {
    write: vi.fn(() => true),
    end: vi.fn(),
    writableEnded: false,
  } as unknown as import('express').Response;
  application.chatSseRegistry.add(connectionIdTransport, stream, authenticated.id);
  connections.register(
    connectionIdTransport,
    new SseTransport(connectionIdTransport, application.chatSseRegistry),
  );
  application.setTaskBroadcast((event) => {
    connections.broadcastAll(event);
    application.sseRegistry.broadcast('task_state', event);
  });
  cleanup.push(async () => {
    // Stop/unregister before waiting; auth release is the final EventStore phase.
    for (const active of chat.registry.getActiveSessions()) chat.stopOrdinaryChat(active.clientId);
    await vi.waitFor(() => expect(chat.registry.getActiveSessions()).toHaveLength(0));
    application.chatSseRegistry.remove(connectionIdTransport);
    releaseTransportConnection(connectionIdTransport, authenticated.id);
  });
  const { fixture: externalGithubFixture } =
    await import('../../../../server/__tests__/fixtures/github-main-publication.js');
  const publicationExternal = externalGithubFixture();
  const selectedPublication = installPrivatePublicationTransport(
    { registry: chat.registry, events: chat.eventStore, databasePath: () => canonicalPath },
    {
      privateCanonicalRoot: root,
      registration: {
        accountId: binding.accountId,
        connectionId: 's9-main-connection',
        capabilityId: 's9-main-capability',
        label: 'Private main publication',
        repository: 'owner/project',
        repositoryId: 101,
        repositoryNodeId: 'R_original',
        publisherLogin: 'publisher',
        trustedReviewer: 'centaur',
        centaurAppId: 731,
        requiredChecks: ['CI', 'Centaur final LGTM'],
      },
      external: { run: publicationExternal.run },
      record,
    },
  );
  publicationState.owner = selectedPublication;
  cleanup.push(() => selectedPublication.close());
  const { TelosMainPublicationRecords } =
    await import('../../../../server/telos-main-publication-records.js');
  // Passive observers forward the original methods automatically. Retain their
  // actual private receipts; runtime.request intentionally projects public data.
  const receiptObservers = [
    vi.spyOn(TelosMainPublicationRecords.prototype, 'prepare'),
    vi.spyOn(TelosMainPublicationRecords.prototype, 'admit'),
    vi.spyOn(TelosMainPublicationRecords.prototype, 'deny'),
    vi.spyOn(TelosMainPublicationRecords.prototype, 'accept'),
    vi.spyOn(TelosMainPublicationRecords.prototype, 'existingForHost'),
  ];
  const publicationReceipts: import('../../../../server/telos-main-publication-contract.js').MainPublicationReceipt[] =
    [];
  const originalPublicationRequest = selectedPublication.request.bind(selectedPublication);
  vi.spyOn(selectedPublication, 'request').mockImplementation(async (context, input) => {
    await record('original-native-publication-context-before-real-runtime', {
      conversationId: context.conversationId,
      clientId: context.clientId,
      runtimeId: context.runtimeId,
      operatorId: context.operatorId,
      accountBinding: context.accountBinding,
      selectedRole: context.selectedRole,
      input,
    });
    const receipt = await originalPublicationRequest(context, input);
    const retained = receiptObservers
      .flatMap((observer) =>
        observer.mock.results.map((result, index) => ({
          value: result.type === 'return' ? result.value : undefined,
          order: observer.mock.invocationCallOrder[index],
        })),
      )
      .filter((entry) => entry.value?.pins.input.requestId === receipt.requestId)
      .sort((a, b) => a.order - b.order)
      .at(-1)?.value;
    if (!retained) throw Error('Original publication records did not expose their actual receipt');
    publicationReceipts.push(retained);
    await record('original-native-publication-real-durable-receipt', {
      publicResult: receipt,
      retained,
    });
    return receipt;
  });
  const http = async (path: string, init?: RequestInit) => {
    const call =
      init?.method === 'POST' ? request(front.server).post(path) : request(front.server).get(path);
    call.set('Authorization', 'Bearer ' + token).set('X-Connection-Id', connectionIdTransport);
    for (const [key, value] of new Headers(init?.headers)) call.set(key, value);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    await record('actual-app-http', {
      path,
      status: response.status,
      body: response.headers['content-type']?.includes('json') ? response.body : undefined,
    });
    return new Response(
      response.headers['content-type']?.includes('json')
        ? JSON.stringify(response.body)
        : response.body instanceof Buffer
          ? response.body
          : response.text,
      {
        status: response.status,
        headers: { 'Content-Type': response.headers['content-type'] ?? 'application/octet-stream' },
      },
    );
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const address = front.server.address();
      if (
        !address ||
        typeof address === 'string' ||
        address.address !== '127.0.0.1' ||
        address.port !== front.port ||
        ![front.origin, 'http://localhost:' + front.port].includes(url.origin) ||
        url.username ||
        url.password ||
        url.hash ||
        !url.pathname.startsWith('/api/internal/')
      )
        throw Error('Only the actual owned private App callback origin is allowed');
      // Preserve original URL/auth/body/signal; the fixture owns the IPv4
      // listener for this exact port. Never follow a redirect outside it.
      return originalFetch(input, { ...init, redirect: 'error' });
    }),
  );
  const { getAgentLibrary } = await import('../../../../server/agent-library-runtime.js');
  const library = getAgentLibrary();
  library.saveDraft('user', {
    profileId: 'coherent-worker',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Coherent worker',
      descriptor: 'Synthetic offline',
      role: 'agent',
      instructions: 'Use reviewed retained context and report evidence.',
      expectedOutput: 'Retained report',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent',
    },
  });
  const profile = library.publish('user', {
    profileId: 'coherent-worker',
    expectedVersion: 1,
    idempotencyKey: 'publish',
  });
  library.saveDraft('user', {
    profileId: 'coherent-publisher',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'publication-draft',
    definition: {
      name: 'Reviewed publication lead',
      descriptor: 'Synthetic explicit main capability',
      role: 'agent',
      instructions:
        'Publish only the exact reviewed source through the separately selected native capability.',
      expectedOutput: 'Durable canonical publication receipt',
      acceptanceCriteria: ['Normal remote gates and exact receipt'],
      modelPolicyRole: 'agent',
      tools: ['Read', 'RequestGithubMainPublication', 'TelosSaveArtifact', 'TelosReadArtifact'].map(
        (name) => ({ id: 'mitzo:' + name, version: 1 }),
      ),
    },
  });
  const publisherProfile = library.publish('user', {
    profileId: 'coherent-publisher',
    expectedVersion: 1,
    idempotencyKey: 'publication-publish',
  });
  const selection = {
    version: 1 as const,
    agent: { profileId: profile.profileId, revision: profile.revision },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 as const },
    model: 'fixture-model',
    thinking: 'low',
  };
  const runtime = {
    account: catalog.inventory().accounts[0].account,
    harness: 'codex' as const,
    targetId: 'ordinary-fixture-local',
    mode: 'agent' as const,
  };
  const browser = await createJoinedBrowser(front.origin, token, {
    viewport: { width: 1440, height: 1000 },
  });
  let browserClosed = false;
  const closeBrowser = async () => {
    if (browserClosed) return;
    browserClosed = true;
    await browser.browser.close();
  };
  cleanup.push(closeBrowser);
  await browser.page.addInitScript(() => localStorage.setItem('mitzo:transport', 'sse'));
  const { OrdinaryWorkspaceApiClient, TelosWorkApiClient } = await import('@mitzo/client');
  const ordinary = new OrdinaryWorkspaceApiClient(http),
    api = new TelosWorkApiClient(http);
  const actorBySession = new Map<string, Actor>();
  const bindActor = (sessionId: string) => {
    expect(chat.registry.findBySessionId(sessionId)).toBeTruthy();
    expect(actors.length).toBe(actorBySession.size + 1);
    const actor = actors.at(-1)!;
    expect([...actorBySession.values()]).not.toContain(actor);
    actorBySession.set(sessionId, actor);
  };
  const nativeCall = async (
    sessionId: string,
    name: string,
    input: unknown,
    beforeOnce?: () => Promise<void>,
  ) => {
    const handle = chat.registry.findBySessionId(sessionId);
    if (!handle) throw Error('Original native actor missing');
    const actor = actorBySession.get(sessionId);
    if (!actor) throw Error('Original retained native thread missing');
    const definition = actor.tools.find(
      (tool) =>
        tool.name === name ||
        tool.description.startsWith(
          (name.startsWith('mcp__') ? name : 'mcp__telos__' + name) + ':',
        ),
    );
    expect(definition).toBeTruthy();
    const before = streamMessages.length,
      callId = randomUUID();
    const pending = actor.lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: actor.threadId,
        turnId: actor.turnId,
        callId,
        tool: definition!.name,
        arguments: input,
      },
      new AbortController().signal,
    ) as Promise<{ success: boolean; contentItems: Array<{ type: string; text?: string }> }>;
    // Safe tools need no fabricated permission. For actual pending permission,
    // consume the real application's authenticated Once endpoint exactly once.
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() =>
      expect(
        settled ||
          streamMessages
            .slice(before)
            .some(
              (message) => message.type === 'permission_request' && message.sessionId === sessionId,
            ),
      ).toBe(true),
    );
    const permission = streamMessages
      .slice(before)
      .find((message) => message.type === 'permission_request' && message.sessionId === sessionId);
    if (permission) {
      await beforeOnce?.();
      const allowed = await http('/api/chat/permission', {
        method: 'POST',
        body: JSON.stringify({
          type: 'permission_response',
          sessionId,
          permId: permission.permId,
          decision: 'once',
        }),
      });
      expect(allowed.status).toBe(200);
    }
    const result = await pending;
    const observed = {
      conversationId: sessionId,
      threadId: actor.threadId,
      turnId: actor.turnId,
      callId,
      result,
    };
    await record('original-native-callback-and-once-result', {
      name,
      input,
      observed,
      permId: permission?.permId ?? null,
    });
    return observed;
  };
  return {
    kind,
    root,
    taskRoot,
    canonicalPath,
    application,
    chat,
    api,
    ordinary,
    http,
    record,
    records,
    actors,
    runtime,
    selection,
    binding,
    capabilityRevision: catalog.inventory().capabilityRevision,
    connectionId,
    sourceRoot,
    sourceOid,
    browser,
    front,
    nativeCall,
    bindActor,
    actorBySession,
    completeSuccessfulColdHandoff: () => {
      successfulColdHandoff = true;
    },
    transferPrivateRootCleanup: () => {
      cleanupTransferred = true;
    },
    registerCleanup: (close: () => void | Promise<void>) => cleanup.push(close),
    closeLiveOwners,
    publisherProfile,
    publication: selectedPublication,
    publicationExternal,
    publicationReceipts,
    token,
    connectionIdTransport,
    authenticated,
  };
}
