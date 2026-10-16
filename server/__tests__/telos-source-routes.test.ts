import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { EventStore } from '../event-store.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { readFileSync } from 'node:fs';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-source-api-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,profile TEXT,status TEXT,starred INTEGER,context_hints TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO items VALUES('item',NULL,'Outcome','Result','Why','["Evidence"]','manual','active',0,'{}',NULL,'original');
    CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.close();
  const events = new EventStore(join(root, 'events.db'));
  cleanups.push(() => events.close());
  events.upsertSession({ sessionId: 'origin', conversationSource: 'mitzo' });
  const sequence = events.append('origin', 'user_message', {
    messageId: 'message',
    text: 'The actual agreed exchange.',
  });
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'origin',
    mode: 'selected',
    boundary: { sequence, messageId: 'message' },
    messageIds: ['message'],
    artifacts: [],
    purpose: 'Save source',
    joiningBrief: '',
  };
  const dbPath = vi.fn(() => path);
  const app = express();
  app.use(express.json());
  app.use(
    createTelosSourceRouter({
      dbPath,
      events,
      ordinaryConversation: (id) => id === 'origin',
      operatorAuth: (req, res, next) => {
        if (req.headers['x-operator'] !== 'authenticated') {
          res.status(403).json({ code: 'unauthorized' });
          return;
        }
        res.locals.authSession = { id: 'host-verified-user' };
        next();
      },
    }),
  );
  const post = (action: string, body: object) =>
    request(app)
      .post('/api/telos/work/source/' + action)
      .set('x-operator', 'authenticated')
      .send(body);
  return { app, events, selection, dbPath, post };
}
describe('authenticated Telos source capture API', () => {
  it('pins the route, application registration and client API implementation', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    for (const file of [
      '../telos-source-routes.ts',
      '../app.ts',
      '../../packages/client/src/telos-work-api.ts',
    ])
      expect(manifest[file], file).toBe(
        reviewedHandlerSourceFingerprint(
          readFileSync(new URL(file, new URL('../connections/', import.meta.url)), 'utf8'),
        ),
      );
  });
  it('requires interactive authority before canonical reads; internal credentials and caller actors are insufficient', async () => {
    const f = fixture();
    const url = '/api/telos/work/source/preview';
    expect(
      (await request(f.app).post(url).send({ itemId: 'item', selection: f.selection })).status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post(url)
          .set('x-internal-token', 'host')
          .send({ itemId: 'item', selection: f.selection })
      ).status,
    ).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
    expect(
      (
        await request(f.app)
          .post(url)
          .set('x-operator', 'authenticated')
          .set('origin', 'https://untrusted.invalid')
          .send({ itemId: 'item', selection: f.selection })
      ).status,
    ).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
    expect(
      (await f.post('preview', { itemId: 'item', selection: f.selection, actor: 'fake' })).status,
    ).toBe(400);
    expect(f.dbPath).not.toHaveBeenCalled();
  });
  it('previews, explicitly adopts and reads the exact retained boundary with no hidden execution', async () => {
    const f = fixture();
    const preview = await f.post('preview', { itemId: 'item', selection: f.selection });
    expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.body.packet.actorId).toBe('operator:host-verified-user');
    const input = {
      itemId: 'item',
      requestId: 'adopt',
      expectedRevision: preview.body.packet.workRevision,
      previewSha256: preview.body.sha256,
      selection: f.selection,
    };
    const adopted = await f.post('adopt', input);
    expect(adopted.status).toBe(200);
    expect((await f.post('adopt', input)).body).toEqual(adopted.body);
    expect(adopted.body.work).toMatchObject({
      assignments: [],
      attempts: [],
      links: [{ role: 'origin' }],
    });
    const snapshotId = adopted.body.work.sources[0].snapshotId;
    const read = await request(f.app)
      .get('/api/telos/work/items/item/sources/' + snapshotId)
      .set('x-operator', 'authenticated');
    expect(read.status).toBe(200);
    expect(read.body.packet).toEqual(preview.body.packet);
    expect(read.body.sourceHref).toContain('/chat/origin?telosItem=item&telosSource=');
    expect(
      (await request(f.app).get('/api/telos/work/items/item/sources/' + snapshotId)).status,
    ).toBe(403);
    expect(f.events.listSessions()).toHaveLength(1);
  });
  it('returns conflicts and safe owner failures without accepting caller-supplied source bytes', async () => {
    const f = fixture();
    const preview = await f.post('preview', { itemId: 'item', selection: f.selection });
    const body = {
      itemId: 'item',
      requestId: 'adopt',
      expectedRevision: preview.body.packet.workRevision,
      previewSha256: '0'.repeat(64),
      selection: f.selection,
    };
    expect((await f.post('adopt', body)).status).toBe(409);
    expect((await f.post('adopt', { ...body, packet: preview.body.packet })).status).toBe(400);
    f.dbPath.mockImplementation(() => {
      throw Error('/private/credentials/source.db');
    });
    const failure = await f.post('preview', { itemId: 'item', selection: f.selection });
    expect(failure.status).toBe(503);
    expect(failure.text).not.toContain('/private/');
  });
});
