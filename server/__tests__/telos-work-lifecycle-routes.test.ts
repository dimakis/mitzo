import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Server } from 'node:http';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { revokeAuthSession } from '../auth.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

const servers: Server[] = [];
const closes: Array<() => void> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeTestServer(server);
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
async function fixture() {
  const canonical = createTelosCanonicalData();
  closes.push(() => canonical.close());
  const authorization = {
    id: `lifecycle-operator-${Math.random()}`,
    expiresAt: Date.now() + 60000,
  };
  const assertLifecycleQuiescent = vi.fn<(itemId: string, original: TelosWorkStore) => void>(
    () => {},
  );
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath: () => canonical.dbPath,
      operatorAuth: (req, res, next) => {
        if (req.headers['x-operator'] !== 'interactive') {
          res.status(403).json({ error: 'Operator required' });
          return;
        }
        res.locals.authSession = authorization;
        next();
      },
      ordinaryConversation: () => true,
      verifyInternal: (req) => req.headers['x-internal-token'] === 'internal',
      sessionId: () => 'planning',
      assertLifecycleQuiescent,
    }),
  );
  const server = await listenOnLoopback(app);
  servers.push(server);
  const post = (body: object) =>
    request(server).post('/api/telos/work/lifecycle').set('x-operator', 'interactive').send(body);
  const read = () =>
    request(server).get('/api/telos/work/items/studio/lifecycle').set('x-operator', 'interactive');
  const input = (operation = 'trash', itemId = 'studio') => ({
    operation,
    itemId,
    requestId: `req-${Math.random()}`,
    expectedRevision: canonical.work.read(itemId, canonical.actor).revision,
  });
  return { canonical, authorization, assertLifecycleQuiescent, server, post, read, input };
}

const lifecycleReads = [
  { name: 'item', path: '/api/telos/work/items/studio/lifecycle' },
  { name: 'list', path: '/api/telos/work/lifecycle?view=archive' },
] as const;

it.each(lifecycleReads)(
  'reads committed $name lifecycle while an independent canonical writer retains a transition',
  async ({ name, path }) => {
    const f = await fixture();
    expect((await f.post(f.input('archive'))).status).toBe(200);
    const expected =
      name === 'item'
        ? f.canonical.work.readLifecycle('studio', f.canonical.actor)
        : f.canonical.work.listLifecycle('archive', f.canonical.actor);
    const writer = new Database(f.canonical.dbPath);
    try {
      writer.exec('BEGIN IMMEDIATE');
      expect(
        writer
          .prepare(
            "UPDATE telos_work_lifecycle SET data=json_set(data,'$.disposition','active') WHERE item_id='studio'",
          )
          .run().changes,
      ).toBe(1);
      const response = await request(f.server).get(path).set('x-operator', 'interactive');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toEqual(expected);
      expect(writer.inTransaction).toBe(true);
      expect(
        writer
          .prepare(
            "SELECT json_extract(data,'$.disposition') AS disposition FROM telos_work_lifecycle WHERE item_id='studio'",
          )
          .get(),
      ).toEqual({ disposition: 'active' });
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK');
      writer.close();
    }
  },
  15000,
);

it.each(lifecycleReads)(
  'initializes missing lifecycle history for the $name GET',
  async ({ path }) => {
    const f = await fixture();
    f.canonical.db.exec('DROP TABLE telos_work_lifecycle_history');
    const response = await request(f.server)
      .get(path.replace('view=archive', 'view=active'))
      .set('x-operator', 'interactive');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(
      f.canonical.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='telos_work_lifecycle_history'",
        )
        .get(),
    ).toEqual({ name: 'telos_work_lifecycle_history' });
  },
);

it.each(lifecycleReads)(
  'does not promote malformed history into a writer for the $name GET',
  async ({ path }) => {
    const f = await fixture();
    f.canonical.db.exec('DROP TABLE telos_work_lifecycle_history');
    f.canonical.db.exec('CREATE TABLE telos_work_lifecycle_history(broken TEXT)');
    const schema = f.canonical.db.pragma('schema_version', { simple: true });
    const response = await request(f.server)
      .get(path.replace('view=archive', 'view=active'))
      .set('x-operator', 'interactive');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'unavailable', error: 'Telos work service unavailable' });
    expect(f.canonical.db.pragma('schema_version', { simple: true })).toBe(schema);
  },
);

it('derives interactive lifecycle authority, applies canonical revision and retains exact replay through HTTP', async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe(200);
  const input = f.input();
  expect(
    (
      await request(f.server)
        .get('/api/telos/work/lifecycle?view=trash')
        .set('x-internal-token', 'internal')
    ).status,
  ).toBe(403);
  expect(
    (
      await request(f.server)
        .get('/api/telos/work/items/studio/lifecycle')
        .set('x-internal-token', 'internal')
    ).status,
  ).toBe(403);
  const response = await f.post(input);
  expect(response.status).toBe(200);
  expect(response.body.lifecycle.disposition).toBe('trashed');
  expect(response.body.lifecycle.history[0].actorId).toBe(`operator:${f.authorization.id}`);
  expect((await f.post(input)).body).toEqual(response.body);
  expect((await f.post({ ...input, requestId: 'stale', operation: 'restore' })).status).toBe(409);
  const list = await request(f.server)
    .get('/api/telos/work/lifecycle?view=trash')
    .set('x-operator', 'interactive');
  expect(list.status).toBe(200);
  expect(list.body.map((v: { itemId: string }) => v.itemId)).toContain('studio');
  expect((await f.post(f.input('restore'))).body.lifecycle.disposition).toBe('active');
});

