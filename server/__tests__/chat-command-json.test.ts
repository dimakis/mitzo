import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { installChatCommandJson } from '../chat-command-json.js';

it.each([
  '/api/chat/runtime/send',
  '/api/chat/runtime/continue',
  '/api/chat/runtime/send/receipt',
  '/api/chat/local-codex/send',
  '/api/ordinary/workspaces/commands/first',
  '/api/ordinary/workspaces/commands/continue/receipt',
  '/api/sessions/offline-session/codex-queue/steer',
])('accepts an authenticated command above the old 10 MiB HTTP cap at %s', async (path) => {
  const app = express();
  installChatCommandJson(app, (req, res, next) => {
    if (req.headers.authorization !== 'offline-fixture') {
      res.sendStatus(401);
      return;
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.post(path, (req, res) => {
    res.json({ length: req.body.images[0].data.length });
  });
  const data = 'AAAA'.repeat(3 * 1024 * 1024);
  const response = await request(app)
    .post(path)
    .set('Authorization', 'offline-fixture')
    .send({
      requestId: 'offline-correction',
      targetCommandId: 'offline-command',
      text: 'Use this screenshot',
      images: [{ data, mediaType: 'image/png' }],
    });
  expect(response.status).toBe(200);
  expect(response.body.length).toBe(data.length);
  expect((await request(app).post(path).send({ images: [] })).status).toBe(401);
});

it.each(['/api/chat/runtime/send', '/api/sessions/offline-session/codex-queue/steer'])(
  'keeps ordinary 401 authentication semantics and rejects internal callers before parsing at %s',
  async (path) => {
    const { authMiddleware, operatorAuthMiddleware, login, authenticateToken, revokeAuthSession } =
      await import('../auth.js');
    const { INTERNAL_TOKEN } = await import('../internal-token.js');
    const app = express();
    installChatCommandJson(app, authMiddleware, operatorAuthMiddleware);
    app.post(path, (_req, res) => {
      res.sendStatus(204);
    });
    const token = (await login(process.env.AUTH_PASSPHRASE!))!;
    const actor = (await authenticateToken(token))!;
    expect(
      (
        await request(app)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ text: 'Offline' })
      ).status,
    ).toBe(204);
    expect(
      (await request(app).post(path).set('Content-Type', 'application/json').send('{broken'))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(path)
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .set('Content-Type', 'application/json')
          .send('{broken')
      ).status,
    ).toBe(403);
    revokeAuthSession(actor);
    expect(
      (
        await request(app)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .set('Content-Type', 'application/json')
          .send('{broken')
      ).status,
    ).toBe(401);
  },
);
