import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAuthSession, revokeAuthSession } from '../auth.js';
import { createTerminalRouter } from '../terminal-router.js';
function setup() {
  const service = {
    bindOwner: vi.fn(),
    open: vi.fn(async () => ({ id: 'term-owned' })),
    list: vi.fn(() => []),
    get: vi.fn(() => ({ id: 'term-owned' })),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/terminals',
    createTerminalRouter({
      service: service as never,
      authorize: (req, res, next) => {
        if (req.header('authorization') !== 'Bearer operator') {
          res.status(403).json({ error: 'Interactive operator authentication is required' });
          return;
        }
        res.locals.authSession = { id: 'login-a', expiresAt: Date.now() + 60000 };
        next();
      },
    }),
  );
  return { app, service };
}
describe('operator terminal API', () => {
  it('rejects agent/internal credentials and never starts a process', async () => {
    const { app, service } = setup();
    await request(app).post('/api/terminals').set('x-internal-token', 'agent').send({}).expect(403);
    expect(service.open).not.toHaveBeenCalled();
  });
  it('accepts a conversation selector, never caller-supplied paths or sandbox commands', async () => {
    const { app, service } = setup();
    await request(app)
      .post('/api/terminals')
      .set('authorization', 'Bearer operator')
      .send({ sessionId: 'chat-a' })
      .expect(201);
    expect(service.open).toHaveBeenCalledWith('login-a', { sessionId: 'chat-a' });
    expect(service.bindOwner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'login-a', expiresAt: expect.any(Number) }),
      expect.any(Function),
    );
    await request(app)
      .post('/api/terminals')
      .set('authorization', 'Bearer operator')
      .send({ cwd: '/etc', command: 'sh' })
      .expect(400);
    expect(service.open).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin commands and oversized input', async () => {
    const { app, service } = setup();
    await request(app)
      .post('/api/terminals/term-owned/input')
      .set('authorization', 'Bearer operator')
      .set('origin', 'https://untrusted.test')
      .send({ data: 'id\r' })
      .expect(403);
    await request(app)
      .post('/api/terminals/term-owned/input')
      .set('authorization', 'Bearer operator')
      .send({ data: 'x'.repeat(65537) })
      .expect(400);
    expect(service.write).not.toHaveBeenCalled();
  });
  it('requires a deliberate write and distinguishes it from selection or listing', async () => {
    const { app, service } = setup();
    await request(app).get('/api/terminals').set('authorization', 'Bearer operator').expect(200);
    expect(service.write).not.toHaveBeenCalled();
    await request(app)
      .post('/api/terminals/term-owned/input')
      .set('authorization', 'Bearer operator')
      .send({ data: 'pwd\r' })
      .expect(200);
    expect(service.write).toHaveBeenCalledWith(
      'login-a',
      'term-owned',
      'pwd\r',
      expect.objectContaining({ signal: expect.any(AbortSignal), expiresAt: expect.any(Number) }),
    );
  });
  it('does not disclose private exception messages in failures', async () => {
    const { app, service } = setup();
    service.open.mockRejectedValue(Error('private-secret'));
    const response = await request(app)
      .post('/api/terminals')
      .set('authorization', 'Bearer operator')
      .send({})
      .expect(409);
    expect(JSON.stringify(response.body)).not.toContain('private-secret');
  });
});

it('binds output transport to operator logout and expiry', async () => {
  const release = vi.fn();
  let subscribed = false;
  const app = express();
  app.use(
    '/api/terminals',
    createTerminalRouter({
      authorize: (_req, res, next) => {
        res.locals.authSession = { id: 'stream-login', expiresAt: Date.now() + 60000 };
        next();
      },
      service: {
        bindOwner: vi.fn(),
        get: () => ({}),
        subscribe: async (_owner: string, _id: string, listener: (event: unknown) => void) => {
          subscribed = true;
          listener({ type: 'snapshot', data: 'private', seq: 1 });
          return release;
        },
      } as never,
      observeAuth: registerAuthSession,
    }),
  );
  const response = request(app).get('/api/terminals/term-owned/events').buffer(false);
  const done = new Promise<void>((resolve, reject) => {
    response.end((error) => (error ? reject(error) : resolve()));
    response.on('response', () => {
      revokeAuthSession({ id: 'stream-login', expiresAt: Date.now() + 60000 });
    });
  });
  await done;
  expect(subscribed).toBe(true);
  expect(release).toHaveBeenCalled();
});

it('exposes only server supplied adviser accounts and explicit reviewed context', async () => {
  const ask = vi.fn(async () => ({ text: 'Try pwd', commands: ['pwd'] }));
  const app = express();
  app.use(express.json());
  app.use(
    '/api/terminals',
    createTerminalRouter({
      authorize: (_req, res, next) => {
        res.locals.authSession = { id: 'advice-login', expiresAt: Date.now() + 60000 };
        next();
      },
      service: { bindOwner: vi.fn(), get: vi.fn(() => ({ id: 'owned' })) } as never,
      adviser: { ask } as never,
      accounts: async () => [
        { id: 'work', label: 'Work', models: [{ id: 'luna', label: 'Luna' }] },
      ],
    }),
  );
  await request(app).get('/api/terminals/accounts').expect(200);
  await request(app)
    .post('/api/terminals/owned/advice')
    .send({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'user', content: 'help' }],
      output: 'reviewed',
    })
    .expect(200);
  expect(ask).toHaveBeenCalledWith(
    'advice-login',
    expect.objectContaining({ output: 'reviewed' }),
    expect.any(AbortSignal),
  );
  await request(app)
    .post('/api/terminals/owned/advice')
    .send({
      accountId: 'work',
      model: 'luna',
      messages: [{ role: 'user', content: 'help' }],
      readTerminal: true,
    })
    .expect(400);
  expect(ask).toHaveBeenCalledTimes(1);
});
