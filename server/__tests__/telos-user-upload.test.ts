import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'telos-user-upload-'));
  dirs.push(dir);
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY, summary TEXT); INSERT INTO items VALUES('work','Work'),('lifeops','LifeOps'); CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);",
  );
  db.close();
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => {
    if (req.headers['x-test-operator'])
      res.locals.authSession = { id: req.headers['x-test-operator'] };
    next();
  });
  app.use(
    createTelosArtifactRouter({
      operatorAuth: (_req, _res, next) => next(),
      dbPath: () => path,
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw new Error('No host reads');
      },
    }),
  );
  const upload = (input: Record<string, unknown> = {}, item = 'work', operator = 'operator-a') =>
    request(app)
      .post(`/api/telos/items/${item}/artifacts/upload`)
      .set('X-Test-Operator', operator)
      .send({
        filename: 'notes.md',
        title: 'Notes',
        requestId: 'request-one',
        base64: Buffer.from('# Notes').toString('base64'),
        ...input,
      });
  return { app, upload, path };
}
it('requires interactive operator identity and rejects agent-supplied provenance/path', async () => {
  const { app, upload } = setup();
  expect((await request(app).post('/api/telos/items/work/artifacts/upload').send({})).status).toBe(
    403,
  );
  for (const input of [{ sessionId: 'forged' }, { path: '/etc/passwd' }])
    expect((await upload(input)).status).toBe(400);
});
it('uploads without an active model session for Telos and LifeOps, preserves revisions and retry receipts', async () => {
  const { upload, app } = setup();
  const saved = await upload();
  expect(saved.status).toBe(200);
  expect(saved.body.artifact).toMatchObject({
    revision: 1,
    sourceKind: 'user_upload',
    sessionId: 'user-upload:operator-a',
    sourcePath: null,
  });
  expect((await upload()).body.artifact.revision).toBe(1);
  expect((await upload({ base64: Buffer.from('changed').toString('base64') })).status).toBe(409);
  const edited = await upload(
    { requestId: 'request-two', base64: Buffer.from('changed').toString('base64') },
    'work',
    'operator-b',
  );
  expect(edited.body.artifact).toMatchObject({ id: saved.body.artifact.id, revision: 2 });
  const old = await request(app).get(saved.body.artifact.url);
  expect(old.status).toBe(200);
  expect(old.headers['content-disposition']).toContain('attachment');
  expect(old.headers['x-content-type-options']).toBe('nosniff');
  expect(old.headers['x-artifact-sha256']).toBe(saved.body.artifact.sha256);
  expect((await upload({ requestId: 'lifeops-upload' }, 'lifeops')).status).toBe(200);
  expect((await upload({ requestId: 'missing-upload' }, 'missing')).status).toBe(404);
});
it('rejects traversal/control names, active types, bad binary signatures, malformed encoding and oversized decoded bytes', async () => {
  const { upload } = setup();
  for (const input of [
    { filename: '../notes.md' },
    { filename: 'bad\n.md' },
    { filename: 'page.html' },
    { filename: 'image.svg' },
    { filename: 'fake.pdf' },
    { filename: 'fake.png' },
    { base64: 'not base64!' },
  ])
    expect((await upload(input)).status).toBe(400);
  expect(
    (await upload({ base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') })).status,
  ).toBe(413);
});

it('enforces real interactive authentication before parsing upload bytes', async () => {
  const { login, operatorAuthMiddleware } = await import('../auth.js');
  const { path } = setup();
  const app = express();
  app.post(
    '/api/telos/items/:itemId/artifacts/upload',
    operatorAuthMiddleware,
    express.json({ limit: '8mb' }),
  );
  app.use(
    createTelosArtifactRouter({
      operatorAuth: operatorAuthMiddleware,
      dbPath: () => path,
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw new Error('No host reads');
      },
    }),
  );
  const route = '/api/telos/items/work/artifacts/upload';
  expect(
    (
      await request(app)
        .post(route)
        .set('X-Internal-Token', 'untrusted-agent')
        .set('Content-Type', 'application/json')
        .send('{broken')
    ).status,
  ).toBe(403);
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const saved = await request(app)
    .post(route)
    .set('Authorization', `Bearer ${token}`)
    .send({
      filename: 'real.md',
      title: 'Real operator',
      requestId: 'real-request',
      base64: Buffer.from('operator evidence').toString('base64'),
    });
  expect(saved.status).toBe(200);
  expect(saved.body.artifact.sourceKind).toBe('user_upload');
});

it('marks external Codex report provenance distinctly in canonical metadata', async () => {
  const { path } = setup();
  const { TelosArtifactStore } = await import('../telos-artifact-store.js');
  const store = new TelosArtifactStore(path);
  try {
    const saved = store.save({
      itemId: 'work',
      filename: 'acceptance.md',
      title: 'Acceptance',
      bytes: Buffer.from('report'),
      sessionId: 'external-codex:real-chat',
    });
    expect(saved.sourceKind).toBe('external_codex_report');
  } finally {
    store.close();
  }
});

it('revalidates the operator at mutation even when agent authority admitted the broad API gate', async () => {
  const { login, operatorAuthMiddleware, authMiddleware, revokeAuthSession } =
    await import('../auth.js');
  const { INTERNAL_TOKEN } = await import('../internal-token.js');
  const { path } = setup();
  const app = express();
  app.post(
    '/api/telos/items/:itemId/artifacts/upload',
    operatorAuthMiddleware,
    express.json({ limit: '8mb' }),
  );
  app.use((_req, res, next) => {
    revokeAuthSession(res.locals.authSession);
    next();
  });
  app.use('/api', authMiddleware);
  app.use(
    createTelosArtifactRouter({
      dbPath: () => path,
      verifyInternal: () => false,
      sessionId: () => undefined,
      readFile: async () => {
        throw Error('No host reads');
      },
      operatorAuth: operatorAuthMiddleware,
    }),
  );
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const result = await request(app)
    .post('/api/telos/items/work/artifacts/upload')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Internal-Token', INTERNAL_TOKEN)
    .send({
      filename: 'safe.md',
      title: 'Safe',
      requestId: 'revoked-save',
      base64: Buffer.from('safe').toString('base64'),
    });
  expect(result.status).toBe(403);
  expect(result.body.artifact).toBeUndefined();
});
