import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosArtifactRouter, telosArtifactSaveJson } from '../telos-artifact-routes.js';
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
  app.post(
    '/api/internal/telos/artifacts/save',
    (req, res, next) => {
      if (req.headers['x-internal-token'] !== 'token') return res.sendStatus(401);
      next();
    },
    telosArtifactSaveJson,
  );
  app.use(express.json({ limit: '10mb' }));
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
      .send(operation === 'save' ? { requestId: 'save-spec', ...input } : input);
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
  it('saves a 5 MiB inline document with worst-case JSON expansion and enforces decoded byte limits', async () => {
    const { call } = setup();
    const content = '\u0000'.repeat(5 * 1024 * 1024);
    const saved = await call('save', {
      itemId: 't',
      filename: 'controls.txt',
      title: 'Controls',
      content,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.artifact.size).toBe(Buffer.byteLength(content));
    const read = await call('read', { id: saved.body.artifact.id });
    expect(read.body.artifact.content).toBe(content);
    const oversized = await call('save', {
      itemId: 't',
      filename: 'unicode.txt',
      requestId: 'oversized-unicode',
      title: 'Unicode',
      content: 'é'.repeat(3 * 1024 * 1024),
    });
    expect(oversized.status).toBe(413);
  });
  it('recovers path-upload receipts before touching files that changed or disappeared', async () => {
    const { call, readFile } = setup();
    const input = {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      path: '/sandbox/spec.md',
      requestId: 'path-save',
    };
    const first = await call('save', input);
    expect(first.status).toBe(200);
    readFile.mockResolvedValue({ path: '/sandbox/spec.md', bytes: Buffer.from('Changed locally') });
    const editedRetry = await call('save', input);
    expect(editedRetry.status).toBe(200);
    expect(editedRetry.body.artifact).toEqual(first.body.artifact);
    readFile.mockRejectedValue(new Error('File removed'));
    const deletedRetry = await call('save', input);
    expect(deletedRetry.status).toBe(200);
    expect(deletedRetry.body.artifact).toEqual(first.body.artifact);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((await call('save', { ...input, path: '/other.md' })).status).toBe(409);
    expect((await call('save', { ...input, title: 'Changed title' })).status).toBe(409);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((await call('read', { id: first.body.artifact.id })).body.artifact.revision).toBe(1);
  });
  it('retains retry receipts after another save and rejects changed request input', async () => {
    const { call } = setup();
    const input = {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      content: 'Original',
      requestId: 'a',
    };
    const first = await call('save', input);
    await call('save', { ...input, content: 'Revised', requestId: 'b' });
    expect((await call('save', input)).body.artifact).toEqual(first.body.artifact);
    expect((await call('read', { id: first.body.artifact.id })).body.artifact.content).toBe(
      'Revised',
    );
    expect((await call('save', { ...input, content: 'Changed' })).status).toBe(409);
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
