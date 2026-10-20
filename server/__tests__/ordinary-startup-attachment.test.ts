import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response, Router } from 'express';
import type { WebSocket } from 'ws';
import { ConnectionRegistry, type SessionTransport } from '@mitzo/harness';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { SseTransport } from '../sse-transport.js';
import { WsTransport } from '../ws-transport.js';

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: sdk.query,
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
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

let root: string;
let chat: typeof import('../chat.js');
let ws: typeof import('../ws-handler-v2.js');
let streams: SessionSseRegistry;
let connections: ConnectionRegistry;
let finish: () => void;
const changes = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  sdk.query.mockReset();
  changes.mockClear();
  root = await mkdtemp(join(tmpdir(), 'mitzo-ordinary-attachment-'));
  execFileSync('git', ['init', '-q', root]);
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_ENABLED', '0');
  vi.stubEnv('MITZO_ACCOUNT_PROFILES_FILE', '');
  vi.stubEnv('MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'Offline boot' } })),
    ),
  );
  chat = await import('../chat.js');
  ws = await import('../ws-handler-v2.js');
  streams = new SessionSseRegistry();
  connections = new ConnectionRegistry();
  chat.setConnectionRegistry(connections);
  chat.setSessionChangeCallback(changes);
});
afterEach(async () => {
  finish?.();
  if (chat) await vi.waitFor(() => expect([...chat.registry.entries()]).toHaveLength(0));
  streams?.destroy();
  chat?.eventStore.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function attachment(kind: 'SSE' | 'WS', connectionId: string) {
  let close: () => void;
  let transport: SessionTransport;
  if (kind === 'SSE') {
    streams.add(
      connectionId,
      {
        write: vi.fn(() => true),
        end: vi.fn(),
        writableEnded: false,
      } as unknown as Response,
      'offline-ordinary-login',
    );
    transport = new SseTransport(connectionId, streams);
    close = () => streams.remove(connectionId);
  } else {
    const socket = { readyState: 1, OPEN: 1, send: vi.fn() };
    transport = new WsTransport(socket as unknown as WebSocket);
    close = () => {
      socket.readyState = 3;
    };
  }
  connections.register(connectionId, transport);
  return {
    transport,
    close: () => {
      close();
      connections.remove(connectionId);
    },
  };
}

async function startOrdinary(kind: 'SSE' | 'WS', resume: boolean, rest = false) {
  let sessionId = randomUUID();
  const connectionId = `ordinary:${randomUUID()}`;
  const clientMsgId = randomUUID();
  let resolve!: () => void;
  const held = new Promise<void>((done) => {
    resolve = done;
  });
  finish = resolve;
  sdk.query.mockImplementation((args) => {
    if (rest && !resume) sessionId = args.options.sessionId;
    expect(resume ? args.options.resume : args.options.sessionId).toBe(sessionId);
    return (async function* () {
      yield {
        type: 'assistant',
        session_id: sessionId,
        message: { id: 'offline', content: [], usage: {} },
      };
      await held;
      yield {
        type: 'result',
        session_id: sessionId,
        subtype: 'success',
        usage: {},
        total_cost_usd: 0,
        num_turns: 1,
      };
    })();
  });
  if (resume) {
    chat.eventStore.upsertSession({ sessionId, cwd: root, mode: 'agent' });
    chat.eventStore.setSessionState(sessionId, 'ENDED', { force: true });
  }
  const original = attachment(kind, connectionId);
  const command = {
    type: 'send' as const,
    sessionId: resume ? sessionId : null,
    clientMsgId,
    prompt: 'Offline ordinary task',
    cwd: root,
    isolation: false,
  };
  const context = {
    sessionRegistry: chat.registry,
    connRegistry: connections,
    eventStore: chat.eventStore,
    nativeCommands: {
      execute: vi.fn(),
    } as unknown as import('../ws-handler-v2.js').V2HandlerContext['nativeCommands'],
  };
  if (rest) {
    const { createChatRestRouter } = await import('../chat-rest-handler.js');
    const router = createChatRestRouter(streams, context);
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      let status = 200;
      const req = {
        method: 'POST',
        url: '/send',
        path: '/send',
        originalUrl: '/api/chat/send',
        headers: { 'x-connection-id': connectionId },
        body: command,
      } as unknown as Request;
      const res = {
        locals: { authSession: { id: 'offline-ordinary-login' } },
        status(code: number) {
          status = code;
          return this;
        },
        json(body: unknown) {
          resolve({ status, body });
          return this;
        },
      } as unknown as Response;
      (
        router as Router & {
          handle(req: Request, res: Response, next: (error?: unknown) => void): void;
        }
      ).handle(req, res, (error) => reject(error ?? Error('Unmatched route')));
    });
    expect(response).toEqual({
      status: 202,
      body: {
        ok: true,
        accepted: true,
        clientMsgId,
        sessionId,
        // SDK resume echoes the durable prompt before admission; a new SDK
        // query has not retained its initial user event at this boundary.
        ...(resume ? { retained: true } : {}),
      },
    });
  } else {
    await ws.handleSendV2(connectionId, original.transport, command, context, {
      initialSessionId: resume ? undefined : sessionId,
      awaitStartupAdmission: true,
    });
  }
  await vi.waitFor(() =>
    expect(connections.get(connectionId)?.watchedSessions.has(sessionId)).toBe(true),
  );
  const driver = chat.registry.findBySessionId(sessionId)!;
  expect(driver.session.transport).not.toBe(original.transport);
  expect(sdk.query).toHaveBeenCalledOnce();
  expect(driver.session.queryInstance).toBeTruthy();
  return { sessionId, clientMsgId, original, driver };
}

