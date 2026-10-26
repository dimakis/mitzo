import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { createSessionDocumentRouter } from '../session-document-routes.js';
const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'chat', conversationSource: 'mitzo', cwd: '/task' });
  store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo', cwd: '/other' });
  const readFile = vi.fn(async (_id: string, path: string) => ({
    path: path.startsWith('/') ? path : '/task/' + path,
    bytes: Buffer.from('# Report'),
  }));
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions/:id/documents',
    (req, res, next) => {
      if (req.headers['x-operator'] !== 'yes') return void res.sendStatus(401);
      next();
    },
    createSessionDocumentRouter({
      store,
      readFile,
      listTelos: () => ({ artifacts: [], hasMore: false }),
    }),
  );
  const get = (suffix = '', id = 'chat') =>
    request(app).get(`/api/sessions/${id}/documents${suffix}`).set('X-Operator', 'yes');
  const post = (suffix: string, body: object, id = 'chat') =>
    request(app).post(`/api/sessions/${id}/documents${suffix}`).set('X-Operator', 'yes').send(body);
  const input = {
    requestId: 'keep',
    title: 'Report',
    source: { kind: 'file', path: '/task/report.md', sha256: hash('# Report') },
  };
  return { store, app, get, post, readFile, input };
}
function draft(store: EventStore, text: string) {
  store.append('chat', 'message_start', { messageId: 'm' });
  store.append('chat', 'block_start', { messageId: 'm', blockId: 'b', blockType: 'text' });
  store.append('chat', 'block_delta', { messageId: 'm', blockId: 'b', delta: text });
  store.append('chat', 'block_end', { messageId: 'm', blockId: 'b', blockType: 'text' });
  store.append('chat', 'message_end', { messageId: 'm' });
}
describe('shared conversation document routes', () => {
  it('previews and keeps an exact file, then retrieves bytes and retries after workspace removal', async () => {
    const { app, get, post, readFile, input } = setup();
    expect((await request(app).get('/api/sessions/chat/documents')).status).toBe(401);
    const preview = await post('/preview', { path: 'report.md' });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      path: '/task/report.md',
      sha256: input.source.sha256,
      content: '# Report',
    });
    const saved = await post('/keep', input);
    expect(saved.status).toBe(200);
    expect(saved.body.document).toMatchObject({
      sessionId: 'chat',
      revision: 1,
      sourcePath: '/task/report.md',
    });
    readFile.mockRejectedValue(new Error('workspace gone'));
    expect((await post('/keep', input)).body).toEqual(saved.body);
    const url = `/saved/${saved.body.document.id}?revision=1`;
    expect((await get(url)).body.content).toBe('# Report');
    const download = await get(`/saved/${saved.body.document.id}/download?revision=1`);
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toBe('private, no-store');
    expect((await get(url, 'other')).status).toBe(404);
    expect((await get()).body.saved).toEqual([saved.body.document]);
  });
  it('rejects changed files, missing revisions, retry collisions and source scope supplied by callers', async () => {
    const { get, post, input, readFile } = setup();
    expect(
      (await post('/keep', { ...input, source: { ...input.source, sha256: '0'.repeat(64) } }))
        .status,
    ).toBe(409);
    expect((await post('/keep', { ...input, sessionId: 'other' })).status).toBe(400);
    const saved = await post('/keep', input);
    expect((await post('/keep', { ...input, title: 'Changed' })).status).toBe(409);
    expect((await get(`/saved/${saved.body.document.id}`)).status).toBe(400);
    expect((await get(`/saved/${saved.body.document.id}?revision=999`)).status).toBe(404);
    readFile.mockRejectedValue(new Error('secret /private/path'));
    const failed = await post('/preview', { path: 'missing.md' });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
  });
  it('discovers successful normalized writes and assistant links without claiming they are saved or reading workspaces', async () => {
    const { store, get, readFile } = setup();
    store.append('chat', 'block_end', {
      messageId: 'tool',
      blockId: 'b',
      toolId: 'write',
      toolName: 'Write',
      rawInput: { type: 'write', path: '/task/created.md' },
    });
    store.append('chat', 'tool_result', {
      messageId: 'tool',
      toolId: 'write',
      result: 'ok',
      isError: false,
    });
    store.append('chat', 'block_end', {
      messageId: 'bad',
      blockId: 'b',
      toolId: 'failed',
      toolName: 'Write',
      rawInput: { type: 'write', path: '/task/failed.md' },
    });
    store.append('chat', 'tool_result', {
      messageId: 'bad',
      toolId: 'failed',
      result: 'failed',
      isError: true,
    });
    draft(store, '[Report](reports/my%20report.md) and https://example.com/outside.md');
    const result = await get();
    expect(result.status).toBe(200);
    expect(result.body.workspace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/task/created.md', evidence: 'created' }),
        expect.objectContaining({ path: 'reports/my report.md', evidence: 'linked' }),
      ]),
    );
    expect(result.body.workspace).toHaveLength(2);
    expect(result.body.saved).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('keeps exact finalized assistant text independently of its conversation source', async () => {
    const { store, get, post, readFile } = setup();
    draft(store, '# A useful draft');
    const source = store.listSessionOutputCandidates('chat')[0].source;
    const saved = await post('/keep', {
      requestId: 'draft',
      title: 'Useful draft',
      source: { kind: 'draft', ...source },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.document.filename).toBe('Useful draft.md');
    expect(readFile).not.toHaveBeenCalled();
    expect((await get(`/saved/${saved.body.document.id}?revision=1`)).body.content).toBe(
      '# A useful draft',
    );
  });
  it('rechecks conversation scope after an asynchronous file read', async () => {
    const { store, post, readFile, input } = setup();
    readFile.mockImplementation(async () => {
      store.upsertSession({ sessionId: 'chat', cwd: '/changed' });
      return { path: '/task/report.md', bytes: Buffer.from('# Report') };
    });
    expect((await post('/keep', input)).status).toBe(409);
    expect(store.listSessionDocuments('chat')).toEqual([]);
  });
});
