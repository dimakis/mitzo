import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountProfiles } from '../account-profiles.js';
import { createOutputContributors } from '../output-contributors.js';
import { authorizeOrdinaryContributorStart } from '../ordinary-contributor-execution.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import { ConnectionRegistry } from '@mitzo/harness';
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

let chat: typeof import('../chat.js');
let ws: typeof import('../ws-handler-v2.js');
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-contributor-stop-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  writeFileSync(join(root, 'mcp.json'), '{"mcpServers":{}}');
  vi.stubEnv('MCP_CONFIG_PATH', join(root, 'mcp.json'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in Stop fixture');
    }),
  );
  chat = await import('../chat.js');
  ws = await import('../ws-handler-v2.js');
});
afterAll(() => {
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('rejects ordinary child controls on the actual parsed WebSocket path, then confirms owner Stop and resumes the same child', async () => {
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
  const selected = profiles.resolve('personal', 'offline-model');
  const closes: ReturnType<typeof vi.fn>[] = [];
  let turn = 0;
  const port: OrdinaryChatPort = {
    stopChat: chat.stopChat,
    startChat: vi.fn(async (_transport, clientId, _prompt, options) => {
      const child = options.resume ?? options.initialSessionId!;
      const rawTurn = `turn-${++turn}`;
      store.upsertSession({
        sessionId: child,
        conversationSource: 'mitzo',
        cwd: root,
        accountBinding: selected,
      });
      store.append(child, 'workspace_retention', { policy: 'external-owner' });
      authorizeOrdinaryContributorStart(store, child, options.contributorExecution);
      chat.registry.register(clientId, {
        transport: _transport,
        abortController: new AbortController(),
        sessionId: child,
        sessionAllowList: new Set(),
        mode: 'ask',
        cwd: root,
        accountBinding: selected,
        ownerConnectionId: 'browser',
      });
      const session = chat.registry.get(clientId)!;
      let release!: () => void;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const close = vi.fn(() => release());
      closes.push(close);
      session.inputQueue = { push: vi.fn(), close: vi.fn() };
      session.queryInstance = {
        close,
        stopTask: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {
          options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, rawTurn, 'interrupted');
          options.onTurnResult?.({});
          release();
        }),
      };
      options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
      options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'raw-thread', rawTurn);
      options.onQueryReady?.(session.queryInstance);
      if (turn > 1) {
        options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, rawTurn, 'completed');
        options.onTurnResult?.({});
      }
      await closed;
    }),
  };
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
  await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledOnce());
  const child = (await service.list('source')).contributors[0].sessionId!;
  const before = store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor');
  try {
    const active = chat.registry.findBySessionId(child)!;
    expect(() => chat.stopOrdinaryChat(active.clientId)).toThrow(/directed messages/);
    expect(() => chat.closeSessionByUser(active.clientId)).toThrow(/directed messages/);
    // Public controls must not invoke native commands, close a zombie query, or queue closeout.
    const native = vi.spyOn(ctx.nativeCommands, 'execute');
    const savedQueue = chat.registry.findBySessionId(child)!.session!.inputQueue;
    chat.registry.findBySessionId(child)!.session!.inputQueue = undefined;
    for (const [control, message] of [
      ['stop', { type: 'stop', sessionId: child }],
      ['send', { type: 'send', sessionId: child, prompt: '/skills', clientMsgId: 'public-send' }],
      [
        'interrupt',
        { type: 'interrupt', sessionId: child, prompt: 'Replace', clientMsgId: 'public-interrupt' },
      ],
      ['close', { type: 'session_close', sessionId: child }],
    ] as const) {
      await ws.dispatchV2Message('browser', transport, JSON.stringify(message), ctx);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'session_control_rejected', sessionId: child, control }),
      );
      expect(sent.some((event) => event.type === 'error')).toBe(false);
      expect(closes[0]).not.toHaveBeenCalled();
      expect(chat.registry.findBySessionId(child)).toBeDefined();
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toEqual(
        before,
      );
    }
    expect(native).not.toHaveBeenCalled();
    expect(store.getSendCommand('public-send')).toBeUndefined();
    chat.registry.findBySessionId(child)!.session!.inputQueue = savedQueue;
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
    expect(vi.mocked(port.startChat).mock.calls[1][3].resume).toBe(child);
    const close = vi.fn();
    chat.registry.register('settled-child', {
      transport,
      abortController: new AbortController(),
      sessionId: child,
      sessionAllowList: new Set(),
      mode: 'ask',
      cwd: root,
    });
    chat.registry.get('settled-child')!.queryInstance = {
      close,
      interrupt: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {}),
    };
    await ws.dispatchV2Message(
      'browser',
      transport,
      JSON.stringify({ type: 'stop', sessionId: child }),
      ctx,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(chat.registry.get('settled-child')).toBeUndefined();
  } finally {
    service.close();
  }
});

it('preserves ordinary Stop for an unowned query', async () => {
  const close = vi.fn();
  chat.eventStore.upsertSession({ sessionId: 'unowned', conversationSource: 'mitzo', cwd: root });
  chat.registry.register('plain', {
    transport: { send: vi.fn(), isOpen: () => true },
    abortController: new AbortController(),
    sessionId: 'unowned',
    sessionAllowList: new Set(),
    mode: 'ask',
    cwd: root,
  });
  chat.registry.get('plain')!.queryInstance = {
    close,
    interrupt: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
  };
  const transport = { send: vi.fn(), isOpen: () => true };
  const connections = new ConnectionRegistry();
  connections.register('browser', transport);
  await ws.dispatchV2Message(
    'browser',
    transport,
    JSON.stringify({ type: 'stop', sessionId: 'unowned' }),
    {
      eventStore: chat.eventStore,
      sessionRegistry: chat.registry,
      connRegistry: connections,
      nativeCommands: new NativeCommandRegistry(),
    },
  );
  expect(close).toHaveBeenCalledOnce();
  expect(chat.registry.get('plain')).toBeUndefined();
});
