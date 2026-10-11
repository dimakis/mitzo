import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountProfiles } from '../account-profiles.js';
import { createOutputContributors } from '../output-contributors.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import { ConnectionRegistry } from '@mitzo/harness';
import { DETACHED_TTL_MS, CLOSEOUT_TIMEOUT_MS } from '@mitzo/harness';
import { registerPending, hasPending, removePending } from '../permissions.js';
import { NativeCommandRegistry } from '../native-commands.js';
import type { OrdinaryChatPort } from '../symposium-ordinary-turn.js';

vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('Real model calls are forbidden');
  }),
}));

vi.mock('../codex-app-server-client.js', async (original) => ({
  ...(await original<typeof import('../codex-app-server-client.js')>()),
  CodexAppServerClient: {
    launch: () => ({
      initialize: async () => {},
      close: () => {},
      request: async () => ({
        account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'plus' },
      }),
    }),
  },
}));
// Substitute only native account preflight and provider query; the trusted start,
// output orchestration, registry, query loop, viewer and permission routing are real.
const provider = vi.hoisted(() => ({ open: vi.fn(), closes: [] as ReturnType<typeof vi.fn>[] }));
vi.mock('../codex-chat-session.js', async (original) => ({
  ...(await original<typeof import('../codex-chat-session.js')>()),
  openCodexChat: provider.open,
}));
vi.mock('../agent-loader.js', () => ({
  loadAgentDef: async () => ({ definition: { identity: { description: 'Offline fixture' } } }),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: async () => {} }));

