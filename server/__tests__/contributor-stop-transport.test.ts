import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Response } from 'express';
import { ConnectionRegistry } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { SessionSseRegistry } from '../session-sse-registry.js';
import { createChatRestRouter } from '../chat-rest-handler.js';
import { dispatchV2Message, type V2HandlerContext } from '../ws-handler-v2.js';
import { stopChat } from '../chat.js';

vi.mock('../chat.js', () => ({
  startChat: vi.fn(),
  sendToChat: vi.fn(),
  interruptChat: vi.fn(),
  preflightChatCommand: vi.fn(),
  preflightStartupProviderCommand: vi.fn(),
  nativeStartupSessionId: vi.fn(),
  stopChat: vi.fn(),
  closeSessionByUser: vi.fn(),
  isActive: vi.fn(),
  reattachChat: vi.fn(),
  BASE_REPO: '/offline',
}));
vi.mock('../app.js', () => ({
  buildSkillRegistry: vi.fn(),
  isAllowedPath: vi.fn(),
  NATIVE_COMMAND_NAMES: new Set(),
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
  const sessionRegistry = {
    findBySessionId: vi.fn((id: string) =>
      live ? { clientId: `driver:${id}`, session: {} } : null,
    ),
  };
  const ctx = { eventStore: store, connRegistry, sessionRegistry } as unknown as V2HandlerContext;
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
  const post = (body: object) =>
    request(app).post('/api/chat/stop').set('x-connection-id', 'viewer').send(body);
  return { store, unsettled, transport, connRegistry, sessionRegistry, ctx, post };
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
