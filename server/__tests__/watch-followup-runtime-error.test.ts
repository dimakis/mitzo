import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { classifyProviderFailure } from '../provider-failure.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ConnectionRegistry } from '@mitzo/harness';
import { V2SendMessage } from '@mitzo/protocol';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../app.js', () => ({
  buildSkillRegistry: () => new Map(),
  isAllowedPath: () => true,
  NATIVE_COMMAND_NAMES: new Set(),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: async () => {} }));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(),
  deriveGoalTitle: vi.fn((prompt: string) => prompt),
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn() }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn() }));
vi.mock('../notification-center.js', () => ({
  recordTurnNotification: vi.fn(() => null),
  recordTurnFailureNotification: vi.fn(() => null),
}));

let root: string;
let chat: typeof import('../chat.js');
let ws: typeof import('../ws-handler-v2.js');
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-watch-followup-'));
  execFileSync('git', ['init', '-q', root]);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('/api/agents/') && url.endsWith('/context'))
        return Promise.resolve(
          new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'Offline boot' } })),
        );
      throw Error('Network forbidden in offline same-query fixture');
    }),
  );
  chat = await import('../chat.js');
  ws = await import('../ws-handler-v2.js');
});
afterAll(() => {
  chat?.registry.dispose();
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  'attributes a same-query iterator failure after accepted A and B with watchers=%s',
  async (watchers) => {
    vi.mocked(query).mockClear();
    const sessionId = randomUUID();
    const first = V2SendMessage.parse({
      type: 'send',
      sessionId: null,
      clientMsgId: randomUUID(),
      prompt: 'Initial A',
      cwd: root,
      isolation: false,
    });
    const second = V2SendMessage.parse({
      type: 'send',
      sessionId,
      clientMsgId: randomUUID(),
      prompt: 'Follow-up B',
    });
    const events: Record<string, unknown>[] = [];
    const transport = {
      isOpen: () => true,
      send: (event: Record<string, unknown>) => events.push(event),
    };
    const connections = new ConnectionRegistry();
    connections.register('watch-main', transport);
    chat.setConnectionRegistry(connections);
    const context = {
      connRegistry: connections,
      sessionRegistry: chat.registry,
      eventStore: chat.eventStore,
      nativeCommands: { execute: vi.fn() },
    } as unknown as import('../ws-handler-v2.js').V2HandlerContext;
    let releaseFailure!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const consumed: unknown[] = [];
    vi.mocked(query).mockImplementation((args) => {
      return (async function* () {
        const prompts = (args.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        consumed.push((await prompts.next()).value);
        yield { type: 'assistant', session_id: sessionId, message: { content: [] } };
        consumed.push((await prompts.next()).value);
        await gate;
        throw Error('Offline same-query iterator failed after B');
      })() as unknown as ReturnType<typeof query>;
    });
    try {
      // Supported REST/outbox admission supplies this stable initial SID. Actual
      // startChat/query-loop create STARTING/ACTIVE; the fixture never seeds state.
      await ws.handleSendV2('watch-main', transport, first, context, {
        initialSessionId: sessionId,
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'user_message',
            messageId: first.clientMsgId,
            sessionId,
          }),
        ),
      );
      expect(chat.eventStore.getSessionState(sessionId)).toBe('ACTIVE');
      const driver = chat.registry.findBySessionId(sessionId)!;
      expect(driver).toBeDefined();
      expect(connections.get('watch-main')?.activeSession).toBe(sessionId);
      await ws.handleSendV2('watch-main', transport, second, context);
      await vi.waitFor(() => expect(consumed).toHaveLength(2));
      expect(JSON.stringify(consumed[1])).toContain('Follow-up B');
      expect(query).toHaveBeenCalledOnce();
      expect(chat.registry.findBySessionId(sessionId)?.clientId).toBe(driver.clientId);
      for (const command of [first, second]) {
        expect(chat.eventStore.hasUserMessage(sessionId, command.clientMsgId)).toBe(true);
        expect(
          events.filter(
            (event) => event.type === 'user_message' && event.messageId === command.clientMsgId,
          ),
        ).toHaveLength(1);
      }
      if (!watchers) {
        connections.unwatch('watch-main', sessionId);
        expect(connections.hasOpenWatchers(sessionId)).toBe(false);
      }
      releaseFailure();
      await vi.waitFor(() =>
        expect(events).toContainEqual(expect.objectContaining({ type: 'session_end', sessionId })),
      );
      const errors = events.filter((event) => event.type === 'error');
      const output = process.env.MITZO_WATCH_FOLLOWUP_FIXTURE_OUTPUT;
      if (output)
        writeFileSync(
          output,
          JSON.stringify({ watchers, first, second, consumed, events }, null, 2) + '\n',
        );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        sessionId,
        error: 'Offline same-query iterator failed after B',
      });
      expect(errors[0]).not.toHaveProperty('clientMsgId');
      expect(
        chat.eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'error'),
      ).toHaveLength(1);
    } finally {
      releaseFailure();
      connections.remove('watch-main');
    }
  },
);

