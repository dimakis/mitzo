import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { revokeAuthSession } from '../auth.js';
import { randomUUID } from 'node:crypto';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function setup(overrides: Partial<Parameters<typeof createTelosWorkRouter>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'telos-work-routes-'));
  roots.push(root);
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    `CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES items(id),summary TEXT,updated_at TEXT,status TEXT DEFAULT 'active',acceptance_criteria TEXT DEFAULT '[]');
     INSERT INTO items(id,parent_id,summary,updated_at) VALUES('item',NULL,'Item','original');
     CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
     CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`,
  );
  db.close();
  const dbPath = vi.fn(() => path);
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath,
      operatorAuth: (req, res, next) => {
        if (req.headers['x-operator'] !== 'authenticated') {
          res.status(403).json({ error: 'Operator required' });
          return;
        }
        res.locals.authSession = { id: 'verified-operator', expiresAt: Date.now() + 60000 };
        next();
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'host',
      sessionId: (id) =>
        id === 'valid-client' ? 'chat' : id === 'other-client' ? 'unrelated' : undefined,
      ordinaryConversation: (id) => ['chat', 'unrelated'].includes(id),
      ...overrides,
    }),
  );
  const read = () =>
    request(app).get('/api/telos/work/items/item').set('x-operator', 'authenticated');
  const command = (input: object) =>
    request(app).post('/api/telos/work/commands').set('x-operator', 'authenticated').send(input);
  return { app, read, command, dbPath };
}
describe('authorized Telos work API', () => {
  it('uses only interactive operator authority for advisor previews and saves, with fresh revocation across the host wait', async () => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const advisorSave = vi.fn(async (input: { assertAuthorized(): void; actor: unknown }) => {
      input.assertAuthorized();
      expect(input.actor).toEqual({ kind: 'operator', id: auth.id });
      revokeAuthSession(auth);
      return { receipt: 'committed' };
    });
    const f = setup({
      advisorSave,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = auth;
        next();
      },
    });
    const result = await request(f.app)
      .post('/api/telos/work/advisor/save')
      .send({ itemId: 'item' });
    expect(result.status).toBe(403);
    expect(advisorSave).toHaveBeenCalledOnce();
    expect(result.headers['cache-control']).toBe('private, no-store');
    const unavailable = setup();
    expect(
      (
        await request(unavailable.app)
          .post('/api/telos/work/advisor/preview')
          .set('x-operator', 'authenticated')
          .send({})
      ).status,
    ).toBe(503);
    expect(
      (
        await request(unavailable.app)
          .post('/api/telos/work/advisor/save')
          .set('x-internal-token', 'host')
          .send({})
      ).status,
    ).toBe(403);
  });
  it('passes only host identity to the role owner and returns its exact retained receipt', async () => {
    const roleSetup = vi.fn(
      async (
        input: Parameters<NonNullable<Parameters<typeof createTelosWorkRouter>[0]['roleSetup']>>[0],
      ) => {
        input.assertAuthorized();
        expect(input.actor).toEqual({ kind: 'operator', id: 'verified-operator' });
        return { receipt: 'saved' };
      },
    );
    const f = setup({ roleSetup });
    const result = await request(f.app)
      .post('/api/telos/work/roles/setup')
      .set('x-operator', 'authenticated')
      .send({ requestId: 'unchanged' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ receipt: 'saved' });
    expect(roleSetup).toHaveBeenCalledOnce();
    expect(result.headers['cache-control']).toBe('private, no-store');
  });

  it('denies a successful delayed receipt after operator revocation without repeating the host operation', async () => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const roleSetup = vi.fn(async () => {
      await Promise.resolve();
      revokeAuthSession(auth);
      return { receipt: 'committed-and-retained' };
    });
    const f = setup({
      roleSetup,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = auth;
        next();
      },
    });
    const result = await request(f.app)
      .post('/api/telos/work/roles/setup')
      .send({ requestId: 'same' });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('unauthorized');
    expect(roleSetup).toHaveBeenCalledOnce();
    expect(result.text).not.toContain('committed-and-retained');
  });

  it('keeps atomic role setup behind its context-authorizing host entry', async () => {
    const f = setup();
    const before = await f.read();
    const result = await f.command({
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'bypass',
      expectedRevision: before.body.revision,
      role: 'lead',
      conversationId: 'chat',
      expectedAssignmentRevision: 0,
    });
    expect(result.status).toBe(400);
    expect((await f.read()).body).toEqual(before.body);
  });

  it('reports role setup as unavailable without a configured ordinary host and denies internal-token substitution', async () => {
    const f = setup();
    const path = '/api/telos/work/roles/setup';
    expect((await request(f.app).post(path).set('x-internal-token', 'host').send({})).status).toBe(
      403,
    );
    expect(
      (await request(f.app).post(path).set('x-operator', 'authenticated').send({})).status,
    ).toBe(503);
  });
  it('requires interactive operator authority before opening canonical data; internal headers cannot substitute', async () => {
    const f = setup();
    expect((await request(f.app).get('/api/telos/work/items/item')).status).toBe(403);
    expect(
      (await request(f.app).get('/api/telos/work/items/item').set('x-internal-token', 'host'))
        .status,
    ).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
  });
  it('protects the complete record read before opening canonical data and returns only the selected item', async () => {
    const f = setup();
    const path = '/api/telos/work/items/item/record';
    expect((await request(f.app).get(path)).status).toBe(403);
    expect((await request(f.app).get(path).set('x-internal-token', 'host')).status).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
    const response = await request(f.app).get(path).set('x-operator', 'authenticated');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      itemId: 'item',
      summary: 'Item',
      status: 'active',
      kind: null,
      categories: [],
      createdAt: null,
      updatedAt: 'original',
      sources: [],
      links: [],
    });
    expect(
      (
        await request(f.app)
          .get('/api/telos/work/items/missing/record')
          .set('x-operator', 'authenticated')
      ).status,
    ).toBe(404);
    const db = new Database(f.dbPath());
    db.prepare("UPDATE items SET acceptance_criteria=? WHERE id='item'").run(
      '{private invalid data',
    );
    db.close();
    const invalid = await request(f.app).get(path).set('x-operator', 'authenticated');
    expect(invalid.status).toBe(503);
    expect(invalid.text).not.toContain('private invalid data');
  });
  it('reads, links and replays using host identity while rejecting caller-selected actors and stale writes', async () => {
    const f = setup();
    const before = await f.read();
    expect(before.status).toBe(200);
    const input = {
      operation: 'link',
      itemId: 'item',
      requestId: 'one',
      expectedRevision: before.body.revision,
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
    };
    const receipt = await f.command(input);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['cache-control']).toBe('private, no-store');
    expect(receipt.body.actorId).toBe('operator:verified-operator');
    expect((await f.command(input)).body).toEqual(receipt.body);
    expect((await f.command({ ...input, actor: { kind: 'operator', id: 'spoof' } })).status).toBe(
      400,
    );
    expect((await f.command({ ...input, requestId: 'stale' })).status).toBe(409);
    const links = await request(f.app)
      .post('/api/telos/work/links')
      .set('x-operator', 'authenticated')
      .send(input.conversation);
    expect(links.body).toMatchObject([{ itemId: 'item', role: 'worker' }]);
  });
  it('gives internal chats explicit linked-item reads without granting work mutations', async () => {
    const f = setup();
    const internal = (client: string, token = 'host') =>
      request(f.app)
        .post('/api/internal/telos/work/read')
        .set('x-internal-token', token)
        .set('x-client-id', client)
        .send({ itemId: 'item' });
    expect((await internal('valid-client', 'wrong')).status).toBe(401);
    expect((await internal('stale')).status).toBe(409);
    expect((await internal('valid-client')).status).toBe(403);
    await f.command({
      operation: 'link',
      itemId: 'item',
      requestId: 'link',
      expectedRevision: (await f.read()).body.revision,
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
    });
    expect((await internal('valid-client')).status).toBe(200);
    expect((await internal('other-client')).status).toBe(403);
    expect(
      (
        await request(f.app)
          .post('/api/internal/telos/work/commands')
          .set('x-internal-token', 'host')
          .send({})
      ).status,
    ).toBe(404);
  });
  it('keeps invalid operations atomic and returns safe errors for missing or unavailable owners', async () => {
    const f = setup();
    const before = await f.read();
    expect(
      (
        await f.command({
          operation: 'reparent',
          itemId: 'item',
          requestId: 'cycle',
          expectedRevision: before.body.revision,
          parentId: 'item',
        })
      ).status,
    ).toBe(400);
    expect((await f.read()).body).toEqual(before.body);
    expect(
      (await request(f.app).get('/api/telos/work/items/missing').set('x-operator', 'authenticated'))
        .status,
    ).toBe(404);
    f.dbPath.mockImplementation(() => {
      throw Error('/private/credentials/config.db');
    });
    const unavailable = await f.read();
    expect(unavailable.status).toBe(503);
    expect(unavailable.text).not.toContain('/private/');
  });
});
