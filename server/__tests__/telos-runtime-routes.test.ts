import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { createTelosTodoRouter, createTelosImportRouter } from '../telos-runtime-routes.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-api-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  const app = express();
  app.use(express.json());
  const authorize = vi.fn((_req, res, next) => {
    if (_req.headers['x-operator'] !== 'yes')
      return res.status(401).json({ error: 'Operator required' });
    next();
  });
  app.use(
    createTelosImportRouter({
      dbPath: () => path,
      token: () => 'private-import-token-at-least-32-bytes',
    }),
  );
  app.use(
    createTelosTodoRouter({
      dbPath: () => path,
      operatorAuth: authorize,
      project: (canonical) => canonical,
    }),
  );
  return { app, path };
}
describe('Mitzo-owned Telos HTTP routes', () => {
  it('creates, reads, filters and changes items with no MGMT checkout or Python process', async () => {
    const { app } = fixture();
    const created = await request(app)
      .post('/api/todos')
      .set('x-operator', 'yes')
      .send({ summary: 'Task', profile: 'work' });
    expect(created.status).toBe(201);
    const id = created.body.item.id;
    expect((await request(app).get('/api/todos?profile=personal')).body.items).toEqual([]);
    expect((await request(app).get('/api/todos?profile=work')).body.items[0]).toMatchObject({
      id,
      summary: 'Task',
    });
    expect(
      (
        await request(app)
          .post(`/api/todos/${id}/action`)
          .set('x-operator', 'yes')
          .send({ action: 'priority', priority: 8 })
      ).status,
    ).toBe(200);
    expect((await request(app).get('/api/todos')).body.items[0].priority).toBe(8);
  });
  it('requires operator authority for mutations and archive/trash, and refuses source refresh via GET', async () => {
    const { app } = fixture();
    expect(
      (await request(app).post('/api/todos').send({ summary: 'Task', profile: 'work' })).status,
    ).toBe(401);
    expect((await request(app).get('/api/todos?view=trash')).status).toBe(401);
    expect((await request(app).get('/api/todos?refresh=true')).status).toBe(400);
  });
  it('authenticates imports independently and refuses invalid batches without mutating items', async () => {
    const { app } = fixture();
    const body = { items: [{ id: 'seed', summary: 'Seed', profile: 'manual', sources: [] }] };
    expect((await request(app).post('/api/telos/import').send(body)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/telos/import')
          .set('Authorization', 'Bearer private-import-token-at-least-32-bytes')
          .send(body)
      ).body,
    ).toEqual({ ok: true, total: 1, created: 1 });
    expect(
      (
        await request(app)
          .post('/api/telos/import')
          .set('Authorization', 'Bearer private-import-token-at-least-32-bytes')
          .send({ items: [{ ...body.items[0], status: 'active' }] })
      ).status,
    ).toBe(400);
    expect((await request(app).get('/api/todos')).body.items).toHaveLength(1);
  });
  it('reports missing storage honestly instead of returning a successful empty list', async () => {
    const { app, path } = fixture();
    rmSync(path);
    expect((await request(app).get('/api/todos')).status).toBe(503);
  });
});
