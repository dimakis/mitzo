import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { SessionOutputReferences } from '../session-output-references.js';
import { createSessionOutputRouter, outputContextPackageDigest } from '../session-output-routes.js';

const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
function setup() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo' });
  store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
  store.append('source', 'message_start', { messageId: 'message' });
  store.append('source', 'block_start', {
    messageId: 'message',
    blockId: 'draft',
    blockType: 'text',
  });
  store.append('source', 'block_delta', {
    messageId: 'message',
    blockId: 'draft',
    delta: 'Exact draft',
  });
  store.append('source', 'block_end', {
    messageId: 'message',
    blockId: 'draft',
    blockType: 'text',
  });
  store.append('source', 'message_end', { messageId: 'message' });
  const references = new SessionOutputReferences(store);
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions/:id/outputs',
    (req, res, next) => {
      if (req.headers['x-operator'] !== 'authorized') {
        res.sendStatus(401);
        return;
      }
      next();
    },
    createSessionOutputRouter({ references, hasSession: (id) => !!store.getSession(id) }),
  );
  const get = (path = '/api/sessions/source/outputs') =>
    request(app).get(path).set('X-Operator', 'authorized');
  const post = (body: object, id = 'source') =>
    request(app).post(`/api/sessions/${id}/outputs`).set('X-Operator', 'authorized').send(body);
  const source = store.listSessionOutputCandidates('source')[0].source;
  return {
    app,
    store,
    references,
    get,
    post,
    input: { requestId: 'keep', title: 'Draft', source },
  };
}

describe('session output reference routes', () => {
  it('registers host-selected exact text, recovers retries, and returns a revision-bound context digest', async () => {
    const { get, post, input } = setup();
    const initial = await get();
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      outputs: [],
      candidates: [{ source: input.source, content: 'Exact draft' }],
    });
    expect(initial.headers['cache-control']).toBe('private, no-store');
    const saved = await post(input);
    expect(saved.status).toBe(200);
    expect(saved.body.output).toMatchObject({
      durability: 'reference_registered',
      label: 'In conversation',
      revision: 1,
    });
    expect((await post(input)).body).toEqual(saved.body);
    expect((await get()).body.outputs).toEqual([saved.body.output]);
    const read = await get(`/api/sessions/source/outputs/${saved.body.output.outputId}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      output: saved.body.output,
      content: 'Exact draft',
      contextPackageDigest: outputContextPackageDigest('source', saved.body.output),
    });
    expect(read.body.contextPackageDigest).toBe(
      createHash('sha256')
        .update(JSON.stringify(['source', saved.body.output.outputId, 1, input.source.sha256]))
        .digest('hex'),
    );
  });

  it('requires the mounted operator boundary and refuses missing/other conversation objects', async () => {
    const { app, get, post, input } = setup();
    expect((await request(app).get('/api/sessions/source/outputs')).status).toBe(401);
    expect((await request(app).post('/api/sessions/source/outputs').send(input)).status).toBe(401);
    expect((await get('/api/sessions/missing/outputs')).status).toBe(404);
    expect((await post(input, 'missing')).status).toBe(404);
    const saved = await post(input);
    expect((await get(`/api/sessions/other/outputs/${saved.body.output.outputId}`)).status).toBe(
      404,
    );
    expect((await post(input, 'other')).status).toBe(409);
  });

  it('rejects caller scope/provenance, changed retry intent and stale source hash without persistence', async () => {
    const { get, post, input } = setup();
    expect((await post({ ...input, owner: 'other' })).status).toBe(400);
    expect((await post({ ...input, source: { ...input.source, sessionId: 'other' } })).status).toBe(
      400,
    );
    expect(
      (await post({ ...input, source: { ...input.source, sha256: '0'.repeat(64) } })).status,
    ).toBe(409);
    expect((await get()).body.outputs).toEqual([]);
    await post(input);
    expect((await post({ ...input, title: 'Different' })).status).toBe(409);
    expect((await get()).body.outputs).toHaveLength(1);
  });

  it('sanitizes unknown store failures and unavailable source bodies', async () => {
    const { references, get, post, input } = setup();
    const saved = await post(input);
    vi.spyOn(references, 'read').mockImplementationOnce(() => {
      throw new Error('Session output source is unavailable');
    });
    expect((await get(`/api/sessions/source/outputs/${saved.body.output.outputId}`)).status).toBe(
      409,
    );
    vi.spyOn(references, 'register').mockImplementationOnce(() => {
      throw new Error('secret provider token /private/path');
    });
    const failed = await post({ ...input, requestId: 'different' });
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    expect(JSON.stringify(failed.body)).not.toContain('/private/path');
  });
});
