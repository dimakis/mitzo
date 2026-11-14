import { resetOfflineUserEnvironment } from '../../server/__tests__/fixtures/offline-user-home.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentLibrarySource } from '../../server/__tests__/fixtures/agent-library-source.js';
vi.mock('../../server/claude-account-history.js', () => ({
  readClaudeAccountHistory: vi.fn(async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained' }],
  })),
}));
const services = vi.hoisted(() => ({
  authId: '',
  auth: undefined as import('../../server/auth.js').AuthSession | undefined,
  workspace: undefined as unknown,
  library: undefined as unknown,
  query: vi.fn(),
  credentialReadFailure: false,
  requests: [] as Array<{
    options: Record<string, unknown>;
    prompt: AsyncIterable<Record<string, unknown>>;
  }>,
}));
// Model only the external free-space observation for these tiny fixtures. The
// actual descriptor-relative copy, capacity guard, Git and owner stores execute.
// The physical host is under disk pressure; this does not qualify its free space.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const capacity = 'os.fstatvfs(parent).f_bavail * os.fstatvfs(parent).f_frsize';
  return {
    ...actual,
    execFile: new Proxy(actual.execFile, {
      apply(target, receiver, args) {
        const [file, argv] = args;
        if (
          file === 'python3' &&
          Array.isArray(argv) &&
          argv[0] === '-I' &&
          argv[1] === '-c' &&
          typeof argv[2] === 'string' &&
          argv[2].includes(capacity)
        ) {
          args[1] = [...argv];
          args[1][2] = argv[2].replace(capacity, String(8 * 1024 ** 3));
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  };
});
// Keep the real fixture owner without importing the process-global owner while
// its mock is initializing: that import cycle can capture the global getter.
vi.mock('../../server/repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: () => services.workspace,
  getRepositoryWorkspaceCustody: () => services.workspace,
  repositoryWorkspaceBinding: () => {
    throw Error('No repository selection in this fixture');
  },
  repositoryWorkspaceCatalog: () => {
    throw Error('No repository catalog in this fixture');
  },
  closeIdleRepositoryWorkspaces: () => {},
  getOrdinaryWorkspaces: () => {
    throw Error('No ordinary workspace selected by this repository fixture');
  },
  getLocalRepositoryWorkspaces: () => {
    throw Error('No local source selected by this repository fixture');
  },
  readRepositoryWorkspaceForConversation: (
    sessionId: string,
    expectedWorkspaceId?: string | null,
  ) => {
    const record = (
      services.workspace as import('../../server/repository-workspaces.js').RepositoryWorkspaces
    ).getForConversation(sessionId);
    if (expectedWorkspaceId && record?.id !== expectedWorkspaceId)
      throw Error('Repository claim ledger is unavailable or changed; preserve the conversation');
    return record;
  },
}));
vi.mock('../../server/agent-library-runtime.js', async (original) => ({
  ...(await original<object>()),
  getAgentLibrary: () => services.library,
}));
vi.mock('../../server/auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
  authMiddleware: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.authSession = services.auth;
    next();
  },
  operatorAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../server/connections-router.js', async (original) => ({
  ...(await original<object>()),
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../server/transport-auth-ownership.js', async (original) => ({
  ...(await original<object>()),
  liveTransportAuthSessionId: () => services.authId,
}));
vi.mock('../../server/mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
// Native SDK processes are simulated here; filesystem/process enforcement has
// separate boundary tests and must not inspect the developer's credential roots.
vi.mock('../../server/credential-sdk-boundary.js', () => ({
  credentialSdkBoundary: () => ({ spawnClaudeCodeProcess: () => new EventEmitter() }),
  runtimeFilesystemSdkBoundary: () => undefined,
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
vi.mock('../../server/account-use-store.js', () => ({
  getAccountUseStore: () => ({ record() {} }),
}));
vi.mock('../../server/keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    async read() {
      if (services.credentialReadFailure)
        throw Error('OFFLINE_KEYCHAIN_UNAVAILABLE synthetic-secret');
      return {
        value: 'synthetic-key',
        version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
        managed: true,
      };
    }
  },
}));
const cleanups: Array<() => void | Promise<void>> = [];
// afterEach restores the host environment; each scenario must clear its private
// enrollments again before exercising real privacy guards against fixture paths.
beforeEach(resetOfflineUserEnvironment);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  services.requests.length = 0;
  services.query.mockReset();
  services.credentialReadFailure = false;
});
it.each(
  [
    {
      personal: false,
      managed: false,
      refuseStartup: false,
      stdinRevocation: false,
      idleSuccess: false,
    },
    {
      personal: true,
      managed: false,
      refuseStartup: false,
      stdinRevocation: false,
      idleSuccess: false,
    },
    {
      personal: true,
      managed: true,
      refuseStartup: false,
      stdinRevocation: false,
      idleSuccess: false,
    },
    {
      personal: false,
      managed: false,
      refuseStartup: true,
      stdinRevocation: false,
      idleSuccess: false,
    },
    {
      personal: true,
      managed: false,
      refuseStartup: true,
      stdinRevocation: false,
      idleSuccess: false,
    },
    {
      personal: false,
      managed: false,
      refuseStartup: false,
      stdinRevocation: true,
      idleSuccess: false,
    },
    {
      personal: false,
      managed: false,
      refuseStartup: false,
      stdinRevocation: false,
      idleSuccess: true,
    },
    ...(['none', 'input', 'permission'] as const).map((credentialFailure) => ({
      personal: false,
      managed: false,
      refuseStartup: false,
      stdinRevocation: false,
      idleSuccess: false,
      anthropicApi: true,
      credentialFailure,
    })),
    ...[false, true].flatMap((personal) =>
      ['default', 'explicit', 'excluded'].map((repositoryProfile) => ({
        personal,
        managed: false,
        refuseStartup: false,
        stdinRevocation: false,
        idleSuccess: false,
        repositoryTransfer: true,
        repositoryProfile,
      })),
    ),
  ].map((scenario) => ({
    anthropicApi: false,
    credentialFailure: 'none',
    repositoryTransfer: false,
    repositoryProfile: 'default',
    ...scenario,
  })),
)(
  'routes first, queued future and cold commands through the actual SDK owner with original thread; personal=$personal managed=$managed refuseStartup=$refuseStartup stdinRevocation=$stdinRevocation idleSuccess=$idleSuccess anthropicApi=$anthropicApi credentialFailure=$credentialFailure repositoryTransfer=$repositoryTransfer repositoryProfile=$repositoryProfile',
  async ({
    personal,
    managed,
    refuseStartup,
    stdinRevocation,
    idleSuccess,
    anthropicApi,
    credentialFailure,
    repositoryTransfer,
    repositoryProfile,
  }) => {
    const nextModel = managed ? 'opus' : 'next-model';
    const nextThinking = managed ? null : 'high';
    // Each account scenario gets its own controller/event-store singletons.
    vi.resetModules();
    const { ClaudeSubscriptionCustody } =
      await import('../../server/claude-subscription-custody.js');
    const { ownedVertexRuntimeFixture } =
      await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, {
      chatRoute: true,
      personal,
      managed,
      anthropicApi: anthropicApi || (refuseStartup && !personal),
      ...(idleSuccess ? { tools: [{ id: 'mitzo:AgentCommunication', version: 1 }] } : {}),
      ...(repositoryProfile !== 'default'
        ? {
            tools: [
              'Bash',
              'Read',
              'Write',
              'Edit',
              'AskUserQuestion',
              'RequestWebAccess',
              'AgentCommunication',
              'SearchPastSessions',
              'ReadPastSession',
              'ReadKnowledge',
              'SaveKnowledgeDraft',
              'AgentReadTasks',
              'AgentProposeTask',
              'ListConnections',
              'RequestConnectionAccess',
              'ConnectionRequest',
              'PrepareConnectionSetup',
            ]
              .filter((name) => repositoryProfile !== 'excluded' || name !== 'Write')
              .map((name) => ({ id: `mitzo:${name}`, version: 1 as const })),
          }
        : {}),
    });
    // Start in the ordinary MGMT-like task, with two unrelated configured sources.
    // Only provider inference is simulated; preparation, permissions and Git run.
    const transferred = new Map<string, string>();
    const transferCalls: string[] = [];
    const { join: repoJoin } = await import('node:path');
    const { mkdtemp, readFile, realpath, rm, writeFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const targetRoot = repositoryTransfer
      ? await realpath(await mkdtemp(repoJoin(tmpdir(), 'mitzo-transfer-')))
      : f.root;
    if (repositoryTransfer) cleanups.push(() => rm(targetRoot, { recursive: true, force: true }));
    const repositorySources = ['mitzo', 'another', 'interrupted', 'removed'].map((name) => ({
      name,
      path: repoJoin(targetRoot, name),
      head: '',
    }));
    const git = (path: string, ...args: string[]) =>
      execFileSync(
        'git',
        ['-C', path, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
          },
        },
      ).trim();
    if (repositoryTransfer) {
      // BASE_REPO must itself be a real source to reproduce primary replacement.
      execFileSync('git', ['init', '-q', '-b', 'main', f.root]);
      git(f.root, 'config', 'user.name', 'Offline');
      git(f.root, 'config', 'user.email', 'fixture@example.test');
      await writeFile(repoJoin(f.root, 'primary.txt'), 'MGMT source\n');
      git(f.root, 'add', 'primary.txt');
      git(f.root, 'commit', '-qm', 'MGMT source');
      for (const source of repositorySources) {
        execFileSync('git', ['init', '-q', '-b', 'main', source.path]);
        git(source.path, 'config', 'user.name', 'Offline');
        git(source.path, 'config', 'user.email', 'fixture@example.test');
        await writeFile(repoJoin(source.path, 'app.txt'), 'Original source\n');
        git(source.path, 'add', 'app.txt');
        git(source.path, 'commit', '-qm', 'Initial source');
        source.head = git(source.path, 'rev-parse', 'HEAD');
        await writeFile(repoJoin(source.path, 'app.txt'), 'User dirty work\n');
      }
      await writeFile(
        repoJoin(f.root, '.mitzo.json'),
        JSON.stringify({
          repos: {
            mgmt: f.root,
            ...Object.fromEntries(repositorySources.map((s) => [s.name, s.path])),
          },
        }),
      );
    }
    async function transferRepository(options: Options, commandId: string) {
      if (!repositoryTransfer) return;
      if (![f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold'].includes(commandId))
        return;
      const session = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
      const { getPendingRequestsBySession, resolvePending } = await import('@mitzo/harness');
      const useTool = async (
        name: string,
        input: Record<string, unknown>,
        toolUseID: string,
        signal = new AbortController().signal,
      ) => {
        const result = options.canUseTool!(name, input, {
          signal,
          toolUseID,
          requestId: toolUseID,
        });
        let settled = false;
        void result.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await vi.waitFor(
          () => {
            const pending = getPendingRequestsBySession(f.reservation.conversationId);
            if (pending.length) {
              expect(pending).toHaveLength(1);
              expect(resolvePending(pending[0].permId, 'once')).toBe(true);
            }
            expect(settled || pending.length === 1).toBe(true);
          },
          { timeout: 10_000 },
        );
        return result;
      };
      if (commandId === 'queued' && repositoryProfile !== 'excluded') {
        const primary = structuredClone(session.worktreePaths.get('primary'));
        expect(
          await useTool(
            'Write',
            { file_path: repoJoin(f.root, 'primary.txt'), content: 'Never replace custody' },
            `${commandId}-primary-source`,
          ),
        ).toMatchObject({ behavior: 'deny' });
        expect(session.worktreePaths.get('primary')).toEqual(primary);
        expect(session.worktreePaths.has('mgmt')).toBe(false);
        expect(git(f.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(
          1,
        );
        expect(await readFile(repoJoin(f.root, 'primary.txt'), 'utf8')).toBe('MGMT source\n');

        const source = repositorySources[2];
        const sdkId = String(options.resume ?? options.sessionId);
        const partial = repoJoin(source.path, '.claude', 'worktrees', sdkId);
        const controller = new AbortController();
        const { createWorktreeAsync } = await import('../../server/worktree.js');
        await expect(
          createWorktreeAsync(sdkId, source.path, {
            startPoint: source.head,
            safeLocalPreparation: true,
            safeLocalRequireNew: true,
            abortSignal: controller.signal,
            safeLocalBeforeEffect: async () => {
              if (existsSync(repoJoin(partial, '.git'))) {
                controller.abort(Error('Interrupted after worktree registration'));
                controller.signal.throwIfAborted();
              }
            },
          }),
        ).rejects.toThrow('Interrupted after worktree registration');
        expect(existsSync(repoJoin(partial, '.git'))).toBe(true);
        expect(existsSync(repoJoin(partial, 'app.txt'))).toBe(false);
        expect(chat.eventStore.getLatestWorktreePath(session.sessionId!, source.name)).toBeNull();
        const before = git(source.path, 'worktree', 'list', '--porcelain');
        expect(
          await useTool(
            'Write',
            { file_path: repoJoin(source.path, 'app.txt'), content: 'Never adopt uncertainty' },
            `${commandId}-interrupted-source`,
          ),
        ).toMatchObject({ behavior: 'deny' });
        expect(session.worktreePaths.has(source.name)).toBe(false);
        expect(chat.eventStore.getLatestWorktreePath(session.sessionId!, source.name)).toBeNull();
        expect(git(source.path, 'worktree', 'list', '--porcelain')).toBe(before);
        expect(existsSync(repoJoin(partial, 'app.txt'))).toBe(false);
        expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
        expect(await readFile(repoJoin(source.path, 'app.txt'), 'utf8')).toBe('User dirty work\n');

        const removed = repositorySources[3];
        expect(
          await useTool(
            'Write',
            { file_path: repoJoin(removed.path, 'app.txt'), content: 'Prepare completed checkout' },
            `${commandId}-removed-source`,
          ),
        ).toMatchObject({ behavior: 'deny' });
        const completed = session.worktreePaths.get(removed.name)!.path;
        expect(await readFile(repoJoin(completed, 'app.txt'), 'utf8')).toBe('Original source\n');
        expect(chat.eventStore.getLatestWorktreePath(session.sessionId!, removed.name)).toBe(
          completed,
        );
        git(removed.path, 'worktree', 'remove', completed);
        expect(existsSync(completed)).toBe(false);
      }
      if (commandId === 'retained-cold-tail' && repositoryProfile !== 'excluded') {
        const removed = repositorySources[3];
        const completed = chat.eventStore.getLatestWorktreePath(session.sessionId!, removed.name)!;
        expect(completed).toBeTruthy();
        expect(existsSync(completed)).toBe(false);
        expect(session.worktreePaths.has(removed.name)).toBe(false);
        const controller = new AbortController();
        const { OrdinaryLocalVertexSdkAuthority } =
          await import('../../server/ordinary-local-vertex-sdk-authority.js');
        const original = OrdinaryLocalVertexSdkAuthority.prototype.assertCurrent;
        const authority = vi
          .spyOn(OrdinaryLocalVertexSdkAuthority.prototype, 'assertCurrent')
          .mockImplementation(async function (
            this: InstanceType<typeof OrdinaryLocalVertexSdkAuthority>,
            signal,
          ) {
            await original.call(this, signal);
            if (existsSync(repoJoin(completed, '.git'))) {
              controller.abort(Error('Interrupted recreation after historical completion'));
              controller.signal.throwIfAborted();
            }
          });
        try {
          expect(
            await useTool(
              'Write',
              {
                file_path: repoJoin(removed.path, 'app.txt'),
                content: 'Never recreate uncertainty',
              },
              `${commandId}-removed-source`,
              controller.signal,
            ),
          ).toMatchObject({ behavior: 'deny' });
          expect(existsSync(completed)).toBe(false);
          expect(controller.signal.aborted).toBe(false); // Refuse before any recreation.
          expect(session.worktreePaths.has(removed.name)).toBe(false);
          expect(chat.eventStore.getLatestWorktreePath(session.sessionId!, removed.name)).toBe(
            completed,
          );
          expect(
            git(removed.path, 'worktree', 'list', '--porcelain').match(/^worktree /gm),
          ).toHaveLength(1);
          expect(git(removed.path, 'rev-parse', 'HEAD')).toBe(removed.head);
          expect(await readFile(repoJoin(removed.path, 'app.txt'), 'utf8')).toBe(
            'User dirty work\n',
          );
        } finally {
          authority.mockRestore();
        }
      }
      const sources = repositorySources.slice(0, commandId === f.request.clientMsgId ? 1 : 2);
      for (const source of sources) {
        if (repositoryProfile === 'excluded') {
          expect(
            await useTool(
              'Write',
              { file_path: repoJoin(source.path, 'app.txt'), content: 'Never admitted' },
              `${commandId}-${source.name}-excluded`,
            ),
          ).toMatchObject({ behavior: 'deny' });
          expect(session.worktreePaths.has(source.name)).toBe(false);
          expect(
            git(source.path, 'worktree', 'list', '--porcelain').match(/^worktree /gm),
          ).toHaveLength(1);
          expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
          expect(await readFile(repoJoin(source.path, 'app.txt'), 'utf8')).toBe(
            'User dirty work\n',
          );
          continue;
        }
        if (!session.worktreePaths.has(source.name)) {
          const result = await useTool(
            'Write',
            { file_path: repoJoin(source.path, 'app.txt'), content: 'Requested task edit' },
            `${commandId}-${source.name}-prepare`,
          );
          expect(result.behavior).toBe('deny'); // Redirect the original source write.
          const created = session.worktreePaths.get(source.name)?.path;
          expect(created, JSON.stringify(result)).toBeDefined();
          expect(JSON.stringify(result)).toContain(created);
          if (transferred.has(source.name)) expect(created).toBe(transferred.get(source.name));
          transferred.set(source.name, created!);
        }
        const task = session.worktreePaths.get(source.name)!.path;
        expect(task).not.toBe(source.path);
        const path = repoJoin(task, 'app.txt');
        const content = `Completed in ${commandId}\n`;
        expect(
          await useTool('Write', { file_path: path, content }, `${commandId}-${source.name}-edit`),
        ).toMatchObject({ behavior: 'allow' });
        await writeFile(path, content);
        expect(await readFile(path, 'utf8')).toBe(content);
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        expect(
          await useTool(
            'Bash',
            { command: `git -C ${quote(task)} diff --check` },
            `${commandId}-${source.name}-check`,
          ),
        ).toMatchObject({ behavior: 'allow' });
        git(task, 'diff', '--check');
        expect(
          await useTool(
            'Bash',
            {
              command: `git -C ${quote(task)} add -- app.txt && git -C ${quote(task)} commit -m ${quote(commandId)}`,
            },
            `${commandId}-${source.name}-commit`,
          ),
        ).toMatchObject({ behavior: 'allow' });
        git(task, 'add', 'app.txt');
        git(
          task,
          '-c',
          'user.name=Offline',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-qm',
          commandId,
        );
        expect(git(source.path, 'rev-parse', 'HEAD')).toBe(source.head);
        expect(await readFile(repoJoin(source.path, 'app.txt'), 'utf8')).toBe('User dirty work\n');
      }
      transferCalls.push(commandId);
    }
    const informationCalls: string[] = [];
    async function invokeInformation(options: Options, commandId: string) {
      if (idleSuccess) return; // This scenario intentionally selects only communication.
      if (![f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold'].includes(commandId))
        return;
      const server = options.mcpServers!['mitzo-connections'] as McpSdkServerConfigWithInstance;
      const client = new Client({ name: 'synthetic-information-provider', version: '1' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toEqual(
          expect.arrayContaining([
            'SearchPastSessions',
            'ReadPastSession',
            'ReadKnowledge',
            'SaveKnowledgeDraft',
            'AgentReadTasks',
            'AgentProposeTask',
            'AgentCommunication',
          ]),
        );
        expect(names).not.toContain('ListSessions');
        for (const [name, input] of [
          ['AgentCommunication', { operation: 'list', offset: 0 }],
          ['SearchPastSessions', { query: 'information fixture' }],
          ['ReadPastSession', { conversationId: 'information-fixture' }],
          ['AgentReadTasks', { action: 'list' }],
        ] as const) {
          expect(
            await options.canUseTool!('mcp__mitzo-connections__' + name, input, {
              signal: new AbortController().signal,
              toolUseID: `${commandId}-${name}`,
            }),
          ).toMatchObject({ behavior: 'allow' });
          const result = await client.callTool({ name, arguments: input });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          if (name === 'ReadPastSession')
            expect(JSON.stringify(result.content)).toContain('Public information fixture');
          if (name === 'SearchPastSessions')
            expect(JSON.stringify(result.content)).toContain('information-fixture');
        }
        informationCalls.push(commandId);
      } finally {
        await client.close();
        // SDK owns the server lifetime. Its query is still consuming this call.
      }
    }
    if (personal) {
      const capture = ClaudeSubscriptionCustody.capture;
      vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
        capture(env, f.personalExecutable),
      );
      vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    }
    const { SkillRegistry } = await import('../../server/skills.js');
    const registries = await import('../../server/skill-registry-runtime.js');
    const { join } = await import('node:path');
    vi.spyOn(registries, 'buildSkillRegistry').mockReturnValue(
      new SkillRegistry({ bundledDir: join(process.cwd(), 'skills') }),
    );
    f.request.payload.text = '/mockup First SDK dashboard';
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
    let releaseRetainedTail: (() => void) | undefined;
    let consumePeer: (() => Promise<Record<string, unknown>>) | undefined;
    let idleInputReady: Promise<void> | undefined;
    let first = true;
    const history: string[] = [];
    const approvedInputs: string[] = [];
    const providerInputs: string[] = [];
    services.query.mockImplementation((request) => {
      services.requests.push(request);
      const id = request.options.resume ?? request.options.sessionId;
      const closed = { value: false };
      const process = request.options.spawnClaudeCodeProcess({
        signal: request.options.abortController.signal,
      });
      const instance = {
        accountInfo: vi.fn(async () => ({
          email: refuseStartup ? 'other@example.test' : 'person@example.test',
          subscriptionType: 'max',
          apiProvider: 'firstParty',
        })),
        async *[Symbol.asyncIterator]() {
          if (idleInputReady) await idleInputReady;
          if (credentialFailure === 'input') services.credentialReadFailure = true;
          const inputs = request.prompt[Symbol.asyncIterator]();
          for await (const message of { [Symbol.asyncIterator]: () => inputs }) {
            if (closed.value) break;
            const inputUuid = message.uuid ?? `input-${message.mitzoMessageId}`;
            history.push(message.mitzoMessageId);
            const content = message.message.content;
            providerInputs.push(
              typeof content === 'string'
                ? content
                : content.map((block: { text?: string }) => block.text ?? '').join(''),
            );
            if (message.uuid) {
              for (const replay of [
                { uuid: randomUUID(), content: message.message.content },
                { uuid: message.uuid, content: 'Wrong peer acknowledgement text' },
              ]) {
                yield {
                  type: 'user',
                  parent_tool_use_id: null,
                  uuid: replay.uuid,
                  message: { role: 'user', content: replay.content },
                };
                expect(
                  chat.eventStore.agentCommunication.forCommand(message.mitzoMessageId)?.message
                    .status,
                ).not.toBe('delivered');
              }
            }
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
            if (message.uuid)
              yield {
                type: 'user',
                uuid: inputUuid,
                parent_tool_use_id: null,
                message: { role: 'user', content: message.message.content },
              };
            await invokeInformation(request.options as Options, message.mitzoMessageId);
            await transferRepository(request.options as Options, message.mitzoMessageId);
            // Exercise the installed callback on each first/queued/cold query,
            // while its original ordinary command still owns the SDK input.
            const { getPendingRequestsBySession, resolvePending } = await import('@mitzo/harness');
            const permission = request.options.canUseTool(
              'Bash',
              { command: 'pwd' },
              {
                signal: new AbortController().signal,
                toolUseID: `native-${message.mitzoMessageId}`,
              },
            );
            if (idleSuccess) {
              expect(await permission).toMatchObject({ behavior: 'deny' });
              expect(getPendingRequestsBySession(f.reservation.conversationId)).toEqual([]);
            } else {
              await vi.waitFor(() =>
                expect(getPendingRequestsBySession(f.reservation.conversationId)).toHaveLength(1),
              );
              const card = getPendingRequestsBySession(f.reservation.conversationId)[0];
              expect(card).toMatchObject({
                toolName: 'Bash',
                toolInput: 'pwd',
                sessionId: f.reservation.conversationId,
              });
              expect(
                chat.registry.findBySessionId(f.reservation.conversationId)!.session
                  .ownedLocalAuthSessionId,
              ).toBe(f.auth.id);
              expect(resolvePending(card.permId, 'once', undefined, 'foreign-conversation')).toBe(
                false,
              );
              expect(
                resolvePending(card.permId, 'once', undefined, f.reservation.conversationId),
              ).toBe(true);
              expect(await permission).toMatchObject({
                behavior: 'allow',
                updatedInput: { command: 'pwd' },
              });
              expect(
                resolvePending(card.permId, 'once', undefined, f.reservation.conversationId),
              ).toBe(false);
              approvedInputs.push(message.mitzoMessageId);
            }
            if (first) {
              first = false;
              const completed = new Promise<void>((resolve) => {
                releaseFirst = resolve;
                request.options.abortController.signal.addEventListener('abort', resolve, {
                  once: true,
                });
              });
              const peer = await new Promise<Record<string, unknown>>((resolve) => {
                consumePeer = async () => {
                  const correction = (await inputs.next()).value;
                  resolve(correction);
                  return correction;
                };
                request.options.abortController.signal.addEventListener(
                  'abort',
                  () => resolve({}),
                  { once: true },
                );
              });
              if (closed.value) return;
              yield { ...peer, session_id: id };
              await completed;
            }
            if (closed.value) return;
            if (message.mitzoMessageId === 'retained-cold-tail')
              await new Promise<void>((resolve) => {
                releaseRetainedTail = resolve;
                request.options.abortController.signal.addEventListener('abort', resolve, {
                  once: true,
                });
              });
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
        setPermissionMode: vi.fn(async () => {
          if (refuseStartup) throw Error('OFFLINE_MODE_REFUSED synthetic-secret');
          if (credentialFailure === 'permission') services.credentialReadFailure = true;
        }),
        stopTask: vi.fn(async () => {}),
      };
      return instance;
    });
    const chat = await import('../../server/chat.js');
    chat.eventStore.upsertSession({
      sessionId: 'information-fixture',
      conversationSource: 'mitzo',
      summary: 'Public information fixture',
    });
    chat.eventStore.append('information-fixture', 'user_message', {
      text: 'Public information fixture',
    });
    const agentTasks = await import('../../server/agent-task-runtime.js');
    cleanups.push(() => agentTasks.closeAgentTasks());
    cleanups.push(async () => {
      const live = chat.registry.findBySessionId(f.reservation.conversationId);
      live?.session.ordinaryRuntimeOwner?.close();
      await vi.waitFor(() =>
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
      );
      chat.setConnectionRegistry(null);
      chat.eventStore.close();
    });
    const transport = { send: vi.fn(), isOpen: () => true };
    // Freeze the request clock while invoking its deadline callback explicitly.
    vi.spyOn(performance, 'now').mockReturnValue(Math.trunc(performance.now()));
    const preparationTimers = vi.spyOn(globalThis, 'setTimeout');
    const { createOwnedLocalCodexEntryRouter } =
      await import('../../server/ordinary-local-codex-entry.js');
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
          query: {},
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
    if (refuseStartup || credentialFailure !== 'none') {
      const sessionId = f.reservation.conversationId;
      await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
      expect(providerInputs).toEqual([]);
      expect(chat.eventStore.hasUserMessage(sessionId, wire.clientMsgId)).toBe(true);
      const events = chat.eventStore.getSessionEvents(sessionId);
      const failures = events.filter((event) => event.type === 'error');
      expect(failures).toHaveLength(1);
      expect(failures[0].payload).toMatchObject({
        clientMsgId: wire.clientMsgId,
        retainedCommandFailure: true,
        runtimeFailure: { runtimeFailureCode: 'input_not_dispatched' },
      });
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          sessionId,
          clientMsgId: wire.clientMsgId,
          error: expect.stringContaining('Message saved.'),
        }),
      );
      expect(events.findIndex((event) => event.type === 'error')).toBeLessThan(
        events.findIndex((event) => event.type === 'session_end'),
      );
      expect(JSON.stringify(events)).not.toContain('synthetic-secret');
      expect(JSON.stringify(transport.send.mock.calls)).not.toContain('synthetic-secret');
      expect(services.requests).toHaveLength(1);
      return;
    }
    // HTTP preparation has finished. A late deadline callback cannot abort the
    // admitted conversation or its subsequent frozen followup.
    const deadline = preparationTimers.mock.calls.find(([, delay]) => delay === 120000)?.[0];
    expect(deadline).toBeTypeOf('function');
    if (typeof deadline === 'function') deadline();
    // The synthetic provider executes real MCP readers before reaching its pause.
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'), { timeout: 10_000 });
    expect(providerInputs[0]).toContain(agentLibrarySource.content);
    expect(providerInputs[0]).toContain(
      'Create or refine a clickable mockup for First SDK dashboard',
    );
    expect(providerInputs[0].split(agentLibrarySource.content)).toHaveLength(2);
    const sdkSession = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
    const { sessionToolOperatorConnection } =
      await import('../../server/native-host-tool-operator.js');
    const { captureAgentLibraryAuthorization } =
      await import('../../server/agent-library-transport.js');
    const viewer = sdkSession.ownerConnectionId;
    sdkSession.ownerConnectionId = 'disconnected-sdk-viewer';
    expect(
      captureAgentLibraryAuthorization(sessionToolOperatorConnection(sdkSession, 'sdk')).auth.id,
    ).toBe(f.auth.id);
    sdkSession.ownerConnectionId = viewer;
    if (idleSuccess) {
      const { getPendingRequestsBySession, resolvePending } = await import('@mitzo/harness');
      const options = services.requests[0].options as Options;
      const questions = [
        {
          question: 'Which checkpoint?',
          header: 'Checkpoint',
          options: [{ label: 'Current', description: 'Keep the active task.' }],
          multiSelect: false,
        },
      ];
      const answer = options.canUseTool!(
        'AskUserQuestion',
        { questions },
        { signal: new AbortController().signal, toolUseID: 'explicit-sdk-question' },
      );
      await vi.waitFor(() =>
        expect(getPendingRequestsBySession(f.reservation.conversationId)).toHaveLength(1),
      );
      const pending = getPendingRequestsBySession(f.reservation.conversationId)[0];
      expect(pending.questions).toMatchObject([{ question: 'Which checkpoint?' }]);
      expect(
        resolvePending(
          pending.permId,
          'once',
          { 'Which checkpoint?': ['Current'] },
          f.reservation.conversationId,
        ),
      ).toBe(true);
      await expect(answer).resolves.toMatchObject({
        behavior: 'allow',
        updatedInput: { answers: { 'Which checkpoint?': 'Current' } },
      });
      await expect(
        options.canUseTool!(
          'Bash',
          { command: 'true' },
          { signal: new AbortController().signal, toolUseID: 'unselected-shell' },
        ),
      ).resolves.toMatchObject({ behavior: 'deny' });
    }
    if (personal && repositoryProfile === 'default') {
      const sdkOptions = services.requests[0].options as Options;
      expect(sdkOptions.sandbox).toBeUndefined();
      for (const tool of ['Grep', 'Glob']) {
        await expect(
          sdkOptions.canUseTool!(
            tool,
            { path: sdkOptions.env!.CLAUDE_CONFIG_DIR, pattern: '*' },
            {
              signal: new AbortController().signal,
              toolUseID: `private-search-${tool}`,
            },
          ),
        ).resolves.toMatchObject({
          behavior: 'deny',
          message: expect.stringContaining('private account files'),
        });
        await expect(
          sdkOptions.canUseTool!(
            tool,
            { path: sdkOptions.cwd, pattern: 'fixture' },
            {
              signal: new AbortController().signal,
              toolUseID: `workspace-search-${tool}`,
            },
          ),
        ).resolves.toMatchObject({ behavior: 'allow' });
      }
    }
    const publicUser = chat.eventStore
      .getSessionEvents(f.reservation.conversationId)
      .find((event) => event.type === 'user_message');
    expect(publicUser?.payload).toMatchObject({
      text: f.request.payload.text,
      sourceSnapshots: [agentLibrarySource],
    });
    const { OrdinaryLocalCodexSelectionOwner } =
      await import('../../server/ordinary-local-codex-selection-owner.js');
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
        if (expected.selection.model === nextModel) {
          admissionWaiting = true;
          await pendingAuthority;
        }
        return assertSelection.call(this, expected);
      });
    const expired = invoke('/continue', {
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: 'expired-followup',
      selection: { ...wire.selection, model: nextModel, thinking: nextThinking },
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
        selection: { ...wire.selection, model: nextModel, thinking: nextThinking },
        payload: { text: '/mockup Frozen followup' },
      }),
    ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
    expect(services.requests).toHaveLength(1);
    expect(services.requests[0].options.effort).toBe(managed ? undefined : 'low');
    // The actual chat-installed adapter inserts into this busy SDK query. Its
    // replay ACK must neither settle the original nor recreate the queued query.
    const { agentMessageRuntime } = await import('../../server/agent-message-runtime.js');
    chat.eventStore.upsertSession({ sessionId: 'offline-peer-sender' });
    const peer = chat.eventStore.agentCommunication.reserve(
      'offline-peer-sender',
      f.auth.id,
      { turnId: 'sender-turn', callId: 'peer-call' },
      {
        requestId: randomUUID(),
        recipientConversationId: f.reservation.conversationId,
        text: 'Preserve the original task and account for this correction.',
      },
    );
    chat.eventStore.agentCommunication.claim(peer.messageId);
    const peerCard = (direction: string, messageId: string, status?: string) =>
      expect.objectContaining({
        type: 'agent_message',
        sessionId: f.reservation.conversationId,
        projection: expect.objectContaining({
          direction,
          message: expect.objectContaining({ messageId, ...(status ? { status } : {}) }),
        }),
      });
    await vi.waitFor(() =>
      expect(transport.send).toHaveBeenCalledWith(peerCard('incoming', peer.messageId)),
    );
    const runtime = agentMessageRuntime(sdkSession, f.auth.id)!;
    expect(runtime.state()).toBe('busy');
    expect(await runtime.steer(peer, () => {}, sdkSession.abortController.signal)).toBe(
      'uncertain',
    );
    expect(await consumePeer!()).toMatchObject({ uuid: peer.messageId, priority: 'now' });
    await vi.waitFor(() =>
      expect(
        chat.eventStore.agentCommunication.read('offline-peer-sender', peer.messageId).status,
      ).toBe('delivered'),
    );
    expect(transport.send).toHaveBeenCalledWith(peerCard('incoming', peer.messageId, 'delivered'));
    const outgoingPeer = chat.eventStore.agentCommunication.reserve(
      f.reservation.conversationId,
      f.auth.id,
      { turnId: 'recipient-turn', callId: 'outgoing-peer-call' },
      {
        requestId: randomUUID(),
        recipientConversationId: 'offline-peer-sender',
        text: 'Retain the outgoing card in this SDK conversation too.',
      },
    );
    await vi.waitFor(() =>
      expect(transport.send).toHaveBeenCalledWith(peerCard('outgoing', outgoingPeer.messageId)),
    );
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const connections = new ConnectionRegistry();
    cleanups.push(() => connections.dispose());
    const firstTab = { isOpen: () => true, send: vi.fn() };
    const reconnectedTab = { isOpen: () => true, send: vi.fn() };
    connections.register('first-peer-tab', firstTab);
    connections.watch('first-peer-tab', f.reservation.conversationId);
    chat.setConnectionRegistry(connections);
    chat.eventStore.agentCommunication.claim(outgoingPeer.messageId);
    await vi.waitFor(() =>
      expect(firstTab.send).toHaveBeenCalledWith(
        peerCard('outgoing', outgoingPeer.messageId, 'uncertain'),
      ),
    );
    connections.remove('first-peer-tab');
    connections.register('reconnected-peer-tab', reconnectedTab);
    connections.watch('reconnected-peer-tab', f.reservation.conversationId);
    expect(sdkSession.observers.size).toBe(0);
    expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
      'RUNNING',
    );
    expect(
      chat.eventStore.getExecutionAdmission(f.reservation.conversationId, 'queued'),
    ).toBeUndefined();
    expect(history).toEqual([f.request.clientMsgId]);
    expect(services.requests).toHaveLength(1);
    expect(services.requests[0].options.allowedTools).toContain(
      'mcp__mitzo-web-access__RequestWebAccess',
    );
    expect(services.requests[0].options.disallowedTools).not.toContain('mcp__mitzo-web-access__*');
    const inspectConnections = async (options: Options, execute = false) => {
      const server = options.mcpServers!['mitzo-connections'] as McpSdkServerConfigWithInstance;
      const client = new Client({ name: 'owned-claude-connections', version: '1' });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names.includes('ListConnections')).toBe(!idleSuccess);
        for (const name of [
          'RequestConnectionAccess',
          'ConnectionRequest',
          'PrepareConnectionSetup',
        ])
          expect(names.includes(name)).toBe(!idleSuccess);
        if (execute) {
          const decision = await options.canUseTool!(
            'mcp__mitzo-connections__ListConnections',
            {},
            { signal: new AbortController().signal, toolUseID: 'connection-discovery' },
          );
          expect(decision.behavior).toBe(idleSuccess ? 'deny' : 'allow');
          if (!idleSuccess)
            expect(await client.callTool({ name: 'ListConnections', arguments: {} })).toMatchObject(
              { isError: false },
            );
          expect(
            await options.canUseTool!(
              'mcp__mitzo-connections__ConnectionRequest',
              { connectionId: 'forged', method: 'GET', path: '/api/' },
              { signal: new AbortController().signal, toolUseID: 'unavailable-connection-request' },
            ),
          ).toMatchObject({ behavior: idleSuccess ? 'deny' : 'allow' });
          if (!idleSuccess)
            expect(
              await client.callTool({
                name: 'ConnectionRequest',
                arguments: { connectionId: 'forged', method: 'GET', path: '/api/' },
              }),
            ).toMatchObject({ isError: true });
        }
      } finally {
        await client.close();
        await server.instance.close();
      }
    };
    await inspectConnections(services.requests[0].options as Options, true);
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
    await vi.waitFor(() => expect(history).toEqual([f.request.clientMsgId, 'queued']), {
      timeout: 5000,
    });
    expect(providerInputs[1]).toContain('Create or refine a clickable mockup for Frozen followup');
    expect(chat.eventStore.getSendCommand('queued')?.payload.text).toBe('/mockup Frozen followup');
    await vi.waitFor(
      () =>
        expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
          'TERMINAL',
        ),
      { timeout: 10_000 },
    );
    expect(services.requests[1].options).toMatchObject({
      resume: f.reservation.conversationId,
      model: nextModel,
      ...(managed ? {} : { effort: 'high' }),
      env: personal
        ? {
            CLAUDE_CONFIG_DIR: f.configuration[0].credentialRef,
            MITZO_CLAUDE_EXPECTED_EMAIL: 'person@example.test',
          }
        : anthropicApi
          ? { MITZO_ANTHROPIC_API_CUSTODY: expect.any(String) }
          : { ANTHROPIC_VERTEX_PROJECT_ID: 'offline-project', CLOUD_ML_REGION: 'offline-region' },
    });
    expect(services.requests[1].options).not.toHaveProperty('sessionId');
    chat.eventStore.agentCommunication.recordForHost(outgoingPeer.messageId, 'delivered');
    await vi.waitFor(() =>
      expect(reconnectedTab.send).toHaveBeenCalledWith(
        peerCard('outgoing', outgoingPeer.messageId, 'delivered'),
      ),
    );
    connections.remove('reconnected-peer-tab');
    expect(
      chat.eventStore.agentCommunication.read('offline-peer-sender', peer.messageId).status,
    ).toBe('delivered');
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
    const afterStopPeer = chat.eventStore.agentCommunication.reserve(
      f.reservation.conversationId,
      f.auth.id,
      { turnId: 'closed-recipient-turn', callId: 'closed-peer-call' },
      {
        requestId: randomUUID(),
        recipientConversationId: 'offline-peer-sender',
        text: 'Retained after the original owner stopped.',
      },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(transport.send).not.toHaveBeenCalledWith(peerCard('outgoing', afterStopPeer.messageId));
    await expect(
      invoke('/continue', {
        ...wire,
        sessionId: f.reservation.conversationId,
        clientMsgId: 'cold',
        payload: { text: '/mockup Same retained task' },
      }),
    ).resolves.toMatchObject({ status: 202, body: { dispatched: true, state: 'consumed' } });
    // Cold recovery first runs the acknowledged predecessor, including its
    // real MCP/permission callbacks. Wait for that startup separately, then
    // prove the new input cannot overtake its still-unsettled result.
    await vi.waitFor(() => expect(releaseRetainedTail).toBeTypeOf('function'), {
      timeout: 10_000,
    });
    expect(history).toEqual([f.request.clientMsgId, 'queued', 'retained-cold-tail']);
    expect(
      chat.eventStore.getExecutionAdmission(f.reservation.conversationId, 'cold'),
    ).toBeUndefined();
    expect(chat.eventStore.getOrdinarySdkTurnEvents(f.reservation.conversationId, 'cold')).toEqual(
      [],
    );
    releaseRetainedTail!();
    await vi.waitFor(
      () =>
        expect(history).toEqual([f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold']),
      { timeout: 5000 },
    );
    expect(providerInputs[3]).toContain(
      'Create or refine a clickable mockup for Same retained task',
    );
    expect(services.requests[2].options).toMatchObject({
      resume: f.reservation.conversationId,
      model: nextModel,
      ...(managed ? {} : { effort: 'high' }),
    });
    expect(services.requests[3].options).toMatchObject({
      resume: f.reservation.conversationId,
      model: f.request.selection.model,
      ...(managed ? {} : { effort: 'low' }),
    });
    // The actual owner recreates its MCP surface for queued and cold queries.
    // Their terminal callbacks are retired; inspect exposure without re-executing them.
    await vi.waitFor(
      () =>
        expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
          'TERMINAL',
        ),
      { timeout: 10_000 },
    );
    await vi.waitFor(() =>
      expect(approvedInputs).toEqual(
        idleSuccess ? [] : [f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold'],
      ),
    );
    for (const request of services.requests.slice(1))
      await inspectConnections(request.options as Options);
    if (repositoryTransfer)
      expect(transferCalls).toEqual([
        f.request.clientMsgId,
        'queued',
        'retained-cold-tail',
        'cold',
      ]);
    if (!idleSuccess)
      expect(informationCalls).toEqual(
        expect.arrayContaining([f.request.clientMsgId, 'queued', 'retained-cold-tail', 'cold']),
      );
    await vi.waitFor(() =>
      expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
        'TERMINAL',
      ),
    );
    expect(chat.eventStore.getOrdinaryLocalVertexCustody(f.reservation.conversationId)).toEqual(
      custody,
    );
    const prompts = await import('../../server/session-prompt-runtime.js');
    prompts.initializeSessionPrompts(':memory:', {
      eventStore: chat.eventStore,
      sessionRegistry: chat.registry,
      connRegistry: { broadcast() {} } as never,
    });
    cleanups.push(() => prompts.closeSessionPrompts());
    const idleSession = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
    const idleRuntime = agentMessageRuntime(idleSession, f.auth.id)!;
    const idlePeer = chat.eventStore.agentCommunication.reserve(
      'offline-peer-sender',
      f.auth.id,
      { turnId: 'idle-sender-turn', callId: 'idle-peer-call' },
      {
        requestId: randomUUID(),
        recipientConversationId: f.reservation.conversationId,
        text: 'Never submit after sender revocation.',
      },
    );
    chat.eventStore.agentCommunication.claim(idlePeer.messageId);
    let peerAllowed = true;
    const guard = () => {
      if (!peerAllowed) throw Error('Idle sender revoked');
    };
    const beforeIdleHistory = [...history];
    const beforeIdleProviderInputs = [...providerInputs];
    const beforeIdleQueries = services.requests.length;
    if (idleSuccess) {
      await expect(
        idleRuntime.enqueue!(idlePeer, guard, idleSession.abortController.signal, f.auth),
      ).resolves.toBe('queued');
      await vi.waitFor(() =>
        expect(
          chat.eventStore.agentCommunication.read('offline-peer-sender', idlePeer.messageId),
        ).toMatchObject({ status: 'delivered' }),
      );
      expect(history).toHaveLength(beforeIdleHistory.length + 1);
      expect(services.requests).toHaveLength(beforeIdleQueries + 1);
      await vi.waitFor(() =>
        expect(chat.eventStore.getSession(f.reservation.conversationId)?.executionPhase).toBe(
          'TERMINAL',
        ),
      );
      return;
    }
    if (stdinRevocation) {
      let releaseIdleInput!: () => void;
      idleInputReady = new Promise<void>((resolve) => {
        releaseIdleInput = resolve;
      });
      cleanups.push(() => releaseIdleInput());
      const { SdkAgentMessageRuntime } = await import('../../server/sdk-agent-message-runtime.js');
      const before = SdkAgentMessageRuntime.prototype.beforeInput;
      vi.spyOn(SdkAgentMessageRuntime.prototype, 'beforeInput').mockImplementation(
        function (input, available) {
          if ((input as { mitzoMessageId?: string }).mitzoMessageId === idlePeer.commandId)
            peerAllowed = false;
          return before.call(this, input, available);
        },
      );
      // Hold the synthetic provider before its first next(): this case targets
      // revocation after admission and immediately before stdin submission.
      // Earlier asynchronous-admission revocation is exercised separately below.
      await expect(
        idleRuntime.enqueue!(idlePeer, guard, idleSession.abortController.signal, f.auth),
      ).resolves.toBe('queued');
      expect(peerAllowed).toBe(true);
      expect(history).toEqual(beforeIdleHistory);
      expect(providerInputs).toEqual(beforeIdleProviderInputs);
      releaseIdleInput();
      await vi.waitFor(() =>
        expect(
          chat.eventStore.agentCommunication.read('offline-peer-sender', idlePeer.messageId),
        ).toMatchObject({ status: 'failed', reason: 'before_provider_submission' }),
      );
      expect(history).toEqual(beforeIdleHistory);
      expect(providerInputs).toEqual(beforeIdleProviderInputs);
      expect(services.requests).toHaveLength(beforeIdleQueries + 1);
      return;
    }
    const idleSelection = vi
      .spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent')
      .mockImplementation(async function (expected) {
        await assertSelection.call(this, expected);
        peerAllowed = false;
      });
    await expect(
      idleRuntime.enqueue!(idlePeer, guard, idleSession.abortController.signal, f.auth),
    ).rejects.toThrow('authority_unavailable');
    idleSelection.mockRestore();
    expect(chat.eventStore.getSendCommand(idlePeer.commandId)).toBeUndefined();
    expect(history).toEqual(beforeIdleHistory);
    expect(services.requests).toHaveLength(beforeIdleQueries);
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
        selection: { ...wire.selection, model: nextModel, thinking: nextThinking },
        payload: { text: 'Retain this queued work' },
      }),
    ).resolves.toMatchObject({ status: 202 });
    const stoppedQueryCount = services.requests.length;
    // Abrupt runtime loss still cannot manufacture a settled SDK result.
    chat.stopChat(chat.registry.findBySessionId(f.reservation.conversationId)!.clientId);
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
    expect(
      chat.eventStore.getOrdinaryLocalVertexCommandAdmission('saved-after-stop'),
    ).toMatchObject({
      state: 'consumed',
      selection: { model: nextModel, thinking: nextThinking },
    });

    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/health'))).toBe(
      true,
    );
  },
  // This journey starts five SDK commands and exercises four real MCP
  // surfaces. Hosted runs spend about five seconds in each information turn;
  // retain the individual phase deadlines and budget their combined journey.
  60_000,
);