it('refuses internal-token actors, forged fields, expired/revoked auth and cross-site requests before mutation', async () => {
  const f = await fixture();
  const input = f.input();
  expect(
    (
      await request(f.server)
        .post('/api/telos/work/lifecycle')
        .set('x-internal-token', 'internal')
        .send(input)
    ).status,
  ).toBe(403);
  expect((await f.post({ ...input, actorId: 'forged', acknowledged: true })).status).toBe(400);
  expect(
    (
      await request(f.server)
        .post('/api/telos/work/lifecycle')
        .set('x-operator', 'interactive')
        .set('Origin', 'https://evil.test')
        .send(input)
    ).status,
  ).toBe(403);
  f.authorization.expiresAt = Date.now() - 1;
  expect((await f.post(input)).status).toBe(403);
  f.authorization.expiresAt = Date.now() + 60000;
  revokeAuthSession(f.authorization);
  expect((await f.post(input)).status).toBe(403);
  expect(f.canonical.work.readRecord('studio', f.canonical.actor).status).toBe('active');
});

it('has no JSON path to host quiescence and requires separate explicit permanent confirmation', async () => {
  const f = await fixture();
  expect((await f.post(f.input())).status).toBe(200);
  expect((await f.post(f.input('delete_permanently'))).status).toBe(400);
  expect(
    (
      await f.post({
        ...f.input('delete_permanently'),
        confirmation: { itemId: 'different', phrase: 'DELETE PERMANENTLY' },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post({
        ...f.input('delete_permanently'),
        confirmation: { itemId: 'studio', phrase: 'DELETE PERMANENTLY' },
        assertQuiescent: true,
      })
    ).status,
  ).toBe(400);
  expect(f.assertLifecycleQuiescent).not.toHaveBeenCalled();
  expect((await f.read()).body.disposition).toBe('trashed');
});

it('passes the original per-request writable Store into the real guarded HTTP callback and expires it after response', async () => {
  const f = await fixture();
  f.canonical.db
    .prepare(
      "INSERT INTO items(id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES('empty','Empty','manual',?,?,?,?)",
    )
    .run(f.canonical.stamp, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp);
  const execute = TelosWorkStore.prototype.executeLifecycle;
  const executing: TelosWorkStore[] = [];
  const spy = vi.spyOn(TelosWorkStore.prototype, 'executeLifecycle').mockImplementation(function (
    this: TelosWorkStore,
    ...args: Parameters<TelosWorkStore['executeLifecycle']>
  ) {
    executing.push(this);
    return execute.apply(this, args);
  });
  let original: TelosWorkStore | undefined;
  try {
    expect((await f.post(f.input('trash', 'empty'))).status).toBe(200);
    f.assertLifecycleQuiescent.mockImplementation((id, owner) => {
      expect(owner).toBe(executing.at(-1));
      expect(owner).toBeInstanceOf(TelosWorkStore);
      owner.assertLifecycleDeletionWriter(id, f.canonical.dbPath);
      original = owner;
    });
    const input = {
      ...f.input('delete_permanently', 'empty'),
      confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
    };
    const result = await f.post(input);
    expect(result.status).toBe(200);
    expect(result.body.lifecycle).toBeNull();
    expect(f.assertLifecycleQuiescent).toHaveBeenCalledExactlyOnceWith('empty', original);
    expect(() => original!.assertLifecycleDeletionWriter('empty', f.canonical.dbPath)).toThrow(
      /deletion.*frame/i,
    );
    expect((await f.post(input)).body).toEqual(result.body);
    expect(f.assertLifecycleQuiescent).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

it('retains the trashed record and expires the original HTTP owner when its host callback refuses', async () => {
  const f = await fixture();
  f.canonical.db
    .prepare(
      "INSERT INTO items(id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES('empty','Empty','manual',?,?,?,?)",
    )
    .run(f.canonical.stamp, f.canonical.stamp, f.canonical.stamp, f.canonical.stamp);
  expect((await f.post(f.input('trash', 'empty'))).status).toBe(200);
  let original: TelosWorkStore | undefined;
  f.assertLifecycleQuiescent.mockImplementation((id, owner) => {
    original = owner;
    owner.assertLifecycleDeletionWriter(id, f.canonical.dbPath);
    throw new Error('host refusal');
  });
  const response = await f.post({
    ...f.input('delete_permanently', 'empty'),
    confirmation: { itemId: 'empty', phrase: 'DELETE PERMANENTLY' },
  });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ code: 'unavailable', error: 'Telos work service unavailable' });
  expect(f.canonical.work.readLifecycle('empty', f.canonical.actor).disposition).toBe('trashed');
  expect(() => original!.assertLifecycleDeletionWriter('empty', f.canonical.dbPath)).toThrow(
    /deletion.*frame/i,
  );
});
