import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cp, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { AdviserSessionFactory } from '../terminal-adviser.js';
import type { GithubHostCommandRunner } from '../connections/capabilities/github-publish-pr-transport.js';
import { join } from 'node:path';
import type { CodexConversationStore } from '../codex-conversation-store.js';
import type { EventStore } from '../event-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}), getMcpConfigPaths: () => [] }));
const offline = vi.hoisted(() => ({
  host: vi.fn(),
  adviser: vi.fn(),
  listener: (_event: Record<string, unknown>) => {},
}));
vi.mock('../terminal-adviser-model.js', async (original) => ({
  ...(await original<object>()),
  createTerminalAdviserSession: offline.adviser,
}));
vi.mock('../connections/capabilities/github-publish-pr-transport.js', async (original) => {
  const actual =
    await original<typeof import('../connections/capabilities/github-publish-pr-transport.js')>();
  return {
    ...actual,
    GitHubCliHostPublisher: class extends actual.GitHubCliHostPublisher {
      constructor() {
        super(offline.host as GithubHostCommandRunner);
      }
    },
  };
});
vi.mock('../../packages/client/src/sse-connection.js', async () => {
  const { PreparedRepositorySseConnection } =
    await import('./fixtures/prepared-repository-browser.js');
  return {
    SseConnection: class extends PreparedRepositorySseConnection {
      onMessage(listener: typeof offline.listener) {
        offline.listener = listener;
      }
      getConnectionId() {
        return 'operator';
      }
      isConnected() {
        return true;
      }
      acknowledgeReconnectSnapshot() {
        return true;
      }
    },
  };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No model calls');
  },
}));