it.each([
  { personal: false, preInput: false, settling: false, cold: false },
  { personal: true, preInput: false, settling: false, cold: false },
  { personal: true, preInput: true, settling: false, cold: false },
  { personal: true, preInput: true, settling: false, cold: true },
  { personal: false, preInput: false, settling: true, cold: false },
  { personal: true, preInput: false, settling: true, cold: false },
])(
  'public Stop, reconnect and Continue retain the SDK development owner (personal=$personal preInput=$preInput settling=$settling cold=$cold)',
  async ({ personal, preInput, settling, cold }) => {
    vi.resetModules();
    const { ownedVertexRuntimeFixture } =
      await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true, personal });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    services.auth = f.auth;
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('No live provider in this fixture');
      }),
    );
    if (personal) {
      const { ClaudeSubscriptionCustody } =
        await import('../../server/claude-subscription-custody.js');
      const capture = ClaudeSubscriptionCustody.capture;
      vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
        capture(env, f.personalExecutable),
      );
      vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    }
    const history: string[] = [];
    let acknowledgeColdInput!: () => void;
    const coldInputObserved = new Promise<void>((resolve) => {
      acknowledgeColdInput = resolve;
    });
    let holdNext = true;
    let finish: (() => void) | undefined;
    let releaseAccount!: () => void;
    const accountPending = new Promise<void>((resolve) => {
      releaseAccount = resolve;
    });
    const accountInfo = vi.fn(async () => {
      if (preInput) await accountPending;
      return { email: 'person@example.test', subscriptionType: 'max', apiProvider: 'firstParty' };
    });
    const interrupt = vi.fn(async () => {});
    services.query.mockImplementation((request) => {
      services.requests.push(request);
      let closed = false;
      const process = request.options.spawnClaudeCodeProcess({
        signal: request.options.abortController.signal,
      });
      return {
        accountInfo,
        async *[Symbol.asyncIterator]() {
          for await (const input of request.prompt) {
            if (closed) return;
            history.push(input.mitzoMessageId);
            if (input.mitzoMessageId === 'cold-before-first-input') acknowledgeColdInput();
            yield {
              type: 'user',
              uuid: `input-${input.mitzoMessageId}`,
              parent_tool_use_id: null,
              message: input.message,
            };
            if (holdNext)
              await new Promise<void>((resolve) => {
                holdNext = false;
                finish = resolve;
                request.options.abortController.signal.addEventListener('abort', resolve, {
                  once: true,
                });
              });
            if (closed) return;
            yield {
              type: 'result',
              session_id: request.options.resume ?? request.options.sessionId,
              is_error: false,
            };
          }
        },
        interrupt,
        close: () => {
          closed = true;
          process.emit('close', 0, null);
        },
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
      };
    });
    const chat = await import('../../server/chat.js');
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const connections = new ConnectionRegistry();
    const connectionId = f.dependencies.operatorConnectionId;
    const transport = { isOpen: () => true, send: vi.fn() };
    connections.register(connectionId, transport);
    chat.setConnectionRegistry(connections);
    cleanups.push(async () => {
      chat.registry
        .findBySessionId(f.reservation.conversationId)
        ?.session.ordinaryRuntimeOwner?.close();
      await vi.waitFor(() =>
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
      );
      chat.setConnectionRegistry(null);
      connections.dispose();
      chat.eventStore.close();
    });
    const { app } = await import('../../server/app.js');
    const { createOwnedLocalCodexEntryRouter } =
      await import('../../server/ordinary-local-codex-entry.js');
    const { createChatRestRouter } = await import('../../server/chat-rest-handler.js');
    const ctx = {
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      connRegistry: connections,
    } as import('../../server/ws-handler-v2.js').V2HandlerContext;
    const sse = { has: () => true, isOpen: () => true, isOwnedBy: () => true } as never;
    app.use('/api/fixture/runtime', createOwnedLocalCodexEntryRouter(sse, ctx, true));
    app.use('/api/fixture/chat', createChatRestRouter(sse, ctx));
    const request = (await import('supertest')).default;
    const post = (path: string, body: unknown) =>
      request(app)
        .post(path.startsWith('/fixture') ? `/api${path}` : path)
        .set('X-Connection-ID', connectionId)
        .send(
          path.startsWith('/fixture/runtime')
            ? { runOn: 'local', repositoryWorkspaceId: f.reservation.id, ...(body as object) }
            : (body as object),
        );
    const id = f.reservation.conversationId;
    const started = await post('/fixture/runtime/send', f.request);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await vi.waitFor(() =>
      preInput ? expect(accountInfo).toHaveBeenCalledOnce() : expect(finish).toBeTypeOf('function'),
    );
    const retained = chat.registry.findBySessionId(id)!;
    const original = chat.eventStore.getSession(id)!;
    expect(
      (
        await post('/fixture/runtime/continue', {
          ...f.request,
          sessionId: id,
          clientMsgId: 'queued-development',
          payload: { text: 'Run tests and commit in this checkout' },
        })
      ).status,
    ).toBe(202);
    if (settling) {
      const { TurnCallbacks } = await import('../../server/turn-callbacks.js');
      const seal = TurnCallbacks.prototype.seal;
      let settlementStarted = false;
      vi.spyOn(TurnCallbacks.prototype, 'seal').mockImplementationOnce(function (
        this: InstanceType<typeof TurnCallbacks>,
      ) {
        // A synthetic pending operation uses the real callback settlement owner.
        void this.track(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
              settlementStarted = true;
            }),
        );
        seal.call(this);
      });
      finish!();
      await vi.waitFor(() => expect(settlementStarted).toBe(true));
    }
    expect((await post('/fixture/chat/stop', { type: 'stop', sessionId: id })).status).toBe(200);
    if (!preInput && !settling) await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    else expect(interrupt).not.toHaveBeenCalled();
    expect(chat.registry.findBySessionId(id)?.session).toBe(retained.session);
    expect(chat.eventStore.getSession(id)?.executionPhase).toBe('STOPPING');
    // An interrupt acknowledgment is not terminal proof. Continue cannot release the tail yet.
    expect((await post(`/api/sessions/${id}/codex-queue/continue`, {})).status).toBe(409);
    const initialHistory = preInput ? [] : [f.request.clientMsgId];
    expect(history).toEqual(initialHistory);
    if (preInput) {
      holdNext = false;
      releaseAccount();
    } else finish!();
    await vi.waitFor(() =>
      expect(chat.eventStore.getSession(id)).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'stopped',
      }),
    );
    expect(history).toEqual(initialHistory);
    if (preInput && cold) {
      const { readClaudeAccountHistory } = await import('../../server/claude-account-history.js');
      const previousHistory = vi.mocked(readClaudeAccountHistory).getMockImplementation()!;
      cleanups.push(() => {
        vi.mocked(readClaudeAccountHistory).mockImplementation(previousHistory);
      });
      const actualHistory = await vi.importActual<
        typeof import('../../server/claude-account-history.js')
      >('../../server/claude-account-history.js');
      vi.mocked(readClaudeAccountHistory).mockImplementation(async (sessionId, cwd, config) =>
        history.length
          ? ({ info: { sessionId, cwd }, messages: [{ type: 'user', uuid: 'retained' }] } as never)
          : actualHistory.readClaudeAccountHistory(sessionId, cwd, config),
      );
      retained.session.ordinaryRuntimeOwner!.close();
      await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
      const recovered = await post('/fixture/runtime/continue', {
        ...f.request,
        sessionId: id,
        clientMsgId: 'cold-before-first-input',
        payload: { text: 'Continue the same checkout after first-input cancellation' },
      });
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(202);
      await coldInputObserved;
      expect(history).toEqual(['queued-development', 'cold-before-first-input']);
      await vi.waitFor(() =>
        expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'),
      );
      expect(services.requests[1].options).toMatchObject({ sessionId: id, cwd: original.cwd });
      expect(services.requests[1].options.resume).toBeUndefined();
      expect(chat.eventStore.getSession(id)).toMatchObject({
        cwd: original.cwd,
        accountBinding: original.accountBinding,
      });
      // Once a provider input ran, an absent transcript must never create a replacement history.
      vi.mocked(readClaudeAccountHistory).mockImplementation(
        actualHistory.readClaudeAccountHistory,
      );
      chat.registry.findBySessionId(id)!.session.ordinaryRuntimeOwner!.close();
      await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
      const count = services.requests.length;
      expect(
        (
          await post('/fixture/runtime/continue', {
            ...f.request,
            sessionId: id,
            clientMsgId: 'missing-used-history',
            payload: { text: 'Must not invent the missing provider history' },
          })
        ).status,
      ).toBe(409);
      expect(services.requests).toHaveLength(count);
      return;
    }
    chat.detachChat(retained.clientId);
    const reconnect = { isOpen: () => true, send: vi.fn() };
    expect(chat.reattachChat(retained.clientId, reconnect)).toBe(true);
    const metadata = await request(app).get(`/api/sessions/${id}/meta`);
    expect(metadata.status, JSON.stringify(metadata.body)).toBe(200);
    expect(metadata.body.codexQueue).toMatchObject({
      paused: true,
      connected: true,
      queued: 1,
      canContinue: true,
    });
    services.auth = { ...f.auth, id: 'foreign-login' };
    expect((await post(`/api/sessions/${id}/codex-queue/continue`, {})).status).toBe(403);
    services.auth = f.auth;
    // Match CodexQueueStatus: signed continuation is selected by the actual metadata.
    const continuation = request(app).post(`/api/sessions/${id}/codex-queue/continue`);
    if (metadata.body.codexQueue?.canContinue === true)
      continuation.set('X-Connection-ID', connectionId);
    expect((await continuation.send({})).status).toBe(200);
    await vi.waitFor(() => expect(history).toEqual([...initialHistory, 'queued-development']));
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    expect(chat.eventStore.getSession(id)).toMatchObject({
      cwd: original.cwd,
      accountBinding: original.accountBinding,
      repositoryWorkspaceId: original.repositoryWorkspaceId,
    });
    expect(services.requests[1].options).toMatchObject({
      cwd: original.cwd,
      ...(preInput ? { sessionId: id } : { resume: id }),
    });
    expect(
      (
        await post('/fixture/runtime/continue', {
          ...f.request,
          sessionId: id,
          clientMsgId: 'publication-followup',
          payload: { text: 'Read CI and keep fixing' },
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() =>
      expect(history).toEqual([...initialHistory, 'queued-development', 'publication-followup']),
    );
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    // A rejected SDK interrupt keeps the original activity and a sanitized diagnostic.
    holdNext = true;
    finish = undefined;
    expect(
      (
        await post('/fixture/runtime/continue', {
          ...f.request,
          sessionId: id,
          clientMsgId: 'failed-interrupt',
          payload: { text: 'Keep uncertain work visible' },
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    interrupt.mockRejectedValueOnce(Error('synthetic-private-provider-failure'));
    expect((await post('/fixture/chat/stop', { type: 'stop', sessionId: id })).status).toBe(200);
    await vi.waitFor(() =>
      expect(chat.eventStore.getLatestEvent(id, 'error')?.payload).toMatchObject({
        runtimeFailure: { runtimeFailureCode: 'unsettled_effects' },
      }),
    );
    expect(JSON.stringify(chat.eventStore.getLatestEvent(id, 'error')?.payload)).not.toContain(
      'synthetic-private-provider-failure',
    );
    expect(chat.registry.findBySessionId(id)?.session).toBe(retained.session);
    expect((await post('/fixture/chat/stop', { type: 'stop', sessionId: id })).status).toBe(200);
    expect(interrupt).toHaveBeenCalledTimes(preInput || settling ? 1 : 2);
    expect((await post(`/api/sessions/${id}/codex-queue/continue`, {})).status).toBe(409);
    finish!();
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
  },
  30000,
);

it.each([
  { personal: false, cold: false, uncertain: false },
  { personal: true, cold: true, uncertain: false },
  { personal: false, cold: false, uncertain: true },
])(
  'public failed-turn Retry preserves source intent and FIFO (personal=$personal cold=$cold uncertain=$uncertain)',
  async ({ personal, cold, uncertain }) => {
    vi.resetModules();
    const { ownedVertexRuntimeFixture } =
      await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true, personal });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    services.auth = f.auth;
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('No live provider in Retry fixture');
      }),
    );
    if (personal) {
      const { ClaudeSubscriptionCustody } =
        await import('../../server/claude-subscription-custody.js');
      const capture = ClaudeSubscriptionCustody.capture;
      vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
        capture(env, f.personalExecutable),
      );
      vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    }
    const history: string[] = [];
    let finishSource: (() => void) | undefined, finishRetry: (() => void) | undefined;
    const tails = new Map(
      ['retry-tail-b', 'retry-tail-c'].map((id) => {
        let observe!: () => void, finish!: () => void;
        const observed = new Promise<void>((resolve) => {
          observe = resolve;
        });
        const released = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return [id, { observe, finish, observed, released }] as const;
      }),
    );
    let accountWait: Promise<void> | undefined;
    let accountWaiting = false;
    services.query.mockImplementation((request) => {
      services.requests.push(request);
      let closed = false;
      const process = request.options.spawnClaudeCodeProcess({
        signal: request.options.abortController.signal,
      });
      return {
        accountInfo: async () => {
          if (accountWait) {
            accountWaiting = true;
            await accountWait;
          }
          return {
            email: 'person@example.test',
            subscriptionType: 'max',
            apiProvider: 'firstParty',
          };
        },
        async *[Symbol.asyncIterator]() {
          for await (const input of request.prompt) {
            if (closed) return;
            const commandId = String(input.mitzoMessageId);
            history.push(commandId);
            yield {
              type: 'user',
              uuid: `input-${commandId}`,
              parent_tool_use_id: null,
              message: input.message,
            };
            if (commandId === f.request.clientMsgId) {
              await new Promise<void>((resolve) => {
                finishSource = resolve;
              });
              if (uncertain) throw Error('Synthetic lost result; effects remain unknown');
            } else if (commandId.startsWith('sdk-retry:'))
              await new Promise<void>((resolve) => {
                finishRetry = resolve;
              });
            else if (tails.has(commandId)) {
              const tail = tails.get(commandId)!;
              tail.observe();
              await tail.released;
            }
            if (closed) return;
            yield {
              type: 'result',
              session_id: request.options.resume ?? request.options.sessionId,
              is_error: commandId === f.request.clientMsgId,
            };
          }
        },
        close: () => {
          closed = true;
          process.emit('close', 0, null);
        },
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
      };
    });
    const chat = await import('../../server/chat.js');
    const { ConnectionRegistry } = await import('@mitzo/harness');
    const connections = new ConnectionRegistry();
    const connectionId = f.dependencies.operatorConnectionId;
    connections.register(connectionId, { isOpen: () => true, send: vi.fn() });
    chat.setConnectionRegistry(connections);
    cleanups.push(async () => {
      finishSource?.();
      finishRetry?.();
      for (const tail of tails.values()) tail.finish();
      chat.registry
        .findBySessionId(f.reservation.conversationId)
        ?.session.ordinaryRuntimeOwner?.close();
      await vi.waitFor(() =>
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
      );
      chat.setConnectionRegistry(null);
      connections.dispose();
      chat.eventStore.close();
    });
    const { app } = await import('../../server/app.js');
    const { createOwnedLocalCodexEntryRouter } =
      await import('../../server/ordinary-local-codex-entry.js');
    const ctx = {
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      connRegistry: connections,
    } as import('../../server/ws-handler-v2.js').V2HandlerContext;
    const sse = { has: () => true, isOpen: () => true, isOwnedBy: () => true } as never;
    app.use('/api/fixture/retry-runtime', createOwnedLocalCodexEntryRouter(sse, ctx, true));
    const { createChatRestRouter } = await import('../../server/chat-rest-handler.js');
    app.use('/api/fixture/retry-chat', createChatRestRouter(sse, ctx));
    const request = (await import('supertest')).default;
    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.closeAllConnections();
          httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const post = (path: string, body: object) =>
      request(httpServer)
        .post(path)
        .set('Connection', 'close')
        .set('X-Connection-ID', connectionId)
        .send(body);
    const id = f.reservation.conversationId;
    const source = {
      ...f.request,
      payload: {
        text: '/retry-fixture original task',
        intent: 'Original authorized task',
        images: [
          {
            mediaType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfoAAAAASUVORK5CYII=',
          },
        ],
      },
    };
    const wire = { runOn: 'local', repositoryWorkspaceId: f.reservation.id };
    const started = await post('/api/fixture/retry-runtime/send', { ...source, ...wire });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await vi.waitFor(() => expect(finishSource).toBeTypeOf('function'));
    const original = chat.eventStore.getSession(id)!;
    for (const commandId of ['retry-tail-b', 'retry-tail-c']) {
      const queued = await post('/api/fixture/retry-runtime/continue', {
        ...f.request,
        ...wire,
        sessionId: id,
        clientMsgId: commandId,
        payload: { text: commandId },
        selection: { ...f.request.selection, model: 'next-model', thinking: 'high' },
      });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    }
    const retryPath = `/api/sessions/${id}/codex-queue/retry`;
    expect(
      (await post(retryPath, { sourceCommandId: source.clientMsgId, confirmAmbiguous: true }))
        .status,
    ).toBe(409);
    finishSource!();
    if (uncertain) {
      await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
      expect(
        (await post(retryPath, { sourceCommandId: source.clientMsgId, confirmAmbiguous: true }))
          .status,
      ).toBe(409);
      expect(history).toEqual([source.clientMsgId]);
      expect(
        chat.eventStore.getOrdinarySdkTurnEvents(id, source.clientMsgId).map((event) => event.type),
      ).toEqual(['ordinary_sdk_turn_accepted']);
      expect(chat.eventStore.getPendingOrdinaryLocalVertexCommandIds(id)).toEqual([
        'retry-tail-b',
        'retry-tail-c',
      ]);
      return;
    }
    await vi.waitFor(() =>
      expect(chat.eventStore.getSession(id)?.executionTerminalReason).toBe('failed'),
    );
    const originalReceipt = chat.eventStore.getSendCommand(source.clientMsgId);
    const originalAdmission = chat.eventStore.getOrdinaryLocalVertexCommandAdmission(
      source.clientMsgId,
    );
    const originalSkill = chat.eventStore.getOrdinarySkillContext(id, source.clientMsgId);
    expect(history).toEqual([source.clientMsgId]);
    expect((await post(retryPath, {})).status).toBe(409);
    expect((await post(retryPath, { sourceCommandId: source.clientMsgId })).body.error).toMatch(
      /confirm/i,
    );
    const staleRetry = await post(retryPath, {
      sourceCommandId: 'stale-source',
      confirmAmbiguous: true,
    });
    expect(staleRetry.status, JSON.stringify(staleRetry.body)).toBe(409);
    services.auth = { ...f.auth, id: 'foreign-login' };
    expect(
      (await post(retryPath, { sourceCommandId: source.clientMsgId, confirmAmbiguous: true }))
        .status,
    ).toBe(403);
    services.auth = f.auth;
    if (cold) {
      chat.registry.findBySessionId(id)!.session.ordinaryRuntimeOwner!.close();
      await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
    }
    const metadata = await request(httpServer)
      .get(`/api/sessions/${id}/meta`)
      .set('Connection', 'close');
    expect(metadata.body.codexQueue).toMatchObject({
      paused: true,
      connected: !cold,
      canContinue: !cold,
      failed: 1,
      queued: 2,
      retryable: true,
      retrySourceCommandId: source.clientMsgId,
      requiresRetryConfirmation: true,
    });
    const retried = await post(retryPath, {
      sourceCommandId: source.clientMsgId,
      confirmAmbiguous: true,
    });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await vi.waitFor(() => expect(finishRetry).toBeTypeOf('function'));
    const { ordinarySdkRetryCommandId } =
      await import('../../server/ordinary-local-vertex-queue.js');
    const childId = ordinarySdkRetryCommandId(source.clientMsgId);
    expect(history).toEqual([source.clientMsgId, childId]);
    expect(chat.eventStore.getSendCommand(childId)?.payload).toEqual(originalReceipt?.payload);
    expect(chat.eventStore.getOrdinaryLocalVertexCommandAdmission(childId)?.selection).toEqual(
      originalAdmission?.selection,
    );
    expect(chat.eventStore.getOrdinarySkillContext(id, childId)).toEqual(originalSkill);
    expect(chat.eventStore.getSendCommand(source.clientMsgId)).toEqual(originalReceipt);
    const requestCount = services.requests.length;
    expect(
      (await post(retryPath, { sourceCommandId: source.clientMsgId, confirmAmbiguous: true }))
        .status,
    ).toBe(200);
    expect(services.requests).toHaveLength(requestCount);
    finishRetry!();
    // Observe each actual input and release its result explicitly. Two complete
    // authority/history reopens do not share one polling assertion's deadline.
    await tails.get('retry-tail-b')!.observed;
    expect(history).toEqual([source.clientMsgId, childId, 'retry-tail-b']);
    expect(chat.eventStore.getCurrentExecutionCommandId(id)).toBe('retry-tail-b');
    expect(chat.eventStore.getPendingOrdinaryLocalVertexCommandIds(id)).toEqual(['retry-tail-c']);
    tails.get('retry-tail-b')!.finish();
    await tails.get('retry-tail-c')!.observed;
    expect(history).toEqual([source.clientMsgId, childId, 'retry-tail-b', 'retry-tail-c']);
    tails.get('retry-tail-c')!.finish();
    await vi.waitFor(() => expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'));
    expect(chat.eventStore.getSession(id)).toMatchObject({
      cwd: original.cwd,
      accountBinding: original.accountBinding,
      repositoryWorkspaceId: original.repositoryWorkspaceId,
    });
    expect(services.requests[1].options).toMatchObject({
      resume: id,
      cwd: original.cwd,
      model: services.requests[0].options.model,
    });
    expect(
      (await post(retryPath, { sourceCommandId: source.clientMsgId, confirmAmbiguous: true }))
        .status,
    ).toBe(200);
    expect(history).toEqual([source.clientMsgId, childId, 'retry-tail-b', 'retry-tail-c']);
    if (personal) {
      const prompts = await import('../../server/session-prompt-runtime.js');
      prompts.initializeSessionPrompts(':memory:', ctx);
      cleanups.push(() => prompts.closeSessionPrompts());
      const { agentMessageRuntime } = await import('../../server/agent-message-runtime.js');
      const session = chat.registry.findBySessionId(id)!.session;
      const runtime = agentMessageRuntime(session, f.auth.id)!;
      chat.eventStore.upsertSession({ sessionId: 'peer-stop-sender' });
      const peer = chat.eventStore.agentCommunication.reserve(
        'peer-stop-sender',
        f.auth.id,
        { turnId: 'peer-stop-turn', callId: 'peer-stop-call' },
        {
          requestId: randomUUID(),
          recipientConversationId: id,
          text: 'Retain this input if Stop wins.',
        },
      );
      chat.eventStore.agentCommunication.claim(peer.messageId);
      let releaseAccount!: () => void;
      accountWait = new Promise<void>((resolve) => {
        releaseAccount = resolve;
      });
      cleanups.push(() => releaseAccount());
      const beforePeer = [...history];
      expect(await runtime.enqueue!(peer, () => {}, session.abortController.signal, f.auth)).toBe(
        'queued',
      );
      await vi.waitFor(() => expect(accountWaiting).toBe(true));
      expect(
        (
          await post('/api/fixture/retry-runtime/continue', {
            ...f.request,
            ...wire,
            sessionId: id,
            clientMsgId: 'after-peer-stop',
            payload: { text: 'Original retained successor' },
          })
        ).status,
      ).toBe(202);
      expect(
        (await post('/api/fixture/retry-chat/stop', { type: 'stop', sessionId: id })).status,
      ).toBe(200);
      await vi.waitFor(() =>
        expect(chat.eventStore.getSession(id)?.executionPhase).toBe('STOPPING'),
      );
      releaseAccount();
      await vi.waitFor(() =>
        expect(chat.eventStore.getSession(id)).toMatchObject({
          executionPhase: 'TERMINAL',
          executionTerminalReason: 'stopped',
        }),
      );
      expect(history).toEqual(beforePeer);
      expect(chat.eventStore.getOrdinarySdkTurnEvents(id, peer.commandId)).toEqual([]);
      expect(
        chat.eventStore.agentCommunication.read('peer-stop-sender', peer.messageId),
      ).toMatchObject({ status: 'failed', reason: 'cancelled' });
      expect((await post(`/api/sessions/${id}/codex-queue/continue`, {})).status).toBe(200);
      await vi.waitFor(() => expect(history).toEqual([...beforePeer, 'after-peer-stop']));
      await vi.waitFor(() =>
        expect(chat.eventStore.getSession(id)?.executionPhase).toBe('TERMINAL'),
      );
      chat.registry.findBySessionId(id)!.session.ordinaryRuntimeOwner!.close();
      await vi.waitFor(() => expect(chat.registry.findBySessionId(id)).toBeNull());
      const coldSend = await post('/api/fixture/retry-runtime/continue', {
        ...f.request,
        ...wire,
        sessionId: id,
        clientMsgId: 'cold-after-peer-stop',
        payload: { text: 'Continue on the retained SDK history' },
      });
      expect(coldSend.status, JSON.stringify(coldSend.body)).toBe(202);
      await vi.waitFor(() =>
        expect(history).toEqual([...beforePeer, 'after-peer-stop', 'cold-after-peer-stop']),
      );
    }
  },
  30000,
);

