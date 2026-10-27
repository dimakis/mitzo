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
    .send({ images: [{ data }] });
  expect(response.status).toBe(200);
  expect(response.body.length).toBe(data.length);
  expect((await request(app).post(path).send({ images: [] })).status).toBe(401);
});
