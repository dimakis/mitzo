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
  const creationDb = new Database(path);
  creationDb.exec(
    'ALTER TABLE items ADD COLUMN idempotency_key TEXT; CREATE UNIQUE INDEX creation_identity ON items(idempotency_key)',
  );
  creationDb.close();
  const createOutcome = vi.fn(
    async (body: {
      idempotencyKey: string;
      summary: string;
      intent: string;
      rationale: string;
      acceptanceCriteria: string[];
      profile: string;
      milestones: string[];
      contextHints?: Record<string, unknown>;
    }) => {
      const db = new Database(path);
      try {
        const existing = db
          .prepare('SELECT id FROM items WHERE idempotency_key=?')
          .get(body.idempotencyKey) as { id: string } | undefined;
        if (existing) return { itemId: existing.id };
        const hints = body.contextHints ?? {};
        db.prepare(
          "INSERT INTO items VALUES('created',NULL,?,?,?,?,?,'active',1,?,NULL,'created',?)",
        ).run(
          body.summary,
          body.intent,
          body.rationale,
          JSON.stringify(body.acceptanceCriteria),
          body.profile,
          JSON.stringify({
            ...hints,
            doc_ids: hints.docIds ?? [],
            jira_keys: hints.jiraKeys ?? [],
            task_hint: hints.taskHint ?? '',
            session_ids: hints.sessionIds ?? [],
          }),
          body.idempotencyKey,
        );
        body.milestones.forEach((title, i) =>
          db
            .prepare(
              "INSERT INTO items VALUES(?,'created',?,'','','[]',?,'active',0,'{}',NULL,'created',NULL)",
            )
            .run('created-slice-' + i, title, body.profile),
        );
        return { itemId: 'created' };
      } finally {
        db.close();
      }
    },
  );
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
      createOutcome,
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
  return { app, events, selection, dbPath, post, createOutcome };
}
describe('authenticated Telos source capture API', () => {
  it('reports unsupported inline images as an actionable selection error without creating work', async () => {
    const f = fixture();
    const sequence = f.events.append('origin', 'user_message', {
      messageId: 'mock',
      text: 'Use this mock',
      images: ['data:image/png;base64,fixture'],
    });
    const response = await f.post('preview', {
      itemId: 'item',
      selection: {
        ...f.selection,
        mode: 'conversation_so_far',
        messageIds: [],
        boundary: { sequence, messageId: 'mock' },
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid');
    expect(response.body.error).toMatch(/images.*retained materials/);
    expect(f.createOutcome).not.toHaveBeenCalled();
    expect(f.events.listSessions()).toHaveLength(1);
  });

  it('creates one reviewed outcome through the canonical owner and returns its source-only work receipt', async () => {
    const f = fixture();
    const proposal = {
      requestId: 'save-from-chat',
      selection: f.selection,
      outcome: {
        summary: 'Saved from discussion',
        intent: 'Deliver it',
        rationale: 'Why',
        acceptanceCriteria: ['Approved'],
        profile: 'manual',
        milestones: ['Slice one'],
      },
    };
    const preview = await f.post('outcome/preview', proposal);
    expect(preview.status).toBe(200);
    expect(f.createOutcome).not.toHaveBeenCalled();
    const input = { ...proposal, previewSha256: preview.body.sha256 };
    const response = await f.post('outcome/create', input);
    expect(response.status).toBe(200);
    expect(response.body.work).toMatchObject({
      itemId: 'created',
      kind: 'outcome',
      assignments: [],
      attempts: [],
      links: [{ role: 'origin' }],
    });
    expect((await f.post('outcome/create', input)).body).toEqual(response.body);
    expect(f.createOutcome).toHaveBeenCalledTimes(1);
    expect(f.events.listSessions()).toHaveLength(1);
  });
  it('pins the route, application registration and client API implementation', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    for (const file of [
      '../telos-source-routes.ts',
      '../telos-outcome-owner.ts',
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
