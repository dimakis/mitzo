import { TelosArtifactStore } from '../telos-artifact-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosArtifactRouter, telosArtifactSaveJson } from '../telos-artifact-routes.js';
import { executeTelosArtifactTool } from '../telos-artifact-tools.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => logs }));
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  logs.warn.mockReset();
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
      operatorAuth: (req, res, next) => {
        if (req.headers['x-fixture-operator'] !== 'yes') {
          res.status(403).json({ error: 'Operator required' });
          return;
        }
        res.locals.authSession = { id: 'fixture-user' };
        next();
      },
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
  return { app, call, readFile, path };
}
describe('Telos host artifact routes', () => {
  it('delivers a real HTTP helper failure as a tool error, then returns the recovered save receipt', async () => {
    const { app, readFile } = setup();
    const server = await listenOnLoopback(app);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Private test listener missing');
      readFile.mockRejectedValueOnce(
        Object.assign(new Error('PRIVATE timeout'), { code: 'ETIMEDOUT' }),
      );
      const input = {
        requestId: 'same-save',
        itemId: 't',
        filename: 'spec.md',
        title: 'Spec',
        path: '/spec.md',
      };
      const save = () =>
        executeTelosArtifactTool(
          `http://127.0.0.1:${address.port}`,
          'active',
          'token',
          'TelosSaveArtifact',
          input,
        );
      expect(await save()).toEqual({
        isError: true,
        content: 'Telos artifact service unavailable',
      });
      expect(logs.warn).toHaveBeenCalledExactlyOnceWith(
        'Telos artifact operation failed',
        expect.objectContaining({
          phase: 'read_workspace',
          reason: 'process_timeout',
          errorCode: 'ETIMEDOUT',
        }),
      );
      const recovered = await save();
      expect(recovered.isError).toBe(false);
      expect(JSON.parse(recovered.content)).toMatchObject({
        ok: true,
        artifact: { revision: 1, sessionId: 'session-original' },
      });
      expect(await save()).toEqual(recovered);
      expect(readFile).toHaveBeenCalledTimes(2);
    } finally {
      await closeTestServer(server);
    }
  });
  it('does not inspect diagnostic getters or expose a nested private error', async () => {
    const { call, readFile } = setup();
    const getter = vi.fn(() => 'PRIVATE code');
    const cause = new Error('PRIVATE inner');
    Object.defineProperty(cause, 'code', { get: getter });
    Object.defineProperty(cause, 'cause', { get: getter });
    readFile.mockRejectedValueOnce(new Error('PRIVATE outer', { cause }));
    expect(
      (await call('save', { itemId: 't', filename: 'spec.md', title: 'Spec', path: '/spec.md' }))
        .status,
    ).toBe(503);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE');
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith(
      'Telos artifact operation failed',
      expect.objectContaining({ reason: 'unexpected' }),
    );
  });
  it('keeps the original failure visible when storage cleanup also fails', async () => {
    const { call, readFile } = setup();
    const close = TelosArtifactStore.prototype.close;
    vi.spyOn(TelosArtifactStore.prototype, 'close').mockImplementationOnce(function (
      this: TelosArtifactStore,
    ) {
      close.call(this);
      throw Object.assign(new Error('PRIVATE cleanup'), { code: 'SQLITE_BUSY' });
    });
    readFile.mockRejectedValueOnce(Object.assign(new Error('PRIVATE read'), { code: 'EPERM' }));
    const failed = await call('save', {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      path: '/spec.md',
    });
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ ok: false, error: 'Telos artifact service unavailable' });
    expect(logs.warn.mock.calls.map(([, context]) => context.phase)).toEqual([
      'read_workspace',
      'close_storage',
    ]);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE');
  });
  it('reports a failed workspace helper without exposing its output and allows the same save to recover', async () => {
    const { call, readFile } = setup();
    const failure = Object.assign(new Error('PRIVATE path and command'), {
      code: 71,
      stdout: 'PRIVATE document bytes',
      stderr: 'PRIVATE helper diagnostic',
    });
    readFile.mockRejectedValueOnce(failure);
    const input = { itemId: 't', filename: 'spec.md', title: 'Spec', path: '/PRIVATE/spec.md' };
    const failed = await call('save', input);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ ok: false, error: 'Telos artifact service unavailable' });
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('Telos artifact operation failed', {
      code: 'telos_artifact_unavailable',
      phase: 'read_workspace',
      operation: 'save',
      sessionId: 'session-original',
      reason: 'process_failed',
      errorKind: 'error',
      errorCode: 'process_exit',
      exitCode: 71,
    });
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE');
    expect((await call('find', {})).body.artifacts).toEqual([]);
    expect((await call('save', input)).status).toBe(200);
    expect((await call('find', {})).body.artifacts).toHaveLength(1);
  });
  it('preserves the failed response if its diagnostic sink fails', async () => {
    const { call, readFile } = setup();
    readFile.mockRejectedValueOnce(new Error('PRIVATE failure'));
    logs.warn.mockImplementationOnce(() => {
      throw Error('Log sink failed');
    });
    const response = await call('save', {
      itemId: 't',
      filename: 'spec.md',
      title: 'Spec',
      path: '/spec.md',
    });
    expect(response.status).toBe(503);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect((await call('find', {})).body.artifacts).toEqual([]);
  });
  it('keeps reviewed source packets outside generic outputs and conversation artifact authority', async () => {
    const { app, path, call } = setup();
    const store = new TelosArtifactStore(path);
    const packet = store.save({
      itemId: 't',
      filename: 'origin.json',
      title: 'Reviewed source',
      bytes: Buffer.from('SOURCE-CAPTURE-BYTES'),
      sessionId: 'source-capture:fixture',
    });
    store.close();
    expect((await request(app).get('/api/telos/items/t/artifacts')).body.artifacts).toEqual([]);
    expect((await call('find', { itemId: 't' })).body.artifacts).toEqual([]);
    expect((await call('read', { id: packet.id, revision: 1 })).status).toBe(403);
    expect((await request(app).get(packet.url).set('X-Internal-Token', 'token')).status).toBe(403);
    const authorized = await request(app).get(packet.url).set('X-Fixture-Operator', 'yes');
    expect(authorized.status).toBe(200);
    expect(authorized.body.toString()).toBe('SOURCE-CAPTURE-BYTES');
  });

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
    expect(logs.warn).not.toHaveBeenCalled();
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

