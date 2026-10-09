import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTerminalRouter } from '../terminal-router.js';
function setup() {
  const service = {
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
        res.locals.authSession = { id: 'login-a' };
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
    expect(service.write).toHaveBeenCalledWith('login-a', 'term-owned', 'pwd\r');
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