const resources = {
  stores: [] as EventStore[],
  natives: [] as CodexConversationStore[],
  roots: [] as string[],
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  resources.stores.splice(0).forEach((store) => store.close());
  resources.natives.splice(0).forEach((store) => store.close());
  resources.roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'completes OpenShell repository publication, replay and cold recovery through the real owners (API=%s)',
  async (api) => {
    vi.resetModules();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-openshell-completion-')));
    resources.roots.push(root);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
    vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('Offline fixture forbids network');
      }),
    );
    const { openCodexChat, getCodexConversationStore, getCodexRuntime } =
      await import('../codex-chat-session.js');
    const native = getCodexConversationStore();
    resources.natives.push(native);
    const { ownedOpenShellFixture } = await import('./fixtures/owned-openshell-runtime.js');
    const f = ownedOpenShellFixture(resources, false, undefined, undefined, {
      api,
      nativeStore: native,
    });
    writeFileSync(join(root, 'policy.yaml'), 'offline: true\n');
    f.owners.config.policy = join(root, 'policy.yaml');
    const { RepositoryWorkspaces } = await import('../repository-workspaces.js');
    const git = (directory: string, ...args: string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['-C', directory, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      ).trim();
    const source = join(root, 'source');
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', source]);
    git(source, 'config', 'user.name', 'Offline');
    git(source, 'config', 'user.email', 'offline@example.test');
    await writeFile(join(source, 'task.txt'), 'Original source');
    git(source, 'add', 'task.txt');
    git(source, 'commit', '-qm', 'base');
    const baseOid = git(source, 'rev-parse', 'HEAD');
    git(source, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
    git(source, 'update-ref', 'refs/remotes/origin/main', baseOid);
    const workspaces = new RepositoryWorkspaces(join(root, 'repository-owner'), {
      authorize: async () => ({ revision: 1, allowedBaseBranches: ['main'] }),
      inspect: async () => ({ repository: 'example/repo', baseBranch: 'main', baseOid }),
      prepare: async (_preview, directory, branch) => {
        await cp(source, directory, { recursive: true });
        git(directory, 'checkout', '-qb', branch);
        return {
          repository: 'example/repo',
          baseBranch: 'main',
          baseOid,
          directory,
          featureBranch: branch,
        };
      },
      verify: async () => {},
    });
    cleanups.push(() => workspaces.close());
    const signal = new AbortController().signal;
    const preview = await workspaces.preview(f.account, 'github', 'example/repo', signal);
    const prepared = await workspaces.prepare(preview.id, f.account, signal);
    const taskRoot = join(root, 'tasks');
    await mkdir(taskRoot);
    f.owners.workspace = workspaces;
    f.owners.workspaceId = prepared.id;
    f.owners.taskRoot = taskRoot;
    if (!('repositoryWorkspaceId' in f.meta)) throw Error('Repository workspace is required');
    f.meta.repositoryWorkspaceId = prepared.id;
    vi.spyOn(
      await import('../repository-workspace-runtime.js'),
      'getRepositoryWorkspaces',
    ).mockReturnValue(workspaces);
    const directory = join(root, 'remote-task');
    const { login, authenticateToken, setAuthRevocationStore, revokeAuthSession } =
      await import('../auth.js');
    setAuthRevocationStore(f.events);
    const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
    f.owners.authSessionId = auth.id;
    const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
    cleanups.push(() => revokeAuthSession(auth));
    cleanups.push(bindAgentLibraryTransport('operator', auth));
    const { OpenShellRuntimeManager } = await import('../openshell-runtime.js');
    // Only sandbox/provider effects are synthetic. The application selects and
    // fences them through the genuine OpenShell driver and admission capability.
    const ensure = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
      .mockImplementation(async () => {
        const seed = await workspaces.startupSeed(prepared.id, f.account, 'session', signal);
        await cp(seed, directory, { recursive: true });
        return f.artifact.runtime;
      });
    vi.spyOn(OpenShellRuntimeManager.prototype, 'verifyKnowledgeRuntime').mockResolvedValue({});
    vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 0,
      tokenCount: 0,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: '',
    });
    vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectTaskCapabilities').mockResolvedValue({
      mgmtCli: false,
      meetingPrep: false,
      gws: false,
    });
    vi.spyOn(OpenShellRuntimeManager.prototype, 'observeContract').mockResolvedValue({
      resourceVersion: 'offline-generation',
      policy: {},
      attestation: { basePolicy: {}, effectivePolicyHash: 'offline', providers: [] },
      approvedGrantableProviders: [],
      requiredServiceEnvironment: [],
    });
    const { CodexAppServerClient } = await import('../codex-app-server-client.js');
    let callbacks!: CodexLifecycleTransport;
    let turns = 0;
    const methods: string[] = [];
    let outcome = 'inProgress';
    const rpc = {
      initialize: vi.fn(async () => {}),
      close: vi.fn(),
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        methods.push(method);
        if (method === 'config/read') return { config: {} };
        if (method === 'thread/start' || method === 'thread/resume')
          return { thread: { id: 'remote-thread' }, model: 'first', modelProvider: 'openshell' };
        if (method === 'turn/start') {
          const id = `remote-turn-${++turns}`;
          callbacks.onNotification('turn/started', { threadId: 'remote-thread', turn: { id } });
          return { turn: { id } };
        }
        if (method === 'thread/turns/list') {
          expect(params.threadId).toBe('remote-thread');
          return { data: [{ id: 'remote-turn-1', status: outcome }], nextCursor: null };
        }
        return {};
      }),
    };
    const launch = vi
      .spyOn(CodexAppServerClient, 'launchOpenShell')
      .mockImplementation((_runtime, _env, cb) => {
        callbacks = cb!;
        return rpc as never;
      });
    const controller = new AbortController();
    let session = {
      sessionId: 'session',
      cwd: f.meta.cwd,
      mode: 'agent',
      abortController: controller,
      ownerConnectionId: 'operator',
      accountBinding: f.account,
      observers: new Set(),
      sessionAllowList: new Set(),
    } as Parameters<typeof openCodexChat>[0]['session'];
    const { SessionRegistry, resolvePending } = await import('@mitzo/harness');
    const registry = new SessionRegistry();
    registry.register('operator', session);
    session = registry.get('operator')!;
    cleanups.push(() => registry.dispose());
    const { replayEventsToTranscript } = await import('../conversation-transcript.js');
    const { createMitzoStore } = await import('@mitzo/client');
    const fetchHistory = async (path: string) => {
      if (path.includes('/messages')) {
        const events = f.events.getSessionEvents('session');
        return Response.json({
          ...replayEventsToTranscript(events),
          cursor: events.at(-1)?.seq ?? 0,
        });
      }
      return Response.json(path.endsWith('/meta') ? f.events.getSession('session') : []);
    };
    const client = createMitzoStore({
      transport: { fetch: fetchHistory },
      wsConfig: {
        buildUrl: () => '',
        createWebSocket: () => {
          throw Error('Offline SSE only');
        },
      },
      sseConfig: { baseUrl: '', fetch: fetchHistory },
    });
    await client.getState().switchSession('session');
    const loops: Promise<void>[] = [];
    const streamErrors: unknown[] = [];
    const transport = {
      isOpen: () => true,
      send: (event: Record<string, unknown>) => offline.listener(event),
    };
    session.transport = transport;
    const { initializeOpenShellLifecycle } = await import('../openshell-lifecycle-controller.js');
    const lifecycle = initializeOpenShellLifecycle(f.owners.config, {
      registry,
      eventStore: f.events,
      taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
      queue: () => native.lifecycleQueue('session', f.account),
    })!;
    cleanups.push(() => lifecycle.store.close());
    let query: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    cleanups.push(() => query?.close());
    const dispatch = vi.fn(async (input: Parameters<typeof f.owners.dispatch>[0]) => {
      if (query) {
        await getCodexRuntime(session)!.send({
          id: input.commandId,
          prompt: input.payload.text,
          model: input.expected.selection.model,
          reasoningEffort: input.expected.selection.thinking,
        });
        return;
      }
      query = await openCodexChat({
        conversationId: 'session',
        messageId: input.commandId,
        binding: input.account,
        profile: input.profile,
        session,
        registry,
        prompt: input.payload.text,
        systemPrompt: input.payload.systemPrompt,
        model: input.expected.selection.model,
        reasoningEffort: input.expected.selection.thinking,
        agentProfile: input.expected.agentProfile,
        repositoryWorkspace: input.workspace as never,
        ownedOpenShell: input.admission,
        resume: input.resume,
        eventStore: f.events,
        env: {},
        mcpServers: {},
      });
      const { runQueryLoop } = await import('../query-loop.js');
      loops.push(
        runQueryLoop(query, 'operator', registry, controller, f.events).catch((error) => {
          streamErrors.push(error);
        }),
      );
    });
    f.dispatch.mockImplementation(dispatch);
    await f.driver.admit(f.meta, f.command('first'));
    const original = native.readArtifactRuntime('session', f.account);
    await f.driver.admit(f.meta, f.command('second'));
    expect(turns).toBe(1);
    callbacks.onClose(new Error('Local transport client exited; remote agent may still run'));
    expect(native.commandLifecycle('session', f.account, 'first').state).toBe('ambiguous_effect');
    const runtime = getCodexRuntime(session)!;
    await expect(runtime.acknowledgeRecovery()).rejects.toThrow(/active/);
    expect(turns).toBe(1);
    outcome = 'completed';
    await runtime.acknowledgeRecovery();
    expect(native.commands('session', f.account).map(({ id, status }) => ({ id, status }))).toEqual(
      [
        { id: 'first', status: 'completed' },
        { id: 'second', status: 'running' },
      ],
    );
    await writeFile(join(directory, 'task.txt'), 'Edited inside the synthetic OpenShell task');
    git(directory, 'add', 'task.txt');
    git(directory, 'commit', '-qm', 'fix: offline remote edit');
    const { openshellPublicationEffects } =
      await import('./fixtures/openshell-publication-effects.js');
    const publication = await openshellPublicationEffects({
      root,
      directory,
      source,
      account: f.account,
      branch: workspaces.get(prepared.id).featureBranch!,
      host: offline.host as import('vitest').Mock<GithubHostCommandRunner>,
      adviser: offline.adviser as import('vitest').Mock<AdviserSessionFactory>,
    });
    cleanups.push(async () => {
      query?.close();
      await Promise.all(loops);
      await publication.close();
    });
    const { OpenShellConnectionGateway } = await import('../connections-gateway.js');
    vi.spyOn(OpenShellConnectionGateway.prototype, 'sandbox').mockResolvedValue({
      name: f.artifact.runtime.sandboxName,
      phase: 'Ready',
      labels: {},
    });
    // A newly configured host publisher cannot attach credentials to the
    // retained sandbox merely because the conversation cold-reconnects.
    vi.spyOn(OpenShellConnectionGateway.prototype, 'sandboxProviders').mockResolvedValue([
      f.artifact.route.provider,
    ]);

    const cards: unknown[] = [];
    session.observers.add({
      isOpen: () => true,
      send(event: Record<string, unknown>) {
        if (event.type !== 'permission_request') return;
        void (async () => {
          offline.listener(event);
          const permission = client.getState().messages.permission;
          expect(permission).not.toBeNull();
          cards.push(permission);
          const prefix = f.events.getSessionEvents('session');
          offline.listener({
            type: 'session_reconnect_snapshot',
            sessionId: 'session',
            cursor: prefix.at(-1)?.seq ?? 0,
            cursorValid: true,
          });
          await vi.waitFor(() => expect(client.getState().historyLoading).toBe(false));
          expect(client.getState().messages.permission).toEqual(permission);
          publication.order.push('approval');
          resolvePending(String(event.permId), 'once', undefined, 'session');
        })().catch((error) => {
          streamErrors.push(error);
          resolvePending(String(event.permId), 'deny', undefined, 'session');
        });
      },
    });
    const published = (await callbacks.onRequest(
      'item/tool/call',
      {
        threadId: 'remote-thread',
        turnId: 'remote-turn-2',
        callId: 'publish-task',
        tool: 'RequestGithubPublish',
        arguments: {
          repositoryPath: '/sandbox/workspaces/task',
          baseBranch: 'main',
          title: 'OpenShell reviewed task',
          body: 'Offline OpenShell publication.',
          draft: true,
        },
      },
      signal,
    )) as { success: boolean; contentItems: Array<{ text?: string }> };
    expect(published, JSON.stringify(published)).toMatchObject({ success: true });
    const receipt = JSON.parse(published.contentItems.map((item) => item.text ?? '').join(''));
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: { pullRequestUrl: 'https://github.com/example/repo/pull/42' },
    });
    const operation = publication.runtime.capabilityStore.get(receipt.operationId);
    expect(cards).toHaveLength(1);
    expect(publication.reviews).toHaveLength(2);
    callbacks.onNotification('item/agentMessage/delta', {
      threadId: 'remote-thread',
      turnId: 'remote-turn-2',
      itemId: 'published-answer',
      delta: 'Published the retained remote task.',
    });
    callbacks.onNotification('turn/completed', {
      threadId: 'remote-thread',
      turn: { id: 'remote-turn-2', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(native.commandStatus('session', f.account, 'second')).toBe('completed'),
    );
    await f.driver.admit(f.meta, f.command('later'));
    await runtime.resumeAfterExplicitSend();
    await vi.waitFor(() =>
      expect(native.commandStatus('session', f.account, 'later')).toBe('running'),
    );
    callbacks.onNotification('turn/completed', {
      threadId: 'remote-thread',
      turn: { id: 'remote-turn-3', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(native.commandStatus('session', f.account, 'later')).toBe('completed'),
    );
    query!.close();
    query = undefined;
    await Promise.all(loops);
    registry.register('operator', session);
    session = registry.get('operator')!;
    f.driver.close();
    const { OrdinaryOpenShellCodexOwnedRuntime } =
      await import('../ordinary-openshell-codex-owned-runtime.js');
    const cold = new OrdinaryOpenShellCodexOwnedRuntime({
      ...f.owners,
      resume: true,
      dispatch,
      dispatchContinuation: dispatch,
    });
    cleanups.push(() => cold.close());
    await cold.admit(f.meta, f.command('third'));
    expect(turns).toBe(4);
    expect(native.readArtifactRuntime('session', f.account)).toEqual(original);
    expect(native.read('session', f.account).threadId).toBe('remote-thread');
    expect(launch).toHaveBeenCalledTimes(3); // initial, reconnect, fresh cold owner
    expect(ensure).toHaveBeenCalledTimes(1); // cold adoption cannot allocate a replacement
    expect(methods.filter((method) => method === 'turn/start')).toHaveLength(4);
    expect(f.events.getOrdinaryOpenShellCommandAdmission('third')?.state).toBe('consumed');
    expect(publication.runtime.capabilityStore.get(receipt.operationId)).toEqual(operation);
    expect(publication.order.filter((event) => event === 'create')).toHaveLength(1);
    expect(git(directory, 'rev-parse', 'HEAD')).toBe(publication.publishedHead());
    expect(git(source, 'rev-parse', 'HEAD')).toBe(baseOid);
    expect(lifecycle.store.get('session')).toMatchObject({
      physicalSandboxId: f.artifact.runtime.sandboxId,
    });
    expect(
      JSON.stringify(replayEventsToTranscript(f.events.getSessionEvents('session'))),
    ).toContain('Published the retained remote task.');
    callbacks.onNotification('turn/completed', {
      threadId: 'remote-thread',
      turn: { id: 'remote-turn-4', status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(native.commandStatus('session', f.account, 'third')).toBe('completed'),
    );
    query!.close();
    await Promise.all(loops);
    expect(streamErrors).toEqual([]);
  },
  120000,
);
