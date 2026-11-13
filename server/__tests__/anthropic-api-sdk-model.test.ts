import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { AsyncQueue } from '../async-queue.js';
import { ownedVertexRuntimeFixture } from './fixtures/owned-local-vertex-runtime.js';
import { sdkFixtureBoundary, sdkQueryPeer } from './fixtures/sdk-query-peer.js';
import {
  OrdinaryLocalVertexOwnedRuntime,
  type OrdinaryLocalVertexOwnedDispatch,
} from '../ordinary-local-vertex-owned-runtime.js';
import { OrdinaryLocalVertexSdkAuthority } from '../ordinary-local-vertex-sdk-authority.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const keychain = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../keychain-rotation-credentials.js', () => ({
  KeychainRotationCredentials: class {
    read = keychain.read;
  },
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
  getSessionInfo: vi.fn(async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  })),
  getSessionMessages: vi.fn(async () => [{ uuid: 'retained-input' }]),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('keeps exact Messages model IDs through real admission, chat startup, SDK continuation and search options', async () => {
  const models = ['gateway/claude:latest', 'gateway/claude:max'] as const;
  vi.stubEnv('PATH', '/usr/bin:/bin');
  const f = await ownedVertexRuntimeFixture(cleanups, {
    anthropicApi: true,
    chatRoute: true,
    modelIds: models,
  });
  keychain.read.mockResolvedValue({
    value: 'synthetic-offline-key',
    version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
    managed: true,
  });
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
  );
  const repositories = await import('../repository-workspace-runtime.js');
  vi.spyOn(repositories, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  const library = await import('../agent-library-runtime.js');
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  const boundary = await import('../credential-sdk-boundary.js');
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue(sdkFixtureBoundary() as never);
  const web = await import('../web-access-tool.js');
  const searches: Parameters<typeof web.createWebAccessTool>[2][] = [];
  const actualTool = web.createWebAccessTool;
  vi.spyOn(web, 'createWebAccessTool').mockImplementation((...args) => {
    searches.push(args[2]);
    return actualTool(...args);
  });
  const adapter = await import('../web-search-adapters.js');
  const search = vi.spyOn(adapter, 'searchSdk').mockResolvedValue('Offline search result');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const calls: Options[] = [];
  vi.mocked(query).mockImplementation((args) => {
    calls.push(args.options!);
    const events = new AsyncQueue<Record<string, unknown>>();
    const stream = async function* () {
      for await (const event of events) yield event;
    };
    const peer = sdkQueryPeer(args, stream());
    const close = peer.close;
    peer.close = () => {
      events.close();
      close();
    };
    return peer;
  });
  const chat = await import('../chat.js');
  const diagnostics = await import('../codex-chat-session.js');
  const startupErrors: Error[] = [];
  const publicStartupError = diagnostics.publicCodexStartupError;
  vi.spyOn(diagnostics, 'publicCodexStartupError').mockImplementation((error) => {
    startupErrors.push(error);
    return publicStartupError(error);
  });
  const tasks: Promise<void>[] = [];
  let currentCommand: string = f.request.clientMsgId;
  let reopen: Parameters<
    NonNullable<Parameters<typeof chat.startChat>[3]['ordinarySdkCommandOwner']>
  >[2];
  let push: Parameters<
    NonNullable<Parameters<typeof chat.startChat>[3]['ordinarySdkCommandOwner']>
  >[1];
  const dispatch = async (selected: OrdinaryLocalVertexOwnedDispatch) => {
    currentCommand = selected.commandId;
    if (calls.length) {
      await reopen(selected.expected.selection);
      push(
        selected.commandId,
        f.events.getOrdinaryLocalVertexCommandAdmission(selected.commandId)!,
        selected.payload,
      );
      return;
    }
    const custody = f.events.getOrdinaryLocalVertexCustody(selected.sessionId)!;
    const authority = new OrdinaryLocalVertexSdkAuthority({
      store: f.events,
      custody,
      commandId: selected.commandId,
      signal: owner.signal,
      environment: () => owner.environment(),
      sourceWriteRoots: [],
      assertCurrent: () => owner.assertEffect(currentCommand),
      assertCurrentSync: () => owner.assertStart(currentCommand),
    });
    let resolveAdmission!: () => void;
    let rejectAdmission!: (error: unknown) => void;
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    const task = chat.startChat(
      { send: vi.fn(), isOpen: () => true },
      'exact-messages-model',
      selected.payload.text,
      {
        initialSessionId: selected.sessionId,
        cwd: selected.workspace.directory,
        repositoryWorkspaceId: selected.workspace.id,
        accountId: selected.binding.accountId,
        model: selected.expected.selection.model,
        reasoningEffort: selected.expected.selection.thinking,
        agentProfile: selected.expected.selection.agent,
        clientMsgId: selected.commandId,
        operatorConnectionId: f.dependencies.operatorConnectionId,
        ordinarySdkAuthority: authority,
        ordinarySdkCommandOwner: (_native, send, apply) => {
          // Production entry binds this owner before starting the SDK. Retain
          // the same identity for the peer-input guard in this isolated adapter fixture.
          chat.registry.get('exact-messages-model')!.ordinaryRuntimeOwner = {
            location: 'local',
            authSessionId: 'offline-sdk-operator',
            identity: owner,
            initialCommandId: f.request.clientMsgId,
            admit: (request) => owner.admit(request),
            retryInitial: (request) => owner.admit(request),
            close: () => owner.close(),
          };
          reopen = apply;
          push = send;
          return {
            enqueue: async () => {
              await apply(selected.expected.selection);
              send(
                selected.commandId,
                f.events.getOrdinaryLocalVertexCommandAdmission(selected.commandId)!,
                selected.payload,
              );
            },
            inputObserved: () => {},
            resultObserved: async () => {},
            activeCommandId: () => currentCommand,
            peerTurnTarget: () => currentCommand,
            acceptsPeerMessages: () => true,
          } as never;
        },
        onStartupAdmission: (error) => (error ? rejectAdmission(error) : resolveAdmission()),
      },
    );
    tasks.push(task);
    void task.catch(rejectAdmission);
    await admitted;
  };
  const owner = new OrdinaryLocalVertexOwnedRuntime({
    enabled: true,
    eventStore: f.events,
    library: f.library,
    workspace: f.workspace,
    reservation: f.reservation,
    commandId: f.request.clientMsgId,
    operatorConnectionId: f.dependencies.operatorConnectionId,
    signal: f.signal.signal,
    env: f.dependencies.env,
    dispatch,
    dispatchContinuation: dispatch,
  });
  try {
    await owner.admit(f.request).catch((error) => {
      throw startupErrors[0] ?? error;
    });
    expect.soft(calls[0].model).toBe(models[0]);
    expect.soft(calls[0].effort).toBe('low');
    const learningPrompt = (index: number) =>
      (calls[index].systemPrompt as { append: string }).append;
    expect(learningPrompt(0)).toContain('<session_learning mode="auto">');
    await searches.at(-1)!('Synthetic search', new AbortController().signal, {
      parentSessionId: f.reservation.conversationId,
      operationId: 'search-first',
    });
    expect.soft(search.mock.calls.at(-1)![2].model).toBe(models[0]);
    owner.commandTerminal(f.request.clientMsgId);
    const sessionId = f.reservation.conversationId;
    const off = chat.eventStore.setSessionLearningMode(
      sessionId,
      'off',
      chat.eventStore.getSessionLearningPolicy(sessionId).revision,
    );
    await owner.admitContinuation({
      ...f.request,
      clientMsgId: 'exact-next',
      selection: { ...f.request.selection, model: models[1], thinking: 'high' },
    });
    expect.soft(calls[1].model).toBe(models[1]);
    expect.soft(calls[1].effort).toBe('high');
    expect(learningPrompt(1)).not.toContain('<session_learning ');
    await searches.at(-1)!('Synthetic search', new AbortController().signal, {
      parentSessionId: f.reservation.conversationId,
      operationId: 'search-next',
    });
    expect.soft(search.mock.calls.at(-1)![2].model).toBe(models[1]);
    owner.commandTerminal('exact-next');
    chat.eventStore.setSessionLearningMode(sessionId, 'deep', off.revision);
    await owner.admitContinuation({
      ...f.request,
      clientMsgId: 'exact-third',
      selection: { ...f.request.selection, model: models[1], thinking: 'high' },
    });
    expect(learningPrompt(2)).toContain('<session_learning mode="deep">');
    expect(learningPrompt(2).match(/<session_learning /g)).toHaveLength(1);
    expect(learningPrompt(0)).toContain('<session_learning mode="auto">');
  } finally {
    chat.registry.dispose();
    owner.close();
    await Promise.allSettled(tasks);
    chat.eventStore.close();
  }
});