describe('work output listing', () => {
  it('lists the latest saved file revisions without requiring a running agent or returning bodies', async () => {
    const { app, call, readFile, path } = setup();
    const db = new Database(path);
    db.prepare('INSERT INTO items VALUES (?, ?)').run('other', 'Other work');
    db.close();
    await call('save', {
      itemId: 't',
      filename: 'notes.md',
      title: 'Notes',
      content: '# Draft',
      requestId: 'draft',
    });
    const latest = await call('save', {
      itemId: 't',
      filename: 'notes.md',
      title: 'Notes',
      content: '# Revised',
      requestId: 'revision',
    });
    readFile.mockResolvedValueOnce({
      path: '/sandbox/bundle.zip',
      bytes: Buffer.from([80, 75, 3, 4, 255]),
    });
    const bundle = await call('save', {
      itemId: 't',
      filename: 'bundle.zip',
      title: 'Bundle',
      path: '/sandbox/bundle.zip',
      requestId: 'bundle',
    });
    await call('save', {
      itemId: 'other',
      filename: 'private.md',
      title: 'Other output',
      content: 'Other',
      requestId: 'other',
    });
    const response = await request(app).get('/api/telos/items/t/artifacts');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.artifacts).toHaveLength(2);
    expect(response.body.artifacts).toEqual(
      expect.arrayContaining([latest.body.artifact, bundle.body.artifact]),
    );
    expect(
      response.body.artifacts.every(
        (a: Record<string, unknown>) => !('bytes' in a) && !('content' in a),
      ),
    ).toBe(true);
    expect(response.body.limit).toBe(100);
    const download = await request(app).get(bundle.body.artifact.url);
    expect(download.body).toEqual(Buffer.from([80, 75, 3, 4, 255]));
  });
  it('distinguishes an empty list from unavailable storage', async () => {
    const { app, path } = setup();
    expect((await request(app).get('/api/telos/items/t/artifacts')).body.artifacts).toEqual([]);
    rmSync(path);
    const unavailable = await request(app).get('/api/telos/items/t/artifacts');
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.artifacts).toBeUndefined();
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith(
      'Telos artifact operation failed',
      expect.objectContaining({
        code: 'telos_artifact_unavailable',
        phase: 'list_artifacts',
        reason: 'sqlite_unavailable',
      }),
    );
  });
  it('rejects invalid work identity instead of returning all artifacts', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/telos/items/%20/artifacts')).status).toBe(400);
  });
});
