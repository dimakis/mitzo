import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellWarmPool } from '../openshell-warm-pool.js';
import { createWarmPoolRouter } from '../openshell-warm-pool-router.js';
let root = '',
  pool: OpenShellWarmPool | undefined;
afterEach(() => {
  pool?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(physicalInventory?: (signal: AbortSignal) => Promise<unknown>) {
  root = mkdtempSync(join(tmpdir(), 'pool-router-'));
  const prepare = vi.fn();
  pool = new OpenShellWarmPool(join(root, 'pool.db'), {
    scope: 'one',
    available: true,
    reason: null,
    prepare,
    inspect: async () => undefined,
    remove: async () => {},
    bind: async () => {},
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sandboxes',
    createWarmPoolRouter({
      pool: () => pool!,
      authorize: (req, res, next) => {
        if (req.header('operator') !== 'yes') return res.sendStatus(403);
        res.locals.authSession = { id: 'operator-one' };
        next();
      },
      conversations: () => [],
      physicalInventory,
    }),
  );
  return { app, prepare };
}
it('requires operator authorization even for inventory and never provisions on GET', async () => {
  const f = fixture();
  await request(f.app).get('/api/sandboxes').expect(403);
  const r = await request(f.app).get('/api/sandboxes').set('operator', 'yes').expect(200);
  expect(r.body.settings.enabled).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
});
it('reports the physical gateway count separately from pool and conversation ledgers', async () => {
  const physicalInventory = vi.fn(async () => ({
    available: true,
    total: 122,
    counts: { Ready: 42, Stopped: 74, Error: 6 },
    items: [],
  }));
  const f = fixture(physicalInventory);
  const r = await request(f.app).get('/api/sandboxes').set('operator', 'yes').expect(200);
  expect(r.body.physicalInventory.total).toBe(122);
  expect(f.prepare).not.toHaveBeenCalled();
});
it('reports unknown physical count on gateway failure while retaining recorded inventory', async () => {
  const f = fixture(async () => {
    throw Error('offline');
  });
  const r = await request(f.app).get('/api/sandboxes').set('operator', 'yes').expect(200);
  expect(r.body.physicalInventory.available).toBe(false);
  expect(r.body.physicalInventory.total).toBeUndefined();
  expect(r.body.settings).toBeDefined();
});
it('validates saves, persists configuration and rejects stale writes', async () => {
  const f = fixture(),
    body = {
      action: 'settings',
      revision: 0,
      requestId: 'first',
      settings: { ...pool!.snapshot().settings, capacity: 2 },
    };
  await request(f.app).post('/api/sandboxes').set('operator', 'yes').send(body).expect(200);
  expect(pool!.snapshot().settings.capacity).toBe(2);
  await request(f.app)
    .post('/api/sandboxes')
    .set('operator', 'yes')
    .send({ ...body, requestId: 'second' })
    .expect(409);
  await request(f.app)
    .post('/api/sandboxes')
    .set('operator', 'yes')
    .send({ ...body, settings: { ...body.settings, diskGiB: 40 } })
    .expect(400);
  expect(f.prepare).not.toHaveBeenCalled();
});
it('does not accept an internal agent token as operator authorization', async () => {
  const f = fixture();
  await request(f.app)
    .post('/api/sandboxes')
    .set('x-internal-token', 'fixture')
    .send({ action: 'prepare', revision: 0, requestId: 'agent' })
    .expect(403);
  expect(f.prepare).not.toHaveBeenCalled();
});
