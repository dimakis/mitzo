import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function setup(filename = 'notes.md', bytes = Buffer.from('# Original')) {
  const dir = mkdtempSync(join(tmpdir(), 'telos-edit-'));
  dirs.push(dir);
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, profile TEXT);
    INSERT INTO items VALUES('work','telos');
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const store = new TelosArtifactStore(path);
  const original = store.save({
    itemId: 'work',
    filename,
    title: 'Notes',
    bytes,
    sessionId: 'agent-original',
    sourcePath: '/sandbox/notes.md',
  });
  store.close();
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use(
    createTelosArtifactRouter({
      dbPath: () => path,
      operatorAuth: (req, res, next) => {
        if (req.headers['x-test-operator'] !== 'human') return res.sendStatus(403);
        res.locals.authSession = { id: 'human' };
        next();
      },
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw new Error('No workspace access');
      },
    }),
  );
  const url = `/api/telos/artifacts/${original.id}/document`;
  const save = (input: Record<string, unknown> = {}) =>
    request(app)
      .put(url)
      .set('X-Test-Operator', 'human')
      .send({ expectedRevision: 1, content: '# Edited', requestId: 'edit-one', ...input });
  return { app, url, path, original, save };
}

it('reads a pinned document and saves a new revision with human provenance, preserving the old bytes', async () => {
  const { app, url, save, original, path } = setup();
  const read = await request(app).get(`${url}?revision=1`);
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    content: '# Original',
    revision: 1,
    name: 'notes.md',
    editable: true,
    path: original.url,
  });
  const saved = await save();
  expect(saved.status).toBe(200);
  expect(saved.headers['cache-control']).toBe('private, no-store');
  expect(saved.body.artifact).toMatchObject({
    id: original.id,
    revision: 2,
    sourceKind: 'user_edit',
    sourcePath: null,
    sessionId: 'user-edit:human',
  });
  const store = new TelosArtifactStore(path);
  try {
    expect(store.read(original.id, 1).bytes.toString()).toBe('# Original');
    expect(store.read(original.id).bytes.toString()).toBe('# Edited');
    expect(store.read(original.id, 1).sessionId).toBe('agent-original');
  } finally {
    store.close();
  }
  expect((await request(app).get(url)).body.path).toBe(saved.body.artifact.url);
});

it('refuses stale saves even for equal bytes and replays successful retries after later edits', async () => {
  const { save } = setup();
  const first = await save();
  expect(first.status).toBe(200);
  expect((await save({ requestId: 'stale' })).status).toBe(409);
  expect(
    (await save({ requestId: 'second', expectedRevision: 2, content: '# Later' })).status,
  ).toBe(200);
  expect((await save()).body.artifact).toEqual(first.body.artifact);
  expect((await save({ content: 'changed retry' })).status).toBe(409);
  expect((await save({ expectedRevision: 2 })).status).toBe(409);
});

it('requires an interactive operator and strictly validates revision, provenance, identity and size', async () => {
  const { app, url, save } = setup();
  expect((await request(app).put(url).set('X-Internal-Token', 'agent').send({})).status).toBe(403);
  for (const input of [
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { requestId: '' },
    { sessionId: 'forged' },
    { filename: 'other.md' },
    { content: '\u0000' },
  ])
    expect((await save(input)).status).toBe(400);
  expect((await save({ content: 'é'.repeat(3 * 1024 * 1024) })).status).toBe(413);
  expect((await save({ content: 'x'.repeat(5 * 1024 * 1024 + 1) })).status).toBe(413);
  expect((await request(app).get(`${url}?revision=bad`)).status).toBe(400);
  expect(
    (
      await request(app)
        .put('/api/telos/artifacts/bad/document')
        .set('X-Test-Operator', 'human')
        .send({})
    ).status,
  ).toBe(400);
});

it.each(['notes.md', 'notes.mdx', 'preview.html'])(
  'supports the existing editable format %s',
  async (filename) => {
    const { save } = setup(filename);
    expect((await save()).status).toBe(200);
  },
);

it.each([
  ['report.pdf', Buffer.from('%PDF-1.7')],
  ['notes.md', Buffer.from([0xff, 0xfe])],
])('keeps unsupported or non-UTF8 bytes read-only: %s', async (filename, bytes) => {
  const { app, url, save } = setup(filename, bytes);
  const read = await request(app).get(url);
  expect(read.status).toBe(200);
  expect(read.body.editable).toBe(false);
  expect((await save()).status).toBe(400);
});

it('preserves the private LifeOps storage restriction', async () => {
  const { path, save, app, url } = setup();
  const db = new Database(path);
  db.exec("UPDATE items SET profile='lifeops'");
  db.close();
  expect((await request(app).get(url)).body.editable).toBe(false);
  expect((await save()).status).toBe(403);
});

it.each(['script.py', 'script.js'])(
  'preserves an existing read-only text preview for %s',
  async (filename) => {
    const { app, url } = setup(filename, Buffer.from('print("hello")'));
    const read = await request(app).get(url);
    expect(read.body).toMatchObject({
      content: 'print("hello")',
      editable: false,
      previewUnavailable: false,
    });
  },
);

it('authenticates before parsing edits and rechecks a revoked operator at mutation', async () => {
  const { login, operatorAuthMiddleware, authMiddleware, revokeAuthSession } =
    await import('../auth.js');
  const { INTERNAL_TOKEN } = await import('../internal-token.js');
  const { telosArtifactSaveJson } = await import('../telos-artifact-routes.js');
  const { path, url } = setup();
  const app = express();
  app.put('/api/telos/artifacts/:id/document', operatorAuthMiddleware, telosArtifactSaveJson);
  app.use((_req, res, next) => {
    revokeAuthSession(res.locals.authSession);
    next();
  });
  app.use('/api', authMiddleware);
  app.use(
    createTelosArtifactRouter({
      dbPath: () => path,
      operatorAuth: operatorAuthMiddleware,
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw new Error('No workspace access');
      },
    }),
  );
  expect(
    (
      await request(app)
        .put(url)
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .set('Content-Type', 'application/json')
        .send('{bad')
    ).status,
  ).toBe(403);
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const revoked = await request(app)
    .put(url)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Internal-Token', INTERNAL_TOKEN)
    .send({ expectedRevision: 1, content: 'revoked', requestId: 'revoked' });
  expect(revoked.status).toBe(403);
  const store = new TelosArtifactStore(path);
  try {
    expect(store.read(url.split('/')[4]).revision).toBe(1);
  } finally {
    store.close();
  }
});
