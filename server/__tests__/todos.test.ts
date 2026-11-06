import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { EventStore } from '../event-store.js';
import { TelosRuntimeStore } from '../telos-runtime-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { INTERNAL_TOKEN } from '../internal-token.js';

const TEST_REPO = join(tmpdir(), `mitzo-test-repo-${process.pid}`);
const TODO_SCRIPT = join(TEST_REPO, 'command_center', 'todo_api.py');
const sourceSessions = vi.hoisted(() => new Map<string, string>());
const sourceEvents = vi.hoisted(() => new Map<string, EventStore>());
vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-test-repo-${process.pid}`);
  return {
    broadcastDurableSymposiumEvent: vi.fn(),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn().mockResolvedValue(undefined),
    hideSession: vi.fn(),
    hideAllSessions: vi.fn(),
    BASE_REPO: repo,
    getRepoConfig: vi.fn(() => ({
      quickActions: [],
      allowedPaths: [],
      roots: [{ label: 'Main', path: repo }],
      resolvedVenvPaths: [],
      toolTierOverrides: {},
      inboxPath: 'mgmt_lib/inbox',
      resolvedInboxPath: pjoin(repo, 'mgmt_lib/inbox'),
      repos: {},
      contextBlocks: {},
    })),
    getMcpServerNames: vi.fn().mockReturnValue([]),
    AVAILABLE_MODELS: [{ id: 'test-model', label: 'Test', desc: 'Test model' }],
    registry: {
      get: vi.fn((id: string) =>
        sourceSessions.has(id) ? { sessionId: sourceSessions.get(id) } : undefined,
      ),
    },
    eventStore: {
      getEventsAfter: vi.fn(
        (id: string, after: number, limit: number) =>
          sourceEvents.get(id)?.getEventsAfter(id, after, limit) ?? [],
      ),
      getSession: vi.fn(
        (id: string) =>
          sourceEvents.get(id)?.getSession(id) ??
          ([...sourceSessions.values()].includes(id)
            ? { sessionId: id, conversationSource: 'mitzo' }
            : null),
      ),
    },
    setTaskStore: vi.fn(),
  };
});

vi.mock('../permissions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions.js')>()),
  resolvePending: vi.fn().mockReturnValue(true),
}));

vi.mock('../worktree.js', () => ({
  listWorktrees: vi.fn().mockReturnValue([]),
  cleanupStaleWorktrees: vi.fn(),
}));

vi.mock('../git-version.js', () => ({
  getLocalCommit: vi.fn().mockReturnValue('abc1234'),
  isUpdateAvailable: vi.fn().mockReturnValue(false),
}));

let app: Express;
let cookie: string;
let path: string;
let root: string;
let store: TelosRuntimeStore;
beforeAll(async () => {
  mkdirSync(join(TEST_REPO, 'command_center'), { recursive: true });
  mkdirSync(join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive'), { recursive: true });
  app = (await import('../app.js')).app;
  const login = await request(app)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  const cookies = login.headers['set-cookie'];
  cookie = (Array.isArray(cookies) ? cookies[0] : cookies).split(';')[0];
});
beforeEach(() => {
  root = mkdtempSync(join(TEST_REPO, 'native-telos-'));
  path = join(root, 'telos.db');
  TelosRuntimeStore.initialize(path);
  vi.stubEnv('TELOS_DB_PATH', path);
  store = new TelosRuntimeStore(path);
});
afterEach(() => {
  store.close();
  for (const event of sourceEvents.values()) event.close();
  sourceEvents.clear();
  sourceSessions.clear();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(TODO_SCRIPT, { force: true });
});
afterAll(() => rmSync(TEST_REPO, { recursive: true, force: true }));

describe('assembled native Telos routes', () => {
  it('requires authentication and keeps token-only mutation routes retired', async () => {
    sourceSessions.set('client-7', 'planning-7');
    expect((await request(app).get('/api/todos')).status).toBe(401);
    expect(
      (await request(app).post('/api/todos').send({ summary: 'Task', profile: 'work' })).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/internal/telos/outcomes')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .set('X-Client-Id', 'client-7')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/todos')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .send({ summary: 'Task', profile: 'work' })
      ).status,
    ).toBe(403);
  });
  it('creates and lists work when no MGMT entrypoint exists', async () => {
    const created = await request(app)
      .post('/api/todos')
      .set('Cookie', cookie)
      .send({ summary: 'Native work', profile: 'manual' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const listed = await request(app).get('/api/todos').set('Cookie', cookie);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items[0]).toMatchObject({
      id: created.body.item.id,
      summary: 'Native work',
      priority: 5,
    });
    expect(
      (await request(app).get('/api/todos?profile=other').set('Cookie', cookie)).body.items,
    ).toEqual([]);
  });
  it('never executes an edited MGMT script or changes its configured authority', async () => {
    const sentinel = join(root, 'authority.txt');
    writeFileSync(sentinel, 'original');
    writeFileSync(
      TODO_SCRIPT,
      `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).write_text('compromised')\nraise RuntimeError('workspace code executed')\n`,
    );
    expect((await request(app).get('/api/todos').set('Cookie', cookie)).status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/todos')
          .set('Cookie', cookie)
          .send({ summary: 'Safe', profile: 'work' })
      ).status,
    ).toBe(201);
    expect(readFileSync(sentinel, 'utf8')).toBe('original');
  });
  it('validates bodies, reports missing items and preserves numeric priority', async () => {
    expect(
      (await request(app).post('/api/todos').set('Cookie', cookie).send({ profile: 'work' }))
        .status,
    ).toBe(400);
    const item = store.create({ summary: 'Priority', profile: 'work' }).item;
    expect(
      (
        await request(app)
          .post(`/api/todos/${item.id}/action`)
          .set('Cookie', cookie)
          .send({ action: 'priority', priority: 8 })
      ).body,
    ).toEqual({ ok: true });
    expect(
      (
        await request(app)
          .post('/api/todos/missing/action')
          .set('Cookie', cookie)
          .send({ action: 'ack' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/todos').set('Cookie', cookie)).body.items[0].priority,
    ).toBe(8);
  });
  it('creates structured outcomes and recovers the same canonical IDs', async () => {
    const input = {
      summary: 'Outcome',
      intent: 'Result',
      rationale: 'Why',
      acceptanceCriteria: ['Evidence'],
      milestones: ['First', 'Second'],
      profile: 'manual',
      idempotencyKey: 'same-request',
    };
    const first = await request(app).post('/api/todos/outcomes').set('Cookie', cookie).send(input);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.item.children.map((c: { summary: string }) => c.summary)).toEqual([
      'First',
      'Second',
    ]);
    const second = await request(app).post('/api/todos/outcomes').set('Cookie', cookie).send(input);
    expect(second.status).toBe(200);
    expect(second.body.item.id).toBe(first.body.item.id);
  });
  it('projects archive/trash from the selected database and permits internal active reads only', async () => {
    const id = store.create({ summary: 'Archived work', profile: 'manual' }).item.id;
    const work = new TelosWorkStore(path, { ordinaryConversation: () => false });
    try {
      const actor = { kind: 'operator' as const, id: 'offline-operator' };
      const view = work.read(id, actor);
      work.executeLifecycle(
        {
          operation: 'archive',
          itemId: id,
          requestId: randomUUID(),
          expectedRevision: view.revision,
        },
        actor,
      );
    } finally {
      work.close();
    }
    const active = await request(app).get('/api/todos').set('X-Internal-Token', INTERNAL_TOKEN);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.items).toEqual([]);
    expect(
      (await request(app).get('/api/todos?view=archive').set('X-Internal-Token', INTERNAL_TOKEN))
        .status,
    ).toBe(403);
    const archive = await request(app).get('/api/todos?view=archive').set('Cookie', cookie);
    expect(archive.status, JSON.stringify(archive.body)).toBe(200);
    expect(archive.body.items[0].id).toBe(id);
  });
  it('uses the native creator for approved source capture and retains origin and milestone links', async () => {
    const events = new EventStore(join(root, 'events.db'));
    events.upsertSession({
      sessionId: 'planning-7',
      conversationSource: 'mitzo',
      summary: 'Planning',
    });
    const sequence = events.append('planning-7', 'user_message', {
      messageId: 'reviewed-message',
      text: 'Keep this work.',
    });
    sourceEvents.set('planning-7', events);
    sourceSessions.set('client-7', 'planning-7');
    const selection = {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning-7',
      boundary: { sequence, messageId: 'reviewed-message' },
      mode: 'selected',
      messageIds: ['reviewed-message'],
      artifacts: [],
      purpose: 'Keep reviewed work',
      joiningBrief: '',
    };
    const outcome = {
      summary: 'Reviewed outcome',
      intent: 'Result',
      rationale: 'Why',
      acceptanceCriteria: ['Evidence'],
      milestones: ['One slice'],
      profile: 'manual',
    };
    const body = { requestId: randomUUID(), selection, outcome };
    const preview = await request(app)
      .post('/api/telos/work/source/outcome/preview')
      .set('Cookie', cookie)
      .send(body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const created = await request(app)
      .post('/api/telos/work/source/outcome/create')
      .set('Cookie', cookie)
      .send({ ...body, previewSha256: preview.body.sha256 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.work.itemId;
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare('SELECT summary FROM items WHERE id=?').get(id)).toEqual({
        summary: 'Reviewed outcome',
      });
      expect(db.prepare('SELECT summary FROM items WHERE parent_id=?').all(id)).toEqual([
        { summary: 'One slice' },
      ]);
      expect(db.prepare('SELECT role,conversation_id FROM telos_work_links').all()).toEqual([
        { role: 'origin', conversation_id: 'planning-7' },
      ]);
      expect(db.prepare('SELECT * FROM telos_work_attempts').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