it('a qualified preparation A starts model B on its original checkout and exact retry cannot launch again', async () => {
  vi.resetModules();
  const { ownedVertexRuntimeFixture } =
    await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
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
  const { nativeStartupSessionId } = await import('../../server/ordinary-repository-startup.js');
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
  let acknowledgeSettingsClose!: () => void;
  const settingsCloseObserved = new Promise<void>((resolve) => {
    acknowledgeSettingsClose = resolve;
  });
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
          acknowledgeSettingsClose();
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
  const chat = await import('../../server/chat.js');
  const sessionId = nativeStartupSessionId(`repository:${ready.id}`);
  cleanups.push(async () => {
    chat.registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner?.close();
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
    chat.eventStore.close();
  });
  const { createOwnedLocalCodexEntryRouter } =
    await import('../../server/ordinary-local-codex-entry.js');
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
  const invoke = (
    body: unknown,
    url = '/send',
    auth: import('../../server/auth.js').AuthSession = f.auth,
  ) =>
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

  const { loadAccountProfiles } = await import('../../server/account-profiles.js');
  expect(loadAccountProfiles().resolve('personal', 'future-C').profileRevision).toBe(revision);
  const { localVertexCapabilities, OrdinaryLocalVertexTarget } =
    await import('../../server/ordinary-local-vertex-capabilities.js');
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
  // Freeze the request clock while invoking its deadline callback explicitly.
  vi.spyOn(performance, 'now').mockReturnValue(Math.trunc(performance.now()));
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
  cleanups.push(() => {
    deferSettingsClose = false;
    releaseSettingsClose?.();
  });
  await Promise.race([
    settingsCloseObserved,
    expiredSettings.then(() => {
      throw Error('Settings preparation completed before its deferred close checkpoint');
    }),
  ]);
  expect(settingsCloseWaiting).toBe(true);
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
  const { createSessionPromptPort } = await import('../../server/session-prompt-dispatch.js');
  const retryPort = createSessionPromptPort({
    eventStore: chat.eventStore,
    sessionRegistry: chat.registry,
    connRegistry: { broadcast() {} },
  });
  cleanups.push(() => retryPort.close());
  const queue = await import('../../server/ordinary-local-vertex-queue.js');
  const { createCodexQueueRouter } = await import('../../server/codex-queue-routes.js');
  router.use(
    createCodexQueueRouter({
      authorizeMutation: (id, auth) =>
        queue.assertOwnedVertexQueueControl(chat.eventStore, id, auth),
      binding: (id) => chat.eventStore.getSession(id)?.accountBinding ?? undefined,
      overview: (id) => queue.readOwnedVertexQueueOverview(chat.eventStore, id),
      cancel: (id, _binding, commandId, auth) =>
        queue.cancelOwnedVertexQueuedCommand(chat.eventStore, id, commandId, auth),
      retry: (id, _binding, confirm, context) =>
        queue.retryOwnedVertexFailedTurn(
          chat.eventStore,
          retryPort,
          id,
          context!.sourceCommandId!,
          confirm,
          context?.authorization,
        ),
      reattach: async () => 'unavailable',
    }),
  );
  const expiredReceipt = chat.eventStore.getSendCommand('expired-settings');
  expect(
    await invoke(
      { sourceCommandId: 'expired-settings', confirmAmbiguous: false },
      `/${sessionId}/codex-queue/retry`,
    ),
  ).toMatchObject({ status: 200 });
  const retryId = queue.ordinarySdkRetryCommandId('expired-settings');
  await vi.waitFor(() => expect(observedInputs).toEqual(['prepared-first-B', retryId]));
  await vi.waitFor(() =>
    expect(chat.eventStore.getSession(sessionId)?.executionPhase).toBe('TERMINAL'),
  );
  expect(chat.eventStore.getSendCommand('expired-settings')).toEqual(expiredReceipt);
  const retryQueries = services.requests.length;
  expect(
    await invoke({ sourceCommandId: 'expired-settings' }, `/${sessionId}/codex-queue/retry`),
  ).toMatchObject({ status: 200 });
  expect(services.requests).toHaveLength(retryQueries);
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
  expect(continued, JSON.stringify(continued.body)).toMatchObject({
    status: 202,
    body: { state: 'consumed', sessionId },
  });
  await vi.waitFor(() => expect(services.requests).toHaveLength(retryQueries + 1));
  await vi.waitFor(() =>
    expect(
      chat.eventStore.getExecutionTerminalReason(
        chat.eventStore.getExecutionAdmission(sessionId, 'future-C')!.token,
      ),
    ).toBe('completed'),
  );
  expect(services.requests[retryQueries].options.resume).toBe(sessionId);
  expect(services.requests[retryQueries].options.model).toBe('future-C');
  expect(chat.eventStore.getSessionRuntimeBinding(sessionId)).toEqual(originalRuntime);
  expect(chat.eventStore.getSession(sessionId)?.accountBinding?.model).toBe('next-model');
  expect(chat.eventStore.getSessionEvents(sessionId).slice(0, originalHistory.length)).toEqual(
    originalHistory,
  );
  expect(await invoke(wire)).toMatchObject({
    status: 202,
    body: { state: 'consumed', dispatched: false, sessionId },
  });
  expect(services.requests).toHaveLength(retryQueries + 1);
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
  expect(services.requests).toHaveLength(retryQueries + 1);
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
  await vi.waitFor(() => expect(services.requests).toHaveLength(retryQueries + 2));
  await vi.waitFor(() =>
    expect(
      chat.eventStore.getExecutionTerminalReason(
        chat.eventStore.getExecutionAdmission(sessionId, 'cold-future-C')!.token,
      ),
    ).toBe('completed'),
  );
  expect(services.requests[retryQueries + 1].options.resume).toBe(sessionId);
  expect(services.requests[retryQueries + 1].options.model).toBe('future-C');
  expect(chat.eventStore.getSession(sessionId)?.accountBinding?.model).toBe('next-model');
  expect(chat.eventStore.getSessionRuntimeBinding(sessionId)).toEqual(originalRuntime);
  expect(observedInputs).toEqual(['prepared-first-B', retryId, 'future-C', 'cold-future-C']);
  expect(f.workspace.get(ready.id).directory).toBe(claimed.directory);
}, 20000);

