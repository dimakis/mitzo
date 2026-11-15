import './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { OrdinaryLocalVertexOwnedDispatch } from '../ordinary-local-vertex-owned-runtime.js';
import { AsyncQueue } from '../async-queue.js';
import { sdkFixtureBoundary, sdkQueryPeer } from './fixtures/sdk-query-peer.js';
import { hostKnowledgePublication } from './fixtures/host-knowledge-publication.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
beforeEach(() => vi.resetModules());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(personal: boolean) {
  const { ownedVertexRuntimeFixture } = await import('./fixtures/owned-local-vertex-runtime.js');
  const { OrdinaryLocalVertexOwnedRuntime } =
    await import('../ordinary-local-vertex-owned-runtime.js');
  const { OrdinaryLocalVertexSdkAuthority } =
    await import('../ordinary-local-vertex-sdk-authority.js');
  const f = await ownedVertexRuntimeFixture(cleanups, { personal, chatRoute: true });
  if (personal) {
    const { ClaudeSubscriptionCustody } = await import('../claude-subscription-custody.js');
    const capture = ClaudeSubscriptionCustody.capture;
    vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
      capture(env, f.personalExecutable),
    );
    vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
  }
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            boot: {
              content: 'Compiled ordinary boot context',
              sources: ['memory/Profile/Working Style.md'],
              tokens: 10,
            },
          }),
        ),
    ),
  );
  const repositories = await import('../repository-workspace-runtime.js');
  vi.spyOn(repositories, 'getRepositoryWorkspaces').mockReturnValue(f.workspace);
  const library = await import('../agent-library-runtime.js');
  vi.spyOn(library, 'getAgentLibrary').mockReturnValue(f.library);
  const boundary = await import('../credential-sdk-boundary.js');
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue(sdkFixtureBoundary() as never);
  const knowledge = await import('../published-host-knowledge.js');
  const first = hostKnowledgePublication(f.root, 'a', 'Accepted shared memory');
  const second = hostKnowledgePublication(f.root, 'b', 'Next accepted shared memory');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
  const restorePublication = knowledge.installHostKnowledgeStore({ id: 'mgmt', reconcile });
  cleanups.push(restorePublication);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const calls: Options[] = [];
  const streams: AsyncQueue<Record<string, unknown>>[] = [];
  vi.mocked(query).mockImplementation((request) => {
    calls.push(request.options!);
    const events = new AsyncQueue<Record<string, unknown>>();
    streams.push(events);
    const peer = sdkQueryPeer(
      request,
      (async function* () {
        for await (const event of events) yield event;
      })(),
    );
    const close = peer.close;
    peer.close = () => {
      events.close();
      close();
    };
    return peer;
  });
  const chat = await import('../chat.js');
  const tasks: Promise<void>[] = [];
  let currentCommand: string = f.request.clientMsgId;
  let reopen!: (
    selection: import('@mitzo/protocol').OrdinaryLocalCommandAdmission['selection'],
  ) => Promise<void>;
  let push!: (...args: unknown[]) => void;
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
    await writeFile(
      join(selected.workspace.directory!, 'AGENTS.md'),
      '# Task rules\nKeep the admitted branch.',
    );
    const authority = new OrdinaryLocalVertexSdkAuthority({
      store: f.events,
      custody: f.events.getOrdinaryLocalVertexCustody(selected.sessionId)!,
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
      'startup-context',
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
          chat.registry.get('startup-context')!.ordinaryRuntimeOwner = {
            location: 'local',
            authSessionId: 'offline-sdk-operator',
            identity: owner,
            initialCommandId: f.request.clientMsgId,
            admit: (request) => owner.admit(request),
            retryInitial: (request) => owner.admit(request),
            close: () => owner.close(),
          };
          reopen = apply;
          push = send as never;
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
            messageStarted: () => {},
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
  cleanups.push(async () => {
    chat.registry.dispose();
    owner.close();
    await Promise.allSettled(tasks);
    chat.eventStore.close();
  });
  return { f, calls, streams, owner, chat, first, second, reconcile, restorePublication };
}
it.each([false, true])(
  'delivers boot/project/published context to the actual ordinary SDK adapter, personal=%s',
  async (personal) => {
    const x = await fixture(personal);
    await x.owner.admit(x.f.request);
    const append = (index: number) => (x.calls[index].systemPrompt as { append: string }).append;
    expect(append(0)).toContain('Compiled ordinary boot context');
    expect(append(0)).toContain('Keep the admitted branch.');
    expect(append(0)).toContain(x.first.sourceCommit);
    expect(append(0)).toContain('ReadKnowledge with action published');
    expect(x.calls[0].settingSources).toEqual([]);
    const session = x.chat.registry.get('startup-context')!;
    const server = x.calls[0].mcpServers!['mitzo-connections'];
    if (server.type !== 'sdk') throw Error('Expected in-process SDK tools');
    const client = new Client({ name: 'offline-published-reader', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      const read = await client.callTool({
        name: 'ReadKnowledge',
        arguments: { action: 'published', path: 'memory/Observations/lesson.md' },
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read.content)).toContain('Accepted shared memory');
    } finally {
      await client.close();
    }
    expect(session.bootContext).toMatchObject({ fullMarkdown: 'Compiled ordinary boot context' });
    expect(
      x.chat.eventStore
        .getSessionEvents(x.f.reservation.conversationId)
        .filter((event) => event.type === 'published_knowledge_adopted'),
    ).toHaveLength(0);
    x.streams[0].push({
      type: 'stream_event',
      session_id: x.f.reservation.conversationId,
      event: {
        type: 'message_start',
        message: { id: 'accepted-first-context', role: 'assistant', content: [] },
      },
    });
    await vi.waitFor(() =>
      expect(
        x.chat.eventStore
          .getSessionEvents(x.f.reservation.conversationId)
          .filter((event) => event.type === 'published_knowledge_adopted'),
      ).toHaveLength(1),
    );
    x.owner.commandTerminal(x.f.request.clientMsgId);
    await x.owner.admitContinuation({ ...x.f.request, clientMsgId: 'next-context' });
    expect(append(1)).toContain(x.second.sourceCommit);
    expect(append(1)).not.toContain(x.first.sourceCommit);
    expect(append(0)).toContain(x.first.sourceCommit);
    expect(x.reconcile).toHaveBeenCalledTimes(2);
    x.restorePublication();
    // The original authority aborts the query; its SDK callback wrapper returns
    // the canonical retirement denial after that abort.
    await expect(
      x.calls[1].canUseTool!(
        'Read',
        { file_path: join(x.f.reserved.directory!, 'task.txt') },
        {
          signal: new AbortController().signal,
          toolUseID: 'revoked-publication',
          requestId: 'revoked-publication',
        },
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(session.abortController.signal.aborted).toBe(true);
  },
  20_000,
);
