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
      ownerAuthSessionId: owner.authSessionId,
      signal: owner.signal,
      environment: () => owner.environment(),
      sourceWriteRoots: [],
      assertCurrent: () => owner.assertEffect(currentCommand),
      assertToolCurrent: () => owner.assertToolEffect(currentCommand),
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
            authSessionId: owner.authSessionId,
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

it('releases the registered driver when retained repository restoration fails', async () => {
  const x = await fixture(false);
  const repositories = await import('../sdk-secondary-repository.js');
  vi.spyOn(repositories, 'restoreSdkSecondaryRepositories').mockRejectedValue(
    Error('PRIVATE_RESTORE_FAILURE'),
  );
  await expect(x.owner.admit(x.f.request)).rejects.toThrow();
  expect(x.calls).toEqual([]);
  expect(x.chat.registry.get('startup-context')).toBeUndefined();
  expect(JSON.stringify(x.sent.mock.calls)).not.toContain('PRIVATE_RESTORE_FAILURE');
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
it.each([false, true])(
  'registers managed GitHub publication on the actual ordinary SDK route, personal=%s',
  async (personal) => {
    const x = await fixture(personal);
    await x.owner.admit(x.f.request);
    const { GITHUB_PUBLISH_SDK_TOOL } = await import('../web-access-sdk.js');
    const options = x.calls[0];
    expect(options.allowedTools).toContain(GITHUB_PUBLISH_SDK_TOOL);
    expect(options.disallowedTools).not.toContain(GITHUB_PUBLISH_SDK_TOOL);
    const { GITHUB_PUBLISHING_INSTRUCTIONS, ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS } =
      await import('../github-publishing-tool.js');
    const append = (options.systemPrompt as { append: string }).append;
    expect(append).toContain(ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS);
    expect(append).not.toContain(GITHUB_PUBLISHING_INSTRUCTIONS);
    // Managed publication is presented as one route, never the only one.
    expect(ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS).toMatch(
      /RequestGithubPublish is the managed route/,
    );
    expect(ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS).toMatch(/TaskExecution github_read/);
    expect(ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS).toMatch(/native git or TaskExecution commit/);
    expect(ORDINARY_CLAUDE_GITHUB_INSTRUCTIONS).not.toMatch(/only (route|way)/i);
    // The tool owns its forced approval cards; the outer SDK prompt is not duplicated.
    expect(
      await options.canUseTool!(
        GITHUB_PUBLISH_SDK_TOOL,
        {},
        { signal: new AbortController().signal, toolUseID: 'publish', requestId: 'publish' },
      ),
    ).toMatchObject({ behavior: 'allow' });
    const server = options.mcpServers!['mitzo-web-access'];
    if (server.type !== 'sdk') throw Error('Expected in-process SDK tools');
    const client = new Client({ name: 'offline-publisher', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['RequestWebAccess', 'RequestGithubPublish']),
      );
      const result = await client.callTool({
        name: 'RequestGithubPublish',
        arguments: {
          repositoryPath: x.f.reserved.directory!,
          baseBranch: 'main',
          title: 'Offline publication',
          body: '',
          draft: true,
        },
      });
      // The per-query server carries the native call fence through owner
      // capture: the driver is bound to its operator from registration, so the
      // call reaches the managed-connection check, which this offline fixture
      // lacks. The signed publication chain is covered in
      // github-publishing-tool.test.ts with the same server and fence.
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(
        /needs a configured managed GitHub connection/,
      );
    } finally {
      await client.close();
    }
  },
  20_000,
);

it('revalidates workspace authority only at startup boundaries before creating the SDK', async () => {
  const x = await fixture(false, true);
  const beforeProvider: number[] = [];
  const effect = x.owner.assertEffect.bind(x.owner);
  vi.spyOn(x.owner, 'assertEffect').mockImplementation(async (id) => {
    if (!x.calls.length) beforeProvider.push(1);
    await effect(id);
  });
  await x.owner.admit(x.f.request);
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
  // Dispatch, chat start, after the context reads, after context and Tool
  // Library discovery, after source cleanup (was 7: two adjacent duplicates).
  // Each check reruns workspace reservation, credential and checkout checks.
  expect(beforeProvider).toHaveLength(5);
}, 20_000);

it('runs the deep proof at prompt release and none in per-tool SDK callbacks', async () => {
  const x = await fixture(false, true);
  const { resetSdkAuthorityCheckCounts, sdkAuthorityCheckCounts } =
    await import('../sdk-authority-observation.js');
  resetSdkAuthorityCheckCounts();
  const deep = vi.spyOn(x.owner, 'assertEffect');
  const tool = vi.spyOn(x.owner, 'assertToolEffect');
  await x.owner.admit(x.f.request);
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
  // The input reached the native process only after its deep proof.
  expect(sdkAuthorityCheckCounts()['deep:prompt_release']).toBeGreaterThanOrEqual(1);
  expect(sdkAuthorityCheckCounts()['tool:hook']).toBeUndefined();
  resetSdkAuthorityCheckCounts();
  deep.mockClear();
  tool.mockClear();
  const options = x.calls[0];
  const signal = new AbortController().signal;
  const cwd = x.f.reserved.directory!;
  const file = join(cwd, 'task.txt');
  const base = { session_id: x.f.reservation.conversationId, transcript_path: '', cwd };
  const hooks = async (event: string, input: Record<string, unknown>) => {
    for (const matcher of options.hooks?.[event as 'PreToolUse'] ?? [])
      for (const hook of matcher.hooks)
        await hook({ ...base, hook_event_name: event, ...input } as never, 'tool-1', { signal });
  };
  // One native tool call as the SDK drives it, plus one in-process MCP call.
  await hooks('PreToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: file },
    tool_use_id: 'tool-1',
  });
  await options.canUseTool!(
    'Read',
    { file_path: file },
    { signal, toolUseID: 'tool-1', requestId: 'tool-1' },
  );
  await hooks('PostToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: file },
    tool_response: {},
    tool_use_id: 'tool-1',
  });
  await hooks('PostToolBatch', {});
  const server = options.mcpServers!['mitzo-connections'];
  if (server.type !== 'sdk') throw Error('Expected in-process SDK tools');
  const client = new Client({ name: 'offline-per-tool', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  await client.connect(b);
  try {
    await client.callTool({
      name: 'ReadKnowledge',
      arguments: { action: 'published', path: 'memory/Observations/lesson.md' },
    });
  } finally {
    await client.close();
  }
  const counts = sdkAuthorityCheckCounts();
  expect(Object.keys(counts).filter((key) => key.startsWith('deep:'))).toEqual([]);
  expect(counts['tool:hook']).toBeGreaterThan(0);
  expect(counts['tool:decide']).toBeGreaterThan(0);
  expect(counts['tool:mcp']).toBeGreaterThan(0);
  expect(deep).not.toHaveBeenCalled();
  expect(tool).toHaveBeenCalled();
  // The chat stays usable: callbacks did not retire the provider.
  expect(x.chat.registry.get('startup-context')!.abortController.signal.aborted).toBe(false);
}, 20_000);

it('prepares startup context while Tool Library discovery is still pending', async () => {
  const x = await fixture(false, true);
  const library = await import('../tool-library-sdk.js');
  let finishDiscovery!: () => void;
  const discovery = new Promise<undefined>((resolve) => {
    finishDiscovery = () => resolve(undefined);
  });
  vi.spyOn(library, 'createSdkToolLibrary').mockReturnValue(discovery);
  const admitted = x.owner.admit(x.f.request);
  await vi.waitFor(() => expect(x.reconcile).toHaveBeenCalled());
  expect(x.calls).toHaveLength(0);
  finishDiscovery();
  await admitted;
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
}, 20_000);

it('keeps the operator in control when its stream reconnects during Claude startup', async () => {
  const x = await fixture(false, true);
  const library = await import('../tool-library-sdk.js');
  let finishDiscovery!: () => void;
  const discovery = new Promise<undefined>((resolve) => {
    finishDiscovery = () => resolve(undefined);
  });
  vi.spyOn(library, 'createSdkToolLibrary').mockReturnValue(discovery);
  const admitted = x.owner.admit(x.f.request);
  await vi.waitFor(() => expect(x.reconcile).toHaveBeenCalled());
  // Startup is registered but the native SDK query does not exist yet.
  expect(x.calls).toHaveLength(0);
  const session = x.chat.registry.get('startup-context')!;
  expect(session.ownedLocalAuthSessionId).toBe(x.owner.authSessionId);

  const { claimTransportConnection, releaseTransportConnection } =
    await import('../transport-auth-ownership.js');
  const { ownedLocalControlStatus } = await import('../owned-local-codex-control.js');
  const ctx = { sessionRegistry: x.chat.registry, eventStore: x.chat.eventStore };
  const open = { isOpen: () => true } as never;
  const reconnected = 'conn-reconnected-during-startup';
  claimTransportConnection(reconnected, x.owner.authSessionId);
  cleanups.push(() => releaseTransportConnection(reconnected, x.owner.authSessionId));
  expect(ownedLocalControlStatus(reconnected, session.sessionId!, open, ctx)).toBe('authorized');
  const stranger = 'conn-other-login-during-startup';
  claimTransportConnection(stranger, 'other-login');
  cleanups.push(() => releaseTransportConnection(stranger, 'other-login'));
  expect(ownedLocalControlStatus(stranger, session.sessionId!, open, ctx)).toBe('denied');

  finishDiscovery();
  await admitted;
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
}, 20_000);

async function ownedEntry(x: Awaited<ReturnType<typeof fixture>>, ownerConnectionId: string) {
  // The entry constructs its own owner for the same admitted command.
  x.owner.close();
  const entry = await import('../ordinary-local-vertex-entry.js');
  const sessionId = x.f.reservation.conversationId;
  cleanups.push(() =>
    x.chat.registry.findBySessionId(sessionId)?.session.ordinaryRuntimeOwner?.close(),
  );
  return () =>
    entry.startOwnedLocalVertexCommand(
      { send: x.sent, isOpen: () => false },
      `${ownerConnectionId}:${sessionId}`,
      {
        command: x.f.request,
        reservation: x.f.reservation,
        // Login-bound authority retained by the HTTP entry for this operation.
        operatorConnectionId: x.f.dependencies.operatorConnectionId,
        // The phone stream that sent the command; never an authority.
        ownerConnectionId,
        ownerAuthSessionId: x.f.auth.id,
      },
    );
}

it('starts Claude through the owned entry after the sending stream closed before registration', async () => {
  const x = await fixture(false, true);
  // The stream reconnected under a new ID, so this one is no longer bound to the login.
  const closedStream = 'conn-closed-before-registration';
  const start = await ownedEntry(x, closedStream);
  const result = await start();
  expect(result.sessionId).toBe(x.f.reservation.conversationId);
  const session = x.chat.registry.findBySessionId(result.sessionId)!.session;
  // Attachment still names the sending stream so its reconnect can reattach.
  expect(session.ownerConnectionId).toBe(closedStream);
  expect(session.ownedLocalAuthSessionId).toBe(x.f.auth.id);
  await vi.waitFor(() => expect(x.inputs).toHaveLength(1));
}, 20_000);

it('keeps the original cause and failing stage when owned Claude startup fails', async () => {
  const x = await fixture(false, true);
  const start = await ownedEntry(x, 'conn-startup-failure');
  vi.spyOn(x.chat.eventStore, 'reserveOrdinaryStartup').mockImplementation(() => {
    throw Error('ORIGINAL_STARTUP_CAUSE');
  });
  const failure: unknown = await start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Owned Local Claude runtime unavailable');
  expect(((failure as Error).cause as Error).message).toBe('ORIGINAL_STARTUP_CAUSE');
  const { runtimeFailureDiagnostics } = await import('../runtime-failure-diagnostics.js');
  expect(runtimeFailureDiagnostics(failure).authorityChecks).toContain('claude.owned_startup');
}, 20_000);

it('refuses owned Claude startup when the retained operator login is revoked', async () => {
  const x = await fixture(false, true);
  const start = await ownedEntry(x, 'conn-revoked-login');
  // Logout or expiry removes the operation's own binding; a stream ID cannot restore it.
  x.f.detach();
  await expect(start()).rejects.toThrow();
  expect(x.calls).toEqual([]);
}, 20_000);

it('reports a logout between worktree creation and registration as auth_revoked', async () => {
  const x = await fixture(false, true);
  const start = await ownedEntry(x, 'conn-logout-during-startup');
  const { revokeAuthSession } = await import('../auth.js');
  const claim = x.f.workspace.claimReservedHostTask.bind(x.f.workspace);
  vi.spyOn(x.f.workspace, 'claimReservedHostTask').mockImplementation(async (...args) => {
    const claimed = await claim(...args);
    revokeAuthSession(x.f.auth);
    return claimed;
  });
  const failure: unknown = await start().catch((error: unknown) => error);
  // The closed owner keeps the classified login loss, not a bare "unavailable".
  const { findSessionRuntimeError } = await import('../session-runtime-error.js');
  expect(findSessionRuntimeError(failure)?.code).toBe('auth_revoked');
  expect(x.chat.registry.findBySessionId(x.f.reservation.conversationId)).toBeFalsy();
  expect(x.calls).toEqual([]);
}, 20_000);
