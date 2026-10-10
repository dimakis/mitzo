import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Response } from 'express';
import { ConnectionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { createChatRestRouter } from '../chat-rest-handler.js';
import { dispatchV2Message, type V2HandlerContext } from '../ws-handler-v2.js';
import { stopChat, startChat, closeSessionByUser } from '../chat.js';
import type { NativeCommandContext } from '../native-commands.js';

vi.mock('../chat.js', () => ({
  startChat: vi.fn(async (_transport, _client, _prompt, options) =>
    options?.onStartupAdmission?.(),
  ),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  preflightChatCommand: vi.fn(),
  preflightStartupProviderCommand: vi.fn(),
  nativeStartupSessionId: vi.fn(),
  stopChat: vi.fn(),
  closeSessionByUser: vi.fn(),
  isActive: vi.fn(() => true),
  reattachChat: vi.fn(),
  BASE_REPO: '/offline',
}));
vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn(() => ({ get: () => undefined })),
  isAllowedPath: vi.fn(),
  NATIVE_COMMAND_NAMES: new Set(['skills', 'deliberate']),
}));

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function fixture(live = true) {
  const store = new EventStore(':memory:');
  cleanup.push(() => store.close());
  store.upsertSession({ sessionId: 'child' });
  store.append('child', 'contributor_execution', {
    coordinatorSessionId: 'coordinator',
    deliveryId: 'delivery',
    seatId: 'contributor',
    claimToken: 'claim',
    idempotencyKey: 'recipient',
    childSessionId: 'child',
  });
  const unsettled = vi
    .spyOn(store, 'getUnsettledSymposiumSeatExecutions')
    .mockReturnValue([{ attemptId: 1, claimToken: 'claim', idempotencyKey: 'recipient' }]);
  const transport = { send: vi.fn(), isOpen: () => true };
  const connRegistry = new ConnectionRegistry();
  connRegistry.register('viewer', transport);
  connRegistry.watch('viewer', 'child');
  connRegistry.setActive('viewer', 'parent');
  const sessionRegistry = {
    findBySessionId: vi.fn((id: string) =>
      live ? { clientId: `driver:${id}`, session: { ownerConnectionId: 'viewer' } } : null,
    ),
    isAttached: vi.fn(() => true),
  };
  const nativeCommands = {
    execute: vi.fn(
      async (name: string, _args: string, _registry: unknown, context: NativeCommandContext) => {
        context.deliberation?.onAdmitted();
        return { command: name, content: 'Offline native command' };
      },
    ),
  };
  const ctx = {
    eventStore: store,
    connRegistry,
    sessionRegistry,
    nativeCommands,
  } as unknown as V2HandlerContext;
  const sse = new SessionSseRegistry();
  sse.add(
    'viewer',
    { write: vi.fn(), end: vi.fn(), writableEnded: false } as unknown as Response,
    'owner',
  );
  cleanup.unshift(() => sse.remove('viewer'));
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'owner' };
    next();
  });
  app.use('/api/chat', createChatRestRouter(sse, ctx));
  const post = (body: object, path = '/stop') =>
    request(app).post(`/api/chat${path}`).set('x-connection-id', 'viewer').send(body);
  return { store, unsettled, transport, connRegistry, sessionRegistry, nativeCommands, ctx, post };
}

it.each([true, false])(
  'rejects public child Stop without touching the owned query or subscriptions (live registry %s)',
  async (live) => {
    const { store, transport, connRegistry, ctx, post } = fixture(live);
    const before = store.getSessionEvents('child');
    const message = { type: 'stop', sessionId: 'child' };
    await dispatchV2Message('viewer', transport, JSON.stringify(message), ctx);
    expect(stopChat).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        sessionId: 'child',
        error: expect.stringMatching(/contributor.*Stop|Stop.*contributor/),
      }),
    );
    const response = await post({ ...message, contributorExecution: { claimToken: 'claim' } });
    expect(response.status).toBe(409);
    expect(response.body.ok).toBe(false);
    expect(stopChat).not.toHaveBeenCalled();
    expect(store.getSessionEvents('child')).toEqual(before);
    expect(connRegistry.get('viewer')?.watchedSessions.has('child')).toBe(true);
    expect(store.getUnsettledSymposiumSeatExecutions('coordinator', 'contributor')).toHaveLength(1);
  },
);

