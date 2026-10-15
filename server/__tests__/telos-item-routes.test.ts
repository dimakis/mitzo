import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosItemRouter } from '../telos-item-routes.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'telos-item-route-'));
  dirs.push(dir);
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,summary TEXT,status TEXT,parent_id TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,updated_at TEXT,snoozed_until TEXT);
    CREATE TABLE history(id INTEGER PRIMARY KEY,item_id TEXT,old_status TEXT,new_status TEXT,changed_at TEXT);
    INSERT INTO items VALUES('task','Source research','active',NULL,'Compare','Inform','[]','original',NULL);`);
  db.close();
  const app = express();
  app.use(express.json());
  app.use(
    createTelosItemRouter({
      dbPath: () => path,
      verifyInternal: (req) => req.headers['x-internal-token'] === 'secret',
      sessionId: (id) => (id === 'active' ? 'host-session' : undefined),
    }),
  );
  const call = (operation: string, input: object, client = 'active', token = 'secret') =>
    request(app)
      .post(`/api/internal/telos/items/${operation}`)
      .set('X-Internal-Token', token)
      .set('X-Client-Id', client)
      .send(input);
  return { app, call };
}
describe('Telos item host routes', () => {
  it('reads then completes the canonical item with host-supplied provenance', async () => {
    const { call } = setup();
    const read = await call('get', { itemId: 'task' });
    expect(read.status).toBe(200);
    const input = {
      itemId: 'task',
      requestId: 'finish',
      expectedRevision: read.body.item.revision,
      status: 'completed',
      note: 'Pinned report saved and reviewed.',
    };
    const saved = await call('update', input);
    expect(saved.status).toBe(200);
    expect(saved.headers['cache-control']).toBe('private, no-store');
    expect(saved.body).toMatchObject({
      ok: true,
      item: { status: 'completed' },
      update: { sessionId: 'host-session', note: input.note },
    });
    expect((await call('update', input)).body).toEqual(saved.body);
    expect((await call('get', { itemId: 'task' })).body.item.updates).toHaveLength(1);
  });
  it('denies missing host credentials, inactive clients and caller-chosen provenance', async () => {
    const { call } = setup();
    expect((await call('get', { itemId: 'task' }, 'active', '')).status).toBe(401);
    expect((await call('get', { itemId: 'task' }, 'closed')).status).toBe(409);
    expect((await call('update', { itemId: 'task', sessionId: 'spoofed' })).status).toBe(400);
    expect((await call('get', { itemId: 'missing' })).status).toBe(404);
  });
  it('returns actionable conflicts and rejects invalid updates without changing the item', async () => {
    const { call } = setup();
    expect(
      (
        await call('update', {
          itemId: 'task',
          requestId: 'stale',
          expectedRevision: 'a'.repeat(64),
          note: 'Done',
          status: 'completed',
        })
      ).status,
    ).toBe(409);
    expect((await call('update', { itemId: 'task', note: '' })).status).toBe(400);
    expect((await call('get', { itemId: 'task' })).body.item.status).toBe('active');
  });
});