it('retains exact startup correlation for a known-session provider refusal before the first echo', async () => {
  vi.mocked(query).mockClear();
  const sessionId = randomUUID();
  const first = V2SendMessage.parse({
    type: 'send',
    sessionId: null,
    clientMsgId: randomUUID(),
    prompt: 'Before acceptance',
    cwd: root,
    isolation: false,
  });
  const events: Record<string, unknown>[] = [];
  const transport = {
    isOpen: () => true,
    send: (event: Record<string, unknown>) => events.push(event),
  };
  const connections = new ConnectionRegistry();
  connections.register('watch-startup', transport);
  chat.setConnectionRegistry(connections);
  const context = {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: { execute: vi.fn() },
  } as unknown as import('../ws-handler-v2.js').V2HandlerContext;
  const failure = classifyProviderFailure(
    { codex_error_info: 'server_overloaded', message: 'Offline startup refusal' },
    { correlationId: 'offline-startup' },
  );
  vi.mocked(query).mockImplementation(
    () =>
      (async function* () {
        yield { type: 'result', session_id: sessionId, is_error: true, provider_failure: failure };
      })() as unknown as ReturnType<typeof query>,
  );
  try {
    await ws.handleSendV2('watch-startup', transport, first, context, {
      initialSessionId: sessionId,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'session_end', sessionId })),
    );
    expect(query).toHaveBeenCalledOnce();
    expect(chat.eventStore.hasUserMessage(sessionId, first.clientMsgId)).toBe(false);
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(0);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sessionId,
      clientMsgId: first.clientMsgId,
      providerFailure: failure,
    });
  } finally {
    connections.remove('watch-startup');
  }
});

it('persists a resumed accepted input runtime failure even before its first SDK event', async () => {
  vi.mocked(query).mockClear();
  const sessionId = randomUUID();
  const first = V2SendMessage.parse({
    type: 'send',
    sessionId: null,
    clientMsgId: randomUUID(),
    prompt: 'Completed initial input',
    cwd: root,
    isolation: false,
  });
  const second = V2SendMessage.parse({
    type: 'send',
    sessionId,
    clientMsgId: randomUUID(),
    prompt: 'Explicit resume',
  });
  const events: Record<string, unknown>[] = [];
  const transport = {
    isOpen: () => true,
    send: (event: Record<string, unknown>) => events.push(event),
  };
  const connections = new ConnectionRegistry();
  connections.register('watch-resume', transport);
  chat.setConnectionRegistry(connections);
  const context = {
    connRegistry: connections,
    sessionRegistry: chat.registry,
    eventStore: chat.eventStore,
    nativeCommands: { execute: vi.fn() },
  } as unknown as import('../ws-handler-v2.js').V2HandlerContext;
  vi.mocked(query).mockImplementationOnce(
    () =>
      (async function* () {
        yield { type: 'assistant', session_id: sessionId, message: { content: [] } };
        yield { type: 'result', session_id: sessionId, is_error: false, usage: {} };
      })() as unknown as ReturnType<typeof query>,
  );
  vi.mocked(query).mockImplementationOnce((args) => {
    expect(args.options?.resume).toBe(sessionId);
    return (async function* () {
      yield* [];
      throw Error('Offline accepted resume failed before first event');
    })() as unknown as ReturnType<typeof query>;
  });
  try {
    await ws.handleSendV2('watch-resume', transport, first, context, {
      initialSessionId: sessionId,
    });
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
    expect(chat.eventStore.hasUserMessage(sessionId, first.clientMsgId)).toBe(true);
    expect(chat.eventStore.getSessionState(sessionId)).toBe('ENDED');
    await ws.handleSendV2('watch-resume', transport, second, context);
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'session_end')).toHaveLength(2),
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(chat.eventStore.hasUserMessage(sessionId, second.clientMsgId)).toBe(true);
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sessionId,
      error: 'Offline accepted resume failed before first event',
    });
    expect(errors[0]).not.toHaveProperty('clientMsgId');
    expect(
      chat.eventStore.getSessionEvents(sessionId).filter((event) => event.type === 'error'),
    ).toHaveLength(1);
  } finally {
    connections.remove('watch-resume');
  }
});