it('preserves ordinary Stop and allows child Stop after exact cleanup is confirmed', async () => {
  const { unsettled, transport, ctx, post } = fixture();
  await dispatchV2Message(
    'viewer',
    transport,
    JSON.stringify({ type: 'stop', sessionId: 'ordinary' }),
    ctx,
  );
  expect(stopChat).toHaveBeenCalledWith('driver:ordinary');
  vi.mocked(stopChat).mockClear();
  unsettled.mockReturnValue([]);
  const response = await post({ type: 'stop', sessionId: 'child' });
  expect(response.status).toBe(200);
  expect(stopChat).toHaveBeenCalledWith('driver:child');
});

it.each(
  [
    { action: 'native send', type: 'send', prompt: '/deliberate improve the draft', path: '/send' },
    { action: 'zombie send', type: 'send', prompt: 'ordinary prompt', path: '/send' },
    {
      action: 'zombie interrupt',
      type: 'interrupt',
      prompt: 'ordinary prompt',
      path: '/interrupt',
    },
  ].flatMap((input) => ['ws', 'rest'].map((protocol) => ({ ...input, protocol }))),
)(
  'fences $action through $protocol before command admission, subscriptions or query close',
  async ({ action, type, prompt, path, protocol }) => {
    const { store, nativeCommands, transport, connRegistry, ctx, post } = fixture();
    store.setSessionState('child', 'ENDED', { force: true, reason: 'offline zombie fixture' });
    const events = store.getSessionEvents('child');
    const claim = vi.spyOn(store, 'claimClientCommand');
    const message = {
      type,
      sessionId: 'child',
      prompt,
      clientMsgId: `${protocol}-${action}`,
      mode: 'agent',
    };
    if (protocol === 'ws') {
      await dispatchV2Message('viewer', transport, JSON.stringify(message), ctx);
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.stringMatching(/contributor directed messages/),
        }),
      );
    } else {
      const response = await post(
        { ...message, contributorExecution: { claimToken: 'claim' } },
        path,
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/contributor directed messages/);
    }
    expect(claim).not.toHaveBeenCalled();
    expect(store.getSendCommand(message.clientMsgId)).toBeUndefined();
    expect(nativeCommands.execute).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
    expect(store.getSessionEvents('child')).toEqual(events);
    expect(connRegistry.get('viewer')?.activeSession).toBe('parent');
    expect([...connRegistry.get('viewer')!.watchedSessions]).toEqual(['child', 'parent']);
  },
);

it.each(['ws', 'rest'])(
  'rejects public child Close through %s before user closeout',
  async (protocol) => {
    const { store, transport, connRegistry, ctx, post } = fixture();
    const events = store.getSessionEvents('child');
    const message = { type: 'session_close', sessionId: 'child' };
    if (protocol === 'ws') {
      await dispatchV2Message('viewer', transport, JSON.stringify(message), ctx);
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_close_ack',
          accepted: false,
          reason: expect.stringMatching(/contributor/),
        }),
      );
    } else {
      const response = await post(message, '/close');
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/contributor/);
    }
    expect(closeSessionByUser).not.toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
    expect(store.getSessionEvents('child')).toEqual(events);
    expect(connRegistry.get('viewer')?.activeSession).toBe('parent');
    expect([...connRegistry.get('viewer')!.watchedSessions]).toEqual(['child', 'parent']);
  },
);

it('allows ordinary native sends and settled-child Close', async () => {
  const { unsettled, nativeCommands, transport, ctx } = fixture();
  await dispatchV2Message(
    'viewer',
    transport,
    JSON.stringify({
      type: 'send',
      sessionId: 'ordinary',
      prompt: '/skills',
      clientMsgId: 'ordinary-native',
      mode: 'agent',
    }),
    ctx,
  );
  expect(nativeCommands.execute).toHaveBeenCalledOnce();
  unsettled.mockReturnValue([]);
  nativeCommands.execute.mockClear();
  await dispatchV2Message(
    'viewer',
    transport,
    JSON.stringify({
      type: 'send',
      sessionId: 'child',
      prompt: '/skills',
      clientMsgId: 'settled-native',
      mode: 'agent',
    }),
    ctx,
  );
  expect(nativeCommands.execute).toHaveBeenCalledOnce();
  await dispatchV2Message(
    'viewer',
    transport,
    JSON.stringify({ type: 'session_close', sessionId: 'child' }),
    ctx,
  );
  expect(closeSessionByUser).toHaveBeenCalledWith('driver:child');
});
