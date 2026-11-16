import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
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
beforeEach(() => {
  resetOfflineUserEnvironment();
  vi.resetModules();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture(personal: boolean, consumeInput = false) {
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
  vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue({
    ...sdkFixtureBoundary(),
    // The protocol peer never executes project commands or inspects host roots.
    credentialIsolation: true,
  } as never);
  const knowledge = await import('../published-host-knowledge.js');
  const first = hostKnowledgePublication(f.root, 'a', 'Accepted shared memory');
  const second = hostKnowledgePublication(f.root, 'b', 'Next accepted shared memory');
  const reconcile = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
  const restorePublication = knowledge.installHostKnowledgeStore({ id: 'mgmt', reconcile });
  cleanups.push(restorePublication);
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const calls: Options[] = [];
  const streams: AsyncQueue<Record<string, unknown>>[] = [];
  const inputs: unknown[] = [];
  const inputFailures: unknown[] = [];
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
    peer.accountInfo = async () => ({
      apiProvider: 'firstParty',
      email: 'person@example.test',
      subscriptionType: 'Claude Max',
    });
    if (consumeInput) {
      if (typeof request.prompt === 'string') throw Error('Expected guarded SDK input');
      void request.prompt[Symbol.asyncIterator]()
        .next()
        .then(
          (result) => {
            if (!result.done) inputs.push(result.value);
          },
          (error: unknown) => {
            inputFailures.push(error);
            events.close();
          },
        );
    }
    return peer;
  });
  const chat = await import('../chat.js');
  const sent = vi.fn();
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
      { send: sent, isOpen: () => true },
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
            assertInputCurrent: (id: string) => {
              owner.assertStart(id);
              return true;
            },
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
  return {
    f,
    calls,
    streams,
    inputs,
    inputFailures,
    owner,
    chat,
    sent,
    first,
    second,
    reconcile,
    restorePublication,
  };
}
it.each(['unavailable', 'invalid'] as const)(
  'reports an enrolled publication %s through actual startup without creating a provider',
  async (failure) => {
    const x = await fixture(false);
    x.reconcile.mockReset();
    if (failure === 'unavailable')
      x.reconcile.mockRejectedValue(Error('PRIVATE_PUBLISHER_FAILURE'));
    else x.reconcile.mockResolvedValue({ ...x.first, sourceCommit: 'c'.repeat(40) });
    await expect(x.owner.admit(x.f.request)).rejects.toThrow();
    expect(x.calls).toEqual([]);
    const errors = x.sent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).not.toContain('PRIVATE_PUBLISHER_FAILURE');
  },
  20_000,
);

it.each([false, true])(
  'settles source cleanup before creating the SDK that can consume its first input, personal=%s',
  async (personal) => {
    const x = await fixture(personal, true);
    const release = x.f.workspace.releaseSource.bind(x.f.workspace);
    const providerCounts: number[] = [];
    vi.spyOn(x.f.workspace, 'releaseSource').mockImplementation(async (...args) => {
      providerCounts.push(x.calls.length);
      await release(...args);
    });
    await x.owner.admit(x.f.request);
    expect(providerCounts).toEqual([0]);
    expect(x.f.workspace.get(x.f.reservation.id).sourceReleased).toBe(true);
    expect(x.calls).toHaveLength(1);
    await vi.waitFor(() =>
      expect({ inputs: x.inputs.length, failures: x.inputFailures }).toEqual({
        inputs: 1,
        failures: [],
      }),
    );
  },
  20_000,
);

it('retains a cleanup failure without retrying it beside the first SDK input', async () => {
  const x = await fixture(true, true);
  const release = vi
    .spyOn(x.f.workspace, 'releaseSource')
    .mockRejectedValue(Error('PRIVATE_SEED_FAILURE'));
  await x.owner.admit(x.f.request);
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
  expect(x.inputFailures).toEqual([]);
  expect(release).toHaveBeenCalledOnce();
  expect(x.f.workspace.get(x.f.reservation.id).sourceReleased).not.toBe(true);
  expect(JSON.stringify(x.sent.mock.calls)).not.toContain('PRIVATE_SEED_FAILURE');
}, 20_000);

it('rechecks cancellation after source cleanup before creating the SDK', async () => {
  const x = await fixture(true, true);
  vi.spyOn(x.f.workspace, 'releaseSource').mockImplementation(async () => {
    x.f.signal.abort(Error('PRIVATE_CANCEL_REASON'));
  });
  await expect(x.owner.admit(x.f.request)).rejects.toThrow();
  expect(x.calls).toEqual([]);
  expect(x.inputs).toEqual([]);
  expect(JSON.stringify(x.sent.mock.calls)).not.toContain('PRIVATE_CANCEL_REASON');
}, 20_000);

it('protects the selected executable itself without denying its entire parent workspace', async () => {
  const x = await fixture(true);
  await x.owner.admit(x.f.request);
  const boundary = await import('../credential-sdk-boundary.js');
  const selected = vi.mocked(boundary.credentialSdkBoundary).mock.calls[0][1];
  expect(selected).toContain(x.f.personalExecutable);
  expect(selected).not.toContain(x.f.root);
}, 20000);

it('explains the enforced outer boundary when a Bash request asks to disable the SDK sandbox', async () => {
  const x = await fixture(true);
  await x.owner.admit(x.f.request);
  const decision = await x.calls[0].canUseTool!(
    'Bash',
    { command: 'true', dangerouslyDisableSandbox: true },
    {
      signal: new AbortController().signal,
      toolUseID: 'sandbox-override-probe',
      requestId: 'sandbox-override-probe',
    },
  );
  expect(decision).toMatchObject({
    behavior: 'deny',
    message: expect.stringContaining('outer host sandbox'),
  });
}, 20000);

it('retains the explicit empty boot fallback when ContexGin is unavailable while delivering verified project/publication context', async () => {
  const x = await fixture(false);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('offline boot service')));
  await x.owner.admit(x.f.request);
  const session = x.chat.registry.get('startup-context')!;
  expect(session.bootContext).toMatchObject({ source: 'local-fallback', sourceCount: 0 });
  const append = (x.calls[0].systemPrompt as { append: string }).append;
  expect(append).toContain('Keep the admitted branch.');
  expect(append).toContain(x.first.sourceCommit);
  expect(append).not.toContain('Compiled ordinary boot context');
}, 20_000);
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
    expect(append(0)).toContain('PrepareLocalRepository');
    expect(x.calls[0].settingSources).toEqual([]);
    const session = x.chat.registry.get('startup-context')!;
    const server = x.calls[0].mcpServers!['mitzo-connections'];
    if (server.type !== 'sdk') throw Error('Expected in-process SDK tools');
    const client = new Client({ name: 'offline-published-reader', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'DiscoverLocalRepository',
          'InspectLocalRepository',
          'PrepareLocalRepository',
        ]),
      );
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
