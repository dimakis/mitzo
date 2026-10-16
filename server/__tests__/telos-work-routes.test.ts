import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosWorkRouter } from '../telos-work-routes.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'telos-work-routes-'));
  roots.push(root);
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    `CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES items(id),summary TEXT,updated_at TEXT); INSERT INTO items VALUES('item',NULL,'Item','original');`,
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
        res.locals.authSession = { id: 'verified-operator' };
        next();
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'host',
      sessionId: (id) =>
        id === 'valid-client' ? 'chat' : id === 'other-client' ? 'unrelated' : undefined,
      ordinaryConversation: (id) => ['chat', 'unrelated'].includes(id),
    }),
  );
  const read = () =>
    request(app).get('/api/telos/work/items/item').set('x-operator', 'authenticated');
  const command = (input: object) =>
    request(app).post('/api/telos/work/commands').set('x-operator', 'authenticated').send(input);
  return { app, read, command, dbPath };
}
describe('authorized Telos work API', () => {
  it('requires interactive operator authority before opening canonical data; internal headers cannot substitute', async () => {
    const f = setup();
    expect((await request(f.app).get('/api/telos/work/items/item')).status).toBe(403);
    expect(
      (await request(f.app).get('/api/telos/work/items/item').set('x-internal-token', 'host'))
        .status,
    ).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
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