it.each([
  ['SSE', false],
  ['SSE', true],
  ['WS', false],
  ['WS', true],
] as const)(
  'ordinary %s startup (resume: %s) detaches the actual connection through its send wrapper',
  async (kind, resume) => {
    const { sessionId, original, driver } = await startOrdinary(kind, resume);
    const query = driver.session.queryInstance;
    original.close();
    expect(chat.detachChatIfCurrentTransport(driver.clientId, original.transport)).toBe(true);
    expect(chat.registry.isAttached(driver.clientId)).toBe(false);
    expect(chat.eventStore.getSessionState(sessionId)).toBe('DETACHED');
    expect(changes).toHaveBeenCalledWith(driver.clientId, 'detach', sessionId);
    expect(driver.session.queryInstance).toBe(query);
    expect(driver.session.abortController.signal.aborted).toBe(false);
    const replacement = attachment(kind, `replacement:${randomUUID()}`);
    expect(chat.reattachChat(driver.clientId, replacement.transport)).toBe(true);
    expect(chat.detachChatIfCurrentTransport(driver.clientId, original.transport)).toBe(false);
    expect(chat.registry.isAttached(driver.clientId)).toBe(true);
    chat.registry.suspend(driver.clientId, 0);
    chat.eventStore.setSessionState(sessionId, 'SUSPENDED', { clientId: driver.clientId });
    replacement.close();
    expect(chat.detachChatIfCurrentTransport(driver.clientId, replacement.transport)).toBe(false);
    expect(chat.registry.isSuspended(driver.clientId)).toBe(true);
    expect(chat.eventStore.getSessionState(sessionId)).toBe('SUSPENDED');
  },
);

it.each(['SSE', 'WS'] as const)(
  'ordinary %s completion after disconnect records an unattended notification',
  async (kind) => {
    const notifications = await import('../notification-center.js');
    const record = vi.spyOn(notifications, 'recordTurnNotification');
    const { sessionId, original, driver } = await startOrdinary(kind, false);
    original.close();
    expect(chat.detachChatIfCurrentTransport(driver.clientId, original.transport)).toBe(true);
    expect(chat.registry.isAttached(driver.clientId)).toBe(false);
    expect(chat.eventStore.getSessionState(sessionId)).toBe('DETACHED');
    finish();
    await vi.waitFor(() => expect(record).toHaveBeenCalled());
    expect(record).toHaveBeenCalledWith(
      sessionId,
      expect.any(Number),
      expect.any(String),
      undefined,
      true,
    );
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
    expect(sdk.query).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  'ordinary REST/SSE startup (resume: %s) detaches and records unattended completion through both decorators',
  async (resume) => {
    const notifications = await import('../notification-center.js');
    const record = vi.spyOn(notifications, 'recordTurnNotification');
    const { sessionId, clientMsgId, original, driver } = await startOrdinary('SSE', resume, true);
    const receipt = chat.eventStore.getSendCommand(clientMsgId);
    const query = driver.session.queryInstance;
    expect(receipt).toMatchObject({ sessionId, error: null });
    original.close();
    expect(chat.detachChatIfCurrentTransport(driver.clientId, original.transport)).toBe(true);
    expect(chat.registry.isAttached(driver.clientId)).toBe(false);
    expect(chat.eventStore.getSessionState(sessionId)).toBe('DETACHED');
    expect(changes).toHaveBeenCalledWith(driver.clientId, 'detach', sessionId);
    expect(driver.session.queryInstance).toBe(query);
    expect(driver.session.abortController.signal.aborted).toBe(false);
    finish();
    await vi.waitFor(() => expect(record).toHaveBeenCalled());
    expect(record).toHaveBeenCalledWith(
      sessionId,
      expect.any(Number),
      expect.any(String),
      undefined,
      true,
    );
    await vi.waitFor(() => expect(chat.registry.findBySessionId(sessionId)).toBeNull());
    expect(chat.eventStore.getSendCommand(clientMsgId)).toEqual(receipt);
    expect(sdk.query).toHaveBeenCalledOnce();
  },
);
