import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosCrudRouter } from '../telos-crud-routes.js';
import { MitzoTelosStore } from '../telos-native-store.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
it('creates, lists and completes work through HTTP with no MGMT script or alternate database', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-http-'));
  roots.push(root);
  MitzoTelosStore.initialize(join(root, 'telos.db'));
  const app = express();
  app.use(express.json());
  app.use(
    createTelosCrudRouter({
      databasePath: () => join(root, 'telos.db'),
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = { id: 'operator' };
        next();
      },
    }),
  );
  const empty = await request(app).get('/api/todos');
  expect(empty.status).toBe(200);
  expect(empty.headers['cache-control']).toBe('private, no-store');
  expect(empty.body.profiles).toEqual(['manual']);
  const created = await request(app)
    .post('/api/todos')
    .send({ summary: 'Native item', profile: empty.body.profiles[0] });
  expect(created.status).toBe(201);
  const id = created.body.item.id;
  expect((await request(app).get('/api/todos')).body.items[0].id).toBe(id);
  expect(
    (await request(app).post(`/api/todos/${id}/action`).send({ action: 'priority', priority: 9 }))
      .status,
  ).toBe(200);
  expect((await request(app).get('/api/todos')).body.items[0].priority).toBe(9);
  expect(
    (await request(app).post(`/api/todos/${id}/action`).send({ action: 'done' })).body.ok,
  ).toBe(true);
  expect((await request(app).get('/api/todos?refresh=true')).status).toBe(400);
});
it('requires interactive authority for mutations', async () => {
  const app = express();
  app.use(express.json());
  app.use(
    createTelosCrudRouter({
      databasePath: () => {
        throw Error('must not open');
      },
      operatorAuth: (_req, res) => {
        res.sendStatus(401);
      },
    }),
  );
  expect(
    (await request(app).post('/api/todos').send({ summary: 'Denied', profile: 'manual' })).status,
  ).toBe(401);
});
