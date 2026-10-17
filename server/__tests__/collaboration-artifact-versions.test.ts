import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
const servers: Server[] = [];
const fixtures: ReturnType<typeof createCollaborationRetainedArtifactFixture>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeTestServer));
  fixtures.splice(0).forEach((f) => f.close());
  vi.restoreAllMocks();
});
async function fixture(onAuthorize?: (path: string) => Promise<void>) {
  const f = createCollaborationRetainedArtifactFixture();
  fixtures.push(f);
  const revisions = Array.from({ length: 54 }, (_, index) =>
    f.store.save({
      itemId: f.itemId,
      filename: 'history.md',
      title: 'History',
      bytes: Buffer.from('Exact saved ' + (index + 1)),
      sessionId: 'removed-origin',
    }),
  );
  const app = express();
  app.use(
    createTelosArtifactRouter({
      dbPath: () => f.path,
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw Error('No workspace reads');
      },
      operatorAuth: async (req, res, next) => {
        if (req.headers['x-operator'] !== 'fixture') {
          res.sendStatus(403);
          return;
        }
        await onAuthorize?.(f.path);
        res.locals.authSession = { id: 'fixture' };
        next();
      },
    }),
  );
  const server = await listenOnLoopback(app);
  servers.push(server);
  return {
    ...f,
    get store() {
      return f.store;
    },
    revisions,
    app: server,
    url: '/api/telos/artifacts/' + revisions[0].id + '/versions',
  };
}
it('pages real retained revision metadata by exact revision without hydrating bytes', async () => {
  const f = await fixture();
  const read = vi.spyOn(f.store, 'read');
  const page = f.store.revisionPage(f.revisions[0].id);
  expect(page.artifacts.map((a) => a.revision)).toEqual(
    Array.from({ length: 50 }, (_, i) => 54 - i),
  );
  expect(page).toMatchObject({ cursor: 5, hasMore: true });
  expect(page.artifacts.every((a) => !('bytes' in a))).toBe(true);
  expect(read).not.toHaveBeenCalled();
  const next = f.store.revisionPage(f.revisions[0].id, { beforeRevision: page.cursor! });
  expect(next.artifacts.map((a) => a.revision)).toEqual([4, 3, 2, 1]);
  expect(next).toMatchObject({ cursor: null, hasMore: false });
});
it('requires an interactive operator and returns only exact saved version metadata', async () => {
  const f = await fixture();
  expect((await request(f.app).get(f.url)).status).toBe(403);
  const first = await request(f.app)
    .get(f.url + '?limit=2')
    .set('X-Operator', 'fixture');
  expect(first.status).toBe(200);
  expect(first.body.artifacts.map((a: { revision: number }) => a.revision)).toEqual([54, 53]);
  expect(first.body.cursor).toBe(53);
  expect(JSON.stringify(first.body)).not.toContain('Exact saved');
  expect(first.headers['cache-control']).toBe('private, no-store');
  const second = await request(f.app)
    .get(f.url + '?limit=2&beforeRevision=53')
    .set('X-Operator', 'fixture');
  expect(second.body.artifacts.map((a: { revision: number }) => a.revision)).toEqual([52, 51]);
});
it('does not depend on the originating conversation and rejects malformed cursors', async () => {
  const f = await fixture();
  f.restart();
  expect((await request(f.app).get(f.url).set('X-Operator', 'fixture')).status).toBe(200);
  for (const query of [
    '?limit=51',
    '?limit=0',
    '?beforeRevision=0',
    '?beforeRevision=1.5',
    '?beforeRevision=2&beforeRevision=3',
  ])
    expect(
      (
        await request(f.app)
          .get(f.url + query)
          .set('X-Operator', 'fixture')
      ).status,
    ).toBe(400);
});
it('does not expose scoped source-capture metadata or current private item history', async () => {
  const f = await fixture();
  const source = f.store.save({
    itemId: f.itemId,
    filename: 'source.json',
    title: 'PRIVATE PACKET TITLE',
    bytes: Buffer.from('private'),
    sessionId: 'source-capture:fixture',
  });
  const scoped = await request(f.app)
    .get('/api/telos/artifacts/' + source.id + '/versions')
    .set('X-Operator', 'fixture');
  expect(scoped.status).toBe(403);
  expect(JSON.stringify(scoped.body)).not.toContain('PRIVATE PACKET TITLE');
  const db = new Database(f.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('LifeOps', f.itemId);
  db.close();
  const privatePage = await request(f.app).get(f.url).set('X-Operator', 'fixture');
  expect(privatePage.status).toBe(403);
  expect(privatePage.body.artifacts).toBeUndefined();
});

it('refuses changed public eligibility when an older saved preview or export is requested', async () => {
  const f = await fixture();
  expect((await request(f.app).get(f.url).set('X-Operator', 'fixture')).status).toBe(200);
  const db = new Database(f.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('LifeOps', f.itemId);
  db.close();
  const pinned = f.revisions[0].url;
  const download = await request(f.app).get(pinned).set('X-Operator', 'fixture');
  expect(download.status).toBe(403);
  expect(download.text).not.toContain('Exact saved 1');
  const preview = await request(f.app)
    .get(`/api/telos/artifacts/${f.revisions[0].id}/document?revision=1`)
    .set('X-Operator', 'fixture');
  expect(preview.status).toBe(403);
  expect(preview.body.content).toBeUndefined();
});

it('refuses same-size saved-byte corruption for preview and native export', async () => {
  const f = await fixture();
  const saved = f.revisions[0];
  const db = new Database(f.path);
  db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=1').run(
    Buffer.alloc(saved.size, 120),
    saved.id,
  );
  db.close();
  for (const url of [saved.url, `/api/telos/artifacts/${saved.id}/document?revision=1`]) {
    const response = await request(f.app).get(url).set('X-Operator', 'fixture');
    expect(response.status).toBe(503);
    expect(response.body.content).toBeUndefined();
    expect(response.text).not.toContain('Exact saved');
  }
});

it('renews exact scoped packet custody after interactive authorization awaits', async () => {
  const control: { mutate?: (path: string) => void } = {};
  const f = await fixture(async (path) => {
    await Promise.resolve();
    control.mutate?.(path);
  });
  const packet = f.store.save({
    itemId: f.itemId,
    filename: 'review.md',
    title: 'Scoped review',
    bytes: Buffer.from('Reviewed source'),
    sessionId: 'source-capture:fixture',
  });
  expect((await request(f.app).get(packet.url).set('X-Operator', 'fixture')).status).toBe(200);
  control.mutate = (path) => {
    const db = new Database(path);
    db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=1').run(
      Buffer.alloc(packet.size, 120),
      packet.id,
    );
    db.close();
  };
  const response = await request(f.app)
    .get(`/api/telos/artifacts/${packet.id}/document?revision=1`)
    .set('X-Operator', 'fixture');
  expect(response.status).toBe(503);
  expect(response.body.content).toBeUndefined();
});