it.each(['checkout', 'SDK setup'] as const)(
  'holds an aborted entry preparation without dispatching after deferred %s returns',
  async (stage) => {
    vi.resetModules();
    const { ownedVertexRuntimeFixture } =
      await import('../../server/__tests__/fixtures/owned-local-vertex-runtime.js');
    const f = await ownedVertexRuntimeFixture(cleanups, { chatRoute: true });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    const chat = await import('../../server/chat.js');
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
    let reachedCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      reachedCheckpoint = resolve;
    });
    if (stage === 'checkout') {
      const original = f.workspace.claimReservedHostTask.bind(f.workspace);
      vi.spyOn(f.workspace, 'claimReservedHostTask').mockImplementation(async (input) => {
        checkoutSignal = input.signal;
        reachedCheckpoint();
        await deferred;
        return original(input);
      });
    } else {
      const { OrdinaryLocalVertexSdkAuthority } =
        await import('../../server/ordinary-local-vertex-sdk-authority.js');
      const original = OrdinaryLocalVertexSdkAuthority.prototype.assertCurrent;
      let calls = 0;
      vi.spyOn(OrdinaryLocalVertexSdkAuthority.prototype, 'assertCurrent').mockImplementation(
        async function (this: InstanceType<typeof OrdinaryLocalVertexSdkAuthority>, signal) {
          if (++calls === 2) {
            checkoutSignal = signal;
            reachedCheckpoint();
            await deferred;
          }
          return original.call(this, signal);
        },
      );
    }
    const { startOwnedLocalVertexCommand } =
      await import('../../server/ordinary-local-vertex-entry.js');
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
    cleanups.push(async () => {
      controller.abort();
      release();
      await observed;
    });
    await Promise.race([
      checkpoint,
      pending.then(() => {
        throw Error('Entry preparation completed before the deferred checkpoint');
      }),
    ]);
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
