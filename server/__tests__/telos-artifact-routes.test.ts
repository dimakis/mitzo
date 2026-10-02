import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosArtifactRouter } from '../telos-artifact-routes.js';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'telos-route-'));
  dirs.push(dir);
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, summary TEXT); INSERT INTO items VALUES('t','Recovery');
  CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const readFile = vi.fn(async () => ({ path: '/sandbox/spec.md', bytes: Buffer.from('# Spec') }));
  const app = express();
  app.use(express.json());
  app.use(
    createTelosArtifactRouter({
      dbPath: () => path,
      verifyInternal: (req) => req.headers['x-internal-token'] === 'token',
      sessionId: (client) => (client === 'active' ? 'session-original' : undefined),
      readFile,
    }),
  );
  const call = (operation: string, input: Record<string, unknown>, client = 'active') =>
    request(app)
      .post(`/api/internal/telos/artifacts/${operation}`)
      .set('X-Internal-Token', 'token')
      .set('X-Client-Id', client)
      .send(input);
  return { app, call, readFile };
}
describe('Telos host artifact routes', () => {
  it('reads the authenticated session workspace, persists bytes, then recovers from another request', async () => {
    const { call, readFile, app } = setup();
    const saved = await call('save', {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      path: '/sandbox/spec.md',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.artifact.sessionId).toBe('session-original');
    expect(readFile).toHaveBeenCalledWith('session-original', '/sandbox/spec.md');
    const id = saved.body.artifact.id;
    expect((await call('find', { itemId: 't' })).body.artifacts).toHaveLength(1);
    const read = await call('read', { id });
    expect(read.body.artifact).toMatchObject({ content: '# Spec', encoding: 'utf8', revision: 1 });
    const download = await request(app).get(`/api/telos/artifacts/${id}?revision=1`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toBe('private, no-store');
  });
  it('rejects missing credentials, unregistered sessions, caller provenance and invalid input', async () => {
    const { call, app, readFile } = setup();
    expect((await request(app).post('/api/internal/telos/artifacts/save').send({})).status).toBe(
      401,
    );
    expect((await call('find', {}, 'forged')).status).toBe(409);
    expect(
      (
        await call('save', {
          itemId: 't',
          filename: 's.md',
          title: 'S',
          content: 'x',
          sessionId: 'forged',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('save', { itemId: 'missing', filename: 's.md', title: 'S', content: 'x' }))
        .status,
    ).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('returns workspace failures without receipts or partial links, and retains binary bytes', async () => {
    const { call, readFile } = setup();
    readFile.mockRejectedValueOnce(
      Object.assign(new Error('Sandbox unavailable'), { status: 409 }),
    );
    const failed = await call('save', {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      path: '/sandbox/spec.md',
    });
    expect(failed.status).toBe(409);
    expect(failed.body.artifact).toBeUndefined();
    expect((await call('find', {})).body.artifacts).toEqual([]);
    readFile.mockResolvedValueOnce({
      path: '/sandbox/picture.png',
      bytes: Buffer.from([0, 255, 128]),
    });
    const saved = await call('save', {
      itemId: 't',
      filename: 'picture.png',
      title: 'Picture',
      path: '/sandbox/picture.png',
    });
    const read = await call('read', { id: saved.body.artifact.id });
    expect(read.body.artifact).toMatchObject({
      encoding: 'base64',
      content: Buffer.from([0, 255, 128]).toString('base64'),
    });
  });
});