let chat: typeof import('../chat.js');
let ws: typeof import('../ws-handler-v2.js');
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-contributor-viewer-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
  writeFileSync(join(root, 'mcp.json'), '{"mcpServers":{}}');
  vi.stubEnv('MCP_CONFIG_PATH', join(root, 'mcp.json'));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/agents/') && url.endsWith('/context'))
        return Promise.resolve({
          ok: true,
          json: async () => ({ boot: { content: '', sources: [], tokens: 0, tokenBudget: 12000 } }),
        });
      throw Error('No network in viewer lifetime fixture');
    }),
  );
  chat = await import('../chat.js');
  ws = await import('../ws-handler-v2.js');
});
afterAll(() => {
  removePending('permission');
  chat?.registry.dispose();
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('retains the exact provider observer after opening, disconnecting and reopening a permission-blocked child beyond viewer TTL, then confirms owner Stop and resumes the child', async () => {
  const store = chat.eventStore;
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo', cwd: root });
  for (const event of [
    { type: 'message_start', messageId: 'draft' },
    { type: 'block_start', messageId: 'draft', blockId: 'text', blockType: 'text' },
    { type: 'block_delta', messageId: 'draft', blockId: 'text', delta: 'Selected draft' },
    { type: 'block_end', messageId: 'draft', blockId: 'text', blockType: 'text' },
    { type: 'message_end', messageId: 'draft' },
  ])
    store.append('source', event.type, event);
  const output = store.registerSessionOutput('source', {
    requestId: 'keep',
    title: 'Draft',
    source: store.listSessionOutputCandidates('source')[0].source,
  });
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: join(root, 'synthetic-account'),
        email: 'offline@example.invalid',
        planType: 'plus',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  const { AsyncQueue } = await import('@mitzo/protocol');
  let turn = 0;
  provider.open.mockImplementation(
    async (options: Parameters<typeof import('../codex-chat-session.js').openCodexChat>[0]) => {
      const events = new AsyncQueue<Record<string, unknown>>();
      const rawTurn = `turn-${++turn}`;
      const command = options.messageId!;
      options.ordinaryTurnLifecycle!.beforeDispatch(command);
      options.ordinaryTurnLifecycle!.accepted(command, 'raw-thread', rawTurn);
      events.push({ type: 'system', subtype: 'init', session_id: options.conversationId });
      const closeQueue = events.close.bind(events);
      const close = vi.fn(closeQueue);
      options.session.abortController.signal.addEventListener('abort', closeQueue, { once: true });
      provider.closes.push(close);
      const finish = (status: 'completed' | 'interrupted') => {
        options.ordinaryTurnLifecycle!.terminal(command, rawTurn, status);
        events.push({ type: 'result', session_id: options.conversationId, is_error: false });
      };
      if (turn > 1) {
        for (const event of [
          { type: 'message_start', message: { id: 'reply' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Continued in the retained child' },
          },
          { type: 'content_block_stop', index: 0 },
        ])
          events.push({ type: 'stream_event', event });
        finish('completed');
      }
      return Object.assign(events, {
        close,
        interrupt: vi.fn(async () => finish('interrupted')),
        stopTask: vi.fn(async () => {}),
      });
    },
  );
  const port: OrdinaryChatPort = { startChat: chat.startChat, stopChat: chat.stopChat };
  const service = createOutputContributors({
    store,
    databasePath: join(root, '.mitzo/events.db'),
    currentAccounts: () => profiles,
    port,
    workspaceForSession: () => ({ cwd: root }),
    resolveProfile: async () => null,
  });
  const sent: Record<string, unknown>[] = [];
  const transport = {
    send: (message: Record<string, unknown>) => sent.push(message),
    isOpen: () => true,
  };
  const connections = new ConnectionRegistry();
  connections.register('browser', transport);
  chat.setConnectionRegistry(connections);
  const ctx = {
    eventStore: store,
    sessionRegistry: chat.registry,
    connRegistry: connections,
    nativeCommands: new NativeCommandRegistry(),
  };
  const contributor = await service.add('source', {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'personal',
    model: 'offline-model',
    label: 'Writer',
    instructions: 'Improve selected output',
    mode: 'ask',
  });
  const first = service.message('source', contributor.id, { requestId: 'first', text: 'Improve' });
  await vi.waitFor(() => expect(provider.open).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(chat.registry.entries().next().value?.[1].queryInstance).toBeDefined(),
  );
  const child = (await service.list('source')).contributors[0].sessionId!;
  const before = store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor');
  try {
    const active = chat.registry.findBySessionId(child)!;
    const driverKey = active.clientId;
    const query = active.session.queryInstance;
    const approval = vi.fn();
    const request = {
      permId: 'permission',
      sessionId: child,
      toolName: 'Bash',
      toolInput: 'git status',
      tier: 'safe' as const,
    };
    registerPending(
      'permission',
      'Bash',
      approval,
      { command: 'git status' },
      'safe',
      child,
      request,
    );
    const queueInput = vi.spyOn(active.session.inputQueue!, 'push');
    await ws.dispatchV2Message(
      'browser',
      transport,
      JSON.stringify({ type: 'switch_session', sessionId: child }),
      ctx,
    );
    expect(active.session.ownerConnectionId).toBe('browser');
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'session_switched',
        sessionId: child,
        pendingPermissions: [request],
      }),
    );
    expect(hasPending('permission')).toBe(true);
    vi.useFakeTimers();
    chat.detachChat(driverKey);
    connections.remove('browser');
    await vi.advanceTimersByTimeAsync(DETACHED_TTL_MS + CLOSEOUT_TIMEOUT_MS);
    expect(chat.registry.get(driverKey)).toBe(active.session);
    expect(active.session.abortController.signal.aborted).toBe(false);
    expect(active.session.queryInstance).toBe(query);
    expect(provider.closes[0]).not.toHaveBeenCalled();
    expect(queueInput).not.toHaveBeenCalled();
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toEqual(
      before,
    );
    expect(hasPending('permission')).toBe(true);
    vi.useRealTimers();
    connections.register('reconnected', transport);
    await ws.dispatchV2Message(
      'reconnected',
      transport,
      JSON.stringify({ type: 'reconnect', sessions: [{ sessionId: child, lastSeq: 0 }] }),
      ctx,
    );
    expect(chat.registry.findBySessionId(child)?.clientId).toBe(driverKey);
    expect(active.session.ownerConnectionId).toBe('reconnected');
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'session_reconnect_snapshot',
        sessionId: child,
        pendingPermissions: [request],
      }),
    );
    expect(
      ws.handlePermissionResponseV2(
        'browser',
        { type: 'permission_response', permId: 'permission', sessionId: child, decision: 'once' },
        ctx,
      ),
    ).toBe(false);
    expect(
      ws.handlePermissionResponseV2(
        'reconnected',
        { type: 'permission_response', permId: 'permission', sessionId: child, decision: 'once' },
        ctx,
      ),
    ).toBe(true);
    expect(approval).toHaveBeenCalledOnce();
    expect((await service.stop('source', contributor.id, { requestId: 'owner-stop' })).status).toBe(
      'idle',
    );
    expect((await first).delivery.status).toBe('cancelled');
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      0,
    );
    const followup = await service.message('source', contributor.id, {
      requestId: 'followup',
      text: 'Continue',
    });
    expect(followup.delivery.status).toBe('delivered');
    expect(followup.delivery.recipients[0].resultContent).toBe('Continued in the retained child');
    expect(provider.open.mock.calls[1][0].conversationId).toBe(child);
    expect(provider.open.mock.calls[1][0].resume).toBe(true);
  } finally {
    vi.useRealTimers();
    service.close();
  }
});

it('rejects unproven contributor ownership before registering a query lifetime owner', async () => {
  const opens = provider.open.mock.calls.length;
  await expect(
    chat.startChat({ send: vi.fn(), isOpen: () => true }, 'unproven', 'Send', {
      initialSessionId: 'unproven-child',
      contributorExecution: {
        coordinatorSessionId: 'missing',
        deliveryId: 'missing',
        seatId: 'seat',
        claimToken: 'missing',
        idempotencyKey: 'missing',
      },
    }),
  ).rejects.toThrow('Exact contributor execution ownership is required');
  expect(chat.registry.get('unproven')).toBeUndefined();
  expect(provider.open.mock.calls).toHaveLength(opens);
});
