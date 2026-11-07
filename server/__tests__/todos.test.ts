import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { join } from 'path';
import { tmpdir } from 'os';
import { INTERNAL_TOKEN } from '../internal-token.js';
import { EventStore } from '../event-store.js';
import { randomUUID } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';

const TEST_REPO = join(tmpdir(), `mitzo-test-repo-${process.pid}`);
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
let authCookie: string;
let fixture: ReturnType<typeof createTelosCanonicalData>;
const outcome = {
  summary: 'Ship reliable Telos',
  intent: 'Track work in Mitzo',
  rationale: 'Preserve durable progress',
  acceptanceCriteria: ['Edits survive restart'],
  milestones: ['Verify persistence'],
  profile: 'work',
  idempotencyKey: 'native-http-outcome',
};
beforeAll(async () => {
  mkdirSync(join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive'), { recursive: true });
  app = (await import('../app.js')).app;
  const login = await request(app)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  authCookie = login.headers['set-cookie'][0].split(';')[0];
});
beforeEach(() => {
  fixture = createTelosCanonicalData();
  vi.stubEnv('TELOS_DB_PATH', fixture.dbPath);
});
afterEach(() => {
  sourceSessions.clear();
  sourceEvents.clear();
  fixture.close();
  vi.unstubAllEnvs();
});
const get = (url: string) => request(app).get(url).set('Cookie', authCookie);
const post = (url: string, body: unknown) =>
  request(app)
    .post(url)
    .set('Cookie', authCookie)
    .send(body as object);
describe('Mitzo-owned Telos HTTP', () => {
  it.each(['/api/todos', '/api/telos/items/t/artifacts'])(
    'requires authentication for %s',
    async (url) => {
      expect((await request(app).get(url)).status).toBe(401);
    },
  );
  it.each([
    ['/api/todos', { summary: 'Denied', profile: 'manual' }],
    ['/api/todos/outcomes', outcome],
    ['/api/todos/studio/action', { action: 'ack' }],
  ])('requires operator authority for %s', async (url, body) => {
    expect((await request(app).post(url).send(body)).status).toBe(401);
    expect(
      (await request(app).post(url).set('X-Internal-Token', INTERNAL_TOKEN).send(body)).status,
    ).toBe(403);
  });
  it.each([
    ['/api/todos', {}],
    ['/api/todos', { profile: 'work' }],
    ['/api/todos', { summary: '', profile: 'work' }],
    ['/api/todos/outcomes', { summary: 'Vague' }],
    ['/api/todos/studio/action', { action: 'bad' }],
    ['/api/todos/studio/action', { action: 'priority' }],
    ['/api/todos/studio/action', { action: 'priority', priority: 11 }],
  ])('validates %s (%j)', async (url, body) => {
    expect((await post(url, body)).status).toBe(400);
  });
  it('lists canonical saved IDs without any Python script', async () => {
    const result = await get('/api/todos');
    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({
      id: 'studio',
      summary: 'Home studio',
      priority: 8,
    });
    expect((await get('/api/todos?profile=missing')).body.items).toEqual([]);
  });
  it('rejects source-import refresh and invalid lifecycle views', async () => {
    expect((await get('/api/todos?refresh=true')).status).toBe(400);
    expect((await get('/api/todos?view=all')).status).toBe(400);
    for (const view of ['archive', 'trash'])
      expect(
        (
          await request(app)
            .get('/api/todos?view=' + view)
            .set('X-Internal-Token', INTERNAL_TOKEN)
        ).status,
      ).toBe(403);
  });
  it('creates a child under its stored parent and rejects a missing parent atomically', async () => {
    const result = await post('/api/todos', {
      summary: 'Child',
      profile: 'manual',
      parentId: 'studio',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.item.parentId).toBe('studio');
    const before = fixture.db.prepare('SELECT count(*) AS n FROM items').get();
    expect(
      (await post('/api/todos', { summary: 'Invalid', profile: 'manual', parentId: 'missing' }))
        .status,
    ).toBe(404);
    expect(fixture.db.prepare('SELECT count(*) AS n FROM items').get()).toEqual(before);
  });
  it('creates outcomes atomically, replays the exact key and rejects changed input', async () => {
    const created = await post('/api/todos/outcomes', outcome);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.item.childCount).toBe(1);
    const replay = await post('/api/todos/outcomes', outcome);
    expect(replay.status).toBe(200);
    expect(replay.body.item.id).toBe(created.body.item.id);
    expect((await post('/api/todos/outcomes', { ...outcome, intent: 'Different' })).status).toBe(
      409,
    );
    expect(
      fixture.db
        .prepare('SELECT count(*) AS n FROM items WHERE parent_id=?')
        .get(created.body.item.id),
    ).toEqual({ n: 1 });
  });
  it.each([
    ['star', true],
    ['unstar', false],
    ['ack', 'acknowledged'],
    ['priority', 9],
  ])('persists %s in the selected database', async (action, value) => {
    const result = await post('/api/todos/studio/action', {
      action,
      ...(action === 'priority' ? { priority: 9 } : {}),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const row = fixture.db
      .prepare('SELECT starred,status,priority FROM items WHERE id=?')
      .get('studio') as { starred: number; status: string; priority: number };
    expect(
      action === 'priority' ? row.priority : action === 'ack' ? row.status : !!row.starred,
    ).toBe(value);
  });
  it('completes children before their parent and retains canonical history', async () => {
    const child = await post('/api/todos', {
      summary: 'Child',
      profile: 'manual',
      parentId: 'studio',
    });
    expect((await post('/api/todos/studio/action', { action: 'done' })).status).toBe(409);
    expect(
      (await post('/api/todos/' + child.body.item.id + '/action', { action: 'done' })).status,
    ).toBe(200);
    expect((await get('/api/todos')).body.items[0].completedChildCount).toBe(1);
    expect((await post('/api/todos/studio/action', { action: 'done' })).status).toBe(200);
    expect((await get('/api/todos')).body.items).toEqual([]);
    expect(
      fixture.db.prepare("SELECT count(*) AS n FROM history WHERE new_status='completed'").get(),
    ).toEqual({ n: 2 });
  });
  it('returns missing-item and unavailable-store failures instead of empty success', async () => {
    expect((await post('/api/todos/missing/action', { action: 'star' })).status).toBe(404);
    vi.stubEnv('TELOS_DB_PATH', fixture.dbPath + '.missing');
    expect((await get('/api/todos')).status).toBe(503);
  });
  it('renews an expired snooze once and retains its history', async () => {
    fixture.db
      .prepare("UPDATE items SET status='snoozed',snoozed_until='2000-01-01' WHERE id='studio'")
      .run();
    for (let n = 0; n < 2; n++) {
      const result = await get('/api/todos');
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.items[0]).toMatchObject({ id: 'studio', status: 'active' });
    }
    expect(
      fixture.db
        .prepare(
          "SELECT count(*) AS n FROM history WHERE old_status='snoozed' AND new_status='active'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it('returns large stored briefs without a subprocess buffer limit', async () => {
    fixture.db.prepare('UPDATE items SET summary=? WHERE id=?').run('x'.repeat(1100000), 'studio');
    const result = await get('/api/todos');
    expect(result.status).toBe(200);
    expect(result.body.items[0].summary).toHaveLength(1100000);
  });
  it('preserves hierarchy and priority across archive, trash, restore and unarchive', async () => {
    const child = await post('/api/todos', {
      summary: 'Child',
      profile: 'manual',
      parentId: 'studio',
    });
    await post('/api/todos/' + child.body.item.id + '/action', { action: 'priority', priority: 3 });
    for (const [operation, view] of [
      ['archive', 'archive'],
      ['trash', 'trash'],
      ['restore', 'archive'],
      ['unarchive', 'active'],
    ]) {
      const current = await get('/api/telos/work/items/studio/lifecycle');
      const result = await post('/api/telos/work/lifecycle', {
        itemId: 'studio',
        requestId: randomUUID(),
        expectedRevision: current.body.revision,
        operation,
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const listed = await get('/api/todos?view=' + view);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body.items[0].children[0]).toMatchObject({
        id: child.body.item.id,
        priority: 3,
      });
    }
  });
  it('reads committed lifecycle state while another writer has an uncommitted change', async () => {
    fixture.work.executeLifecycle(
      {
        operation: 'archive',
        itemId: 'studio',
        requestId: 'archive',
        expectedRevision: fixture.work.read('studio', fixture.actor).revision,
      },
      fixture.actor,
    );
    const writer = new Database(fixture.dbPath);
    try {
      writer.exec('BEGIN IMMEDIATE');
      writer
        .prepare(
          "UPDATE telos_work_lifecycle SET data=json_set(data,'$.disposition','active') WHERE item_id='studio'",
        )
        .run();
      const result = await get('/api/todos');
      expect(result.status).toBe(200);
      expect(result.body.items).toEqual([]);
      expect(writer.inTransaction).toBe(true);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });
  it('never executes mutable workspace Python during native CRUD', async () => {
    const directory = join(TEST_REPO, 'command_center');
    mkdirSync(directory, { recursive: true });
    const canary = join(directory, 'authority-canary.txt');
    writeFileSync(canary, 'original');
    writeFileSync(
      join(directory, 'todo_api.py'),
      `import pathlib\npathlib.Path(${JSON.stringify(canary)}).write_text("compromised")\nraise RuntimeError("must not run")\n`,
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', join(TEST_REPO, 'missing-enrollment.json'));
    expect((await post('/api/todos', { summary: 'Native only', profile: 'manual' })).status).toBe(
      201,
    );
    expect((await get('/api/todos')).status).toBe(200);
    expect(readFileSync(canary, 'utf8')).toBe('original');
  });
  it('keeps token-only source creation retired and agent progress tied to an active session', async () => {
    expect(
      (
        await request(app)
          .post('/api/internal/telos/outcomes')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .send(outcome)
      ).status,
    ).toBe(409);
    sourceSessions.set('source-client', 'planning');
    expect(
      (
        await request(app)
          .post('/api/internal/telos/outcomes')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .set('X-Client-Id', 'source-client')
          .send(outcome)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/internal/telos/items/update')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .set('X-Client-Id', 'closed')
          .send({ itemId: 'studio' })
      ).status,
    ).toBe(409);
  });
  it('creates a reviewed source-backed outcome through the native owner and retains its original exchange', async () => {
    const id = 'planning-7';
    sourceSessions.set('source-client', id);
    sourceEvents.set(id, fixture.events);
    fixture.events.upsertSession({
      sessionId: id,
      conversationSource: 'mitzo',
      summary: 'Original planning',
    });
    const sequence = fixture.events.append(id, 'user_message', {
      messageId: 'original',
      text: 'Keep this exact original planning exchange.',
    });
    const selection = {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: id,
      boundary: { sequence, messageId: 'original' },
      mode: 'selected',
      messageIds: ['original'],
      artifacts: [],
      purpose: 'Preserve original planning',
      joiningBrief: '',
    };
    const { idempotencyKey, ...proposal } = outcome;
    void idempotencyKey;
    const body = { requestId: randomUUID(), outcome: proposal, selection };
    const preview = await post('/api/telos/work/source/outcome/preview', body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const created = await post('/api/telos/work/source/outcome/create', {
      ...body,
      previewSha256: preview.body.sha256,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.work.sources[0].selection.messageIds).toEqual(['original']);
    expect(
      fixture.db.prepare('SELECT count(*) AS n FROM items WHERE idempotency_key IS NOT NULL').get(),
    ).toEqual({ n: 1 });
  });
});
