import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelosWorkRouter } from '../telos-work-routes.js';
import { revokeAuthSession } from '../auth.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import { createTelosWorkFixtures } from './fixtures/telos-work-fixtures.js';
import { TelosWorkError, TelosWorkStore } from '../telos-work-store.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) await closeTestServer(server);
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
async function setup(overrides: Partial<Parameters<typeof createTelosWorkRouter>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'telos-work-routes-'));
  roots.push(root);
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    `CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES items(id),summary TEXT,updated_at TEXT,status TEXT DEFAULT 'active',acceptance_criteria TEXT DEFAULT '[]');
     INSERT INTO items(id,parent_id,summary,updated_at) VALUES('item',NULL,'Item','original');
     CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,raw_snippet TEXT,timestamp TEXT);
     CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`,
  );
  db.close();
  const dbPath = vi.fn(() => path);
  const app = express();
  app.use(express.json());
  app.use(
    createTelosWorkRouter({
      dbPath,
      operatorAuth: (req, res, next) => {
        if (req.headers['x-operator'] !== 'authenticated') {
          res.status(403).json({ error: 'Operator required' });
          return;
        }
        res.locals.authSession = { id: 'verified-operator', expiresAt: Date.now() + 60000 };
        next();
      },
      verifyInternal: (req) => req.headers['x-internal-token'] === 'host',
      sessionId: (id) =>
        id === 'valid-client' ? 'chat' : id === 'other-client' ? 'unrelated' : undefined,
      ordinaryConversation: (id) => ['chat', 'unrelated'].includes(id),
      ...overrides,
    }),
  );
  const server = await listenOnLoopback(app);
  servers.push(server);
  const read = () =>
    request(server).get('/api/telos/work/items/item').set('x-operator', 'authenticated');
  const command = (input: object) =>
    request(server).post('/api/telos/work/commands').set('x-operator', 'authenticated').send(input);
  return { app: server, read, command, dbPath };
}
describe('authorized Telos work API', () => {
  it('rechecks the current operator before admitting a snooze-renewal writer', async () => {
    const canonical = createTelosCanonicalData();
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const original = TelosWorkStore.prototype.readCollection;
    const read = vi
      .spyOn(TelosWorkStore.prototype, 'readCollection')
      .mockImplementationOnce(function (this: TelosWorkStore, view, actor) {
        try {
          return original.call(this, view, actor);
        } finally {
          auth.expiresAt = 0;
        }
      });
    try {
      canonical.db.exec(
        "UPDATE items SET status='snoozed',snoozed_until='2000-01-01' WHERE id='studio'",
      );
      const f = await setup({
        dbPath: () => canonical.dbPath,
        operatorAuth: (_req, res, next) => {
          res.locals.authSession = auth;
          next();
        },
      });
      expect((await request(f.app).get('/api/telos/work/collection')).status).toBe(403);
      expect(canonical.work.readRecord('studio', canonical.actor).status).toBe('snoozed');
      expect(
        canonical.db.prepare("SELECT * FROM history WHERE old_status='snoozed'").all(),
      ).toEqual([]);
    } finally {
      read.mockRestore();
      canonical.close();
    }
  });

  it('renews due snoozes through the canonical owner only for an authenticated current operator', async () => {
    const canonical = createTelosCanonicalData();
    try {
      canonical.db.exec(
        "UPDATE items SET status='snoozed',snoozed_until='2000-01-01' WHERE id='studio'",
      );
      const f = await setup({ dbPath: () => canonical.dbPath });
      const path = '/api/telos/work/collection';
      expect((await request(f.app).get(path)).status).toBe(403);
      expect(canonical.work.readRecord('studio', canonical.actor).status).toBe('snoozed');
      const result = await request(f.app).get(path).set('x-operator', 'authenticated');
      expect(result.status).toBe(200);
      expect(result.body.records).toEqual([
        expect.objectContaining({ itemId: 'studio', status: 'active' }),
      ]);
      expect(canonical.work.readRecord('studio', canonical.actor).status).toBe('active');
      await request(f.app).get(path).set('x-operator', 'authenticated').expect(200);
      expect(
        canonical.db
          .prepare("SELECT old_status,new_status FROM history WHERE old_status='snoozed'")
          .all(),
      ).toEqual([{ old_status: 'snoozed', new_status: 'active' }]);
    } finally {
      canonical.close();
    }
  });

  it('upgrades missing additive lifecycle tables before native collection discovery', async () => {
    const canonical = createTelosCanonicalData();
    try {
      canonical.db.exec(
        'DROP TABLE telos_work_lifecycle_history; DROP TABLE telos_work_lifecycle_commands; DROP TABLE telos_work_lifecycle',
      );
      const f = await setup({ dbPath: () => canonical.dbPath });
      const result = await request(f.app)
        .get('/api/telos/work/collection')
        .set('x-operator', 'authenticated');
      expect(result.status).toBe(200);
      expect(result.body.records.map((record: { itemId: string }) => record.itemId)).toEqual([
        'studio',
      ]);
    } finally {
      canonical.close();
    }
  });

  it('discovers persisted records without a Python listing, with current operator authority and private responses', async () => {
    const canonical = createTelosCanonicalData();
    try {
      const f = await setup({ dbPath: () => canonical.dbPath });
      const path = '/api/telos/work/collection';
      const result = await request(f.app).get(path).set('x-operator', 'authenticated');
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body.records.map((record: { itemId: string }) => record.itemId)).toEqual([
        'studio',
      ]);
      expect(result.body.failures).toEqual([]);
      expect((await request(f.app).get(path).set('x-operator', 'foreign')).status).toBe(403);
      expect(
        (
          await request(f.app)
            .get(path)
            .query({ view: 'unknown' })
            .set('x-operator', 'authenticated')
        ).status,
      ).toBe(400);
      expect(
        (
          await request(f.app)
            .get(path)
            .query({ actorId: 'spoofed' })
            .set('x-operator', 'authenticated')
        ).status,
      ).toBe(400);
    } finally {
      canonical.close();
    }
  });

  it('hydrates a bounded batch in one authenticated read and retains per-item failures', async () => {
    const canonical = createTelosCanonicalData();
    try {
      const f = await setup({ dbPath: () => canonical.dbPath });
      const call = (input: object, operator = 'authenticated') =>
        request(f.app).post('/api/telos/work/records').set('x-operator', operator).send(input);
      const result = await call({ itemIds: ['studio', 'missing'] });
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.body.records).toEqual([canonical.work.readRecord('studio', canonical.actor)]);
      expect(result.body.failures).toEqual([{ itemId: 'missing', code: 'not_found', status: 404 }]);
      expect((await call({ itemIds: ['studio'] }, 'foreign')).status).toBe(403);
      expect((await call({ itemIds: Array(101).fill('studio') })).status).toBe(400);
      expect((await call({ itemIds: ['studio'], actorId: 'spoofed' })).status).toBe(400);
    } finally {
      canonical.close();
    }
  });
  it('reads committed canonical records without acquiring the retained writer after initialization', async () => {
    const canonical = createTelosCanonicalData();
    const writer = new Database(canonical.dbPath);
    try {
      const expected = canonical.work.readRecord('studio', canonical.actor);
      const f = await setup({ dbPath: () => canonical.dbPath });
      writer.exec('BEGIN IMMEDIATE');
      writer.prepare("UPDATE items SET summary='Uncommitted writer value' WHERE id='studio'").run();
      const response = await request(f.app)
        .get('/api/telos/work/items/studio/record')
        .set('x-operator', 'authenticated');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expected);
      expect(writer.inTransaction).toBe(true);
      expect(writer.prepare("SELECT summary FROM items WHERE id='studio'").get()).toEqual({
        summary: 'Uncommitted writer value',
      });
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK');
      writer.close();
      canonical.close();
    }
  }, 15000);

  it('preserves full extension initialization for a cold record read', async () => {
    const f = await setup();
    const response = await request(f.app)
      .get('/api/telos/work/items/item/record')
      .set('x-operator', 'authenticated');
    expect(response.status).toBe(200);
    const db = new Database(f.dbPath());
    try {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='telos_work_assignments'",
          )
          .get(),
      ).toBeDefined();
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='trigger' AND name='telos_work_main_publications_terminal'",
          )
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it.each(['telos_work_kinds', 'telos_work_attempts', 'telos_work_delegation_requests'])(
    'initializes an older record layout missing %s through the unchanged schema owner',
    async (table) => {
      const f = await setup();
      const read = () =>
        request(f.app).get('/api/telos/work/items/item/record').set('x-operator', 'authenticated');
      const original = await read();
      const db = new Database(f.dbPath());
      try {
        db.exec(`DROP TABLE ${table}`);
        const response = await read();
        expect(response.status).toBe(200);
        expect(response.body).toEqual(original.body);
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        ).toBeDefined();
      } finally {
        db.close();
      }
    },
  );

  it('retains record authentication, ID failures and strict incompatible-data error bodies', async () => {
    const f = await setup();
    expect((await request(f.app).get('/api/telos/work/items/item/record')).status).toBe(403);
    expect(
      (
        await request(f.app)
          .get('/api/telos/work/items/invalid%20id/record')
          .set('x-operator', 'authenticated')
      ).body,
    ).toEqual({ code: 'invalid', error: 'Invalid work item ID' });
    expect(f.dbPath).not.toHaveBeenCalled();
    expect(
      (
        await request(f.app)
          .get('/api/telos/work/items/missing/record')
          .set('x-operator', 'authenticated')
      ).status,
    ).toBe(404);
    const db = new Database(f.dbPath());
    try {
      db.prepare("UPDATE items SET acceptance_criteria='[7]' WHERE id='item'").run();
      const response = await request(f.app)
        .get('/api/telos/work/items/item/record')
        .set('x-operator', 'authenticated');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        code: 'unavailable',
        error: 'Telos work service unavailable',
      });
      expect(db.prepare("SELECT acceptance_criteria FROM items WHERE id='item'").get()).toEqual({
        acceptance_criteria: '[7]',
      });
    } finally {
      db.close();
    }
  });

  const receipt = {
    version: 1,
    state: 'chat_ready',
    workerConversationId: 'worker',
    workerPath: '/chat/worker',
    itemPath: '/todos/slice',
    leadPath: '/chat/chat',
    execution: 'not_started',
    attempt: {
      version: 1,
      requestId: 'start',
      attemptId: 'attempt',
      predecessorAttemptId: null,
      leadConversationId: 'chat',
      childItemId: 'slice',
      contextSnapshotId: 'context',
      state: 'chat_ready',
      workerConversationId: 'worker',
      allocationReceiptId: 'ordinary',
      executionTaskId: 'task',
      accountingGoalId: null,
      turnCommandId: null,
    },
  };
  const selectors = {
    requestId: 'start',
    childItemId: 'slice',
    mode: 'start',
    predecessorAttemptId: null,
  };
  const fullInput = () => {
    const conversation = createTelosWorkFixtures().multipleChats.conversations[0];
    return {
      ...selectors,
      leadItemId: 'outcome',
      leadConversationId: 'chat',
      expectedRevision: 'a'.repeat(64),
      settings: {
        binding: { ...conversation.binding, version: 2 },
        selection: conversation.selection,
        repositoryWorkspaceId: randomUUID(),
      },
      contextSelection: {
        version: 1,
        itemId: 'slice',
        role: 'worker',
        brief: { revision: 'a'.repeat(64), sha256: 'b'.repeat(64), text: 'Reviewed' },
        parentCriteria: [],
        overallGoal: { itemId: 'outcome', revision: 'a'.repeat(64), text: 'Goal' },
        sources: [],
        artifacts: [],
        leadConversationId: 'chat',
      },
    };
  };
  it('routes exact operator delegation with ordinary auth and canonical receipt validation', async () => {
    const delegateSlice = vi.fn(async (input) => {
      input.assertAuthorized();
      expect(input.actor).toEqual({ kind: 'operator', id: 'verified-operator' });
      expect(input.authorization.id).toBe('verified-operator');
      return receipt;
    });
    const f = await setup({ delegateSlice });
    const body = fullInput();
    const result = await request(f.app)
      .post('/api/telos/work/delegation/start')
      .set('x-operator', 'authenticated')
      .send(body);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(receipt);
    expect(delegateSlice.mock.calls[0][0].raw).toEqual(body);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(
      (
        await request(f.app)
          .post('/api/telos/work/delegation/start')
          .set('x-internal-token', 'host')
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post('/api/telos/work/delegation/start')
          .set('x-operator', 'authenticated')
          .set('origin', 'https://foreign.invalid')
          .send(body)
      ).status,
    ).toBe(403);
    expect(delegateSlice).toHaveBeenCalledOnce();
  });
  it('rejects selector-only operator input and raw legacy attempt commands', async () => {
    const delegateSlice = vi.fn(async () => receipt);
    const f = await setup({ delegateSlice });
    expect(
      (
        await request(f.app)
          .post('/api/telos/work/delegation/start')
          .set('x-operator', 'authenticated')
          .send(selectors)
      ).status,
    ).toBe(400);
    const conversation = createTelosWorkFixtures().multipleChats.conversations[0];
    const result = await f.command({
      operation: 'request_attempt',
      itemId: 'item',
      requestId: 'legacy',
      expectedRevision: (await f.read()).body.revision,
      attemptId: 'legacy',
      predecessorAttemptId: null,
      leadConversationId: 'chat',
      contextSnapshotId: 'context',
      configuration: { binding: conversation.binding, selection: conversation.selection },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/exact delegation/i);
    expect(delegateSlice).not.toHaveBeenCalled();
  });
  it('revokes operator delegation across its host wait and redacts private host failures', async () => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const delegateSlice = vi.fn(async () => {
      revokeAuthSession(auth);
      return receipt;
    });
    const f = await setup({
      delegateSlice,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = auth;
        next();
      },
    });
    expect(
      (await request(f.app).post('/api/telos/work/delegation/start').send(fullInput())).status,
    ).toBe(403);
    const broken = await setup({
      delegateSlice: async () => {
        throw new TelosWorkError('conflict', '/private/credential/token');
      },
    });
    const result = await request(broken.app)
      .post('/api/telos/work/delegation/start')
      .set('x-operator', 'authenticated')
      .send(fullInput());
    expect(result.status).toBe(409);
    expect(result.text).not.toContain('/private');
    const invalid = await setup({
      delegateSlice: async () => ({ private: '/private/credentials' }),
    });
    const output = await request(invalid.app)
      .post('/api/telos/work/delegation/start')
      .set('x-operator', 'authenticated')
      .send(fullInput());
    expect(output.status).toBe(503);
    expect(output.text).not.toContain('/private');
  });
  const internal = (
    app: Server,
    body: Record<string, unknown>,
    client = 'valid-client',
    token = 'host',
  ) =>
    request(app)
      .post('/api/internal/telos/work/delegate')
      .set('x-internal-token', token)
      .set('x-client-id', client)
      .send(body);
  it('passes the authenticated exact internal lead identity without fabricating operator authorization', async () => {
    const delegateSlice = vi.fn(async (input) => {
      input.assertAuthorized();
      expect(input.actor).toEqual({ kind: 'conversation', id: 'chat' });
      expect(input.authorization).toBeUndefined();
      expect(input.raw).toEqual(selectors);
      return receipt;
    });
    const f = await setup({ delegateSlice });
    const result = await internal(f.app, {
      clientId: 'valid-client',
      sessionId: 'chat',
      input: selectors,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(receipt);
    expect(delegateSlice).toHaveBeenCalledOnce();
    expect(f.dbPath).not.toHaveBeenCalled();
  });
  it('rejects internal token, header, session, ordinary availability and extra authority claims before hosting', async () => {
    const delegateSlice = vi.fn(async () => receipt);
    const f = await setup({ delegateSlice });
    const body = { clientId: 'valid-client', sessionId: 'chat', input: selectors };
    expect((await internal(f.app, body, 'valid-client', 'wrong')).status).toBe(401);
    expect((await internal(f.app, { ...body, clientId: 'other-client' })).status).toBe(403);
    expect((await internal(f.app, { ...body, sessionId: 'unrelated' })).status).toBe(403);
    expect((await internal(f.app, { ...body, authorization: { id: 'spoof' } })).status).toBe(400);
    expect(
      (await internal(f.app, { ...body, input: { ...selectors, settings: fullInput().settings } }))
        .status,
    ).toBe(400);
    const hidden = await setup({ delegateSlice, ordinaryConversation: () => false });
    expect((await internal(hidden.app, body)).status).toBe(403);
    expect(delegateSlice).not.toHaveBeenCalled();
  });
  it.each(['session', 'ordinary', 'token'] as const)(
    'denies internal %s authority drift across a host wait',
    async (kind) => {
      let current = true;
      const delegateSlice = vi.fn(async () => {
        await Promise.resolve();
        current = false;
        return receipt;
      });
      const f = await setup({
        delegateSlice,
        sessionId: () => (kind === 'session' && !current ? 'another' : 'chat'),
        ordinaryConversation: () => kind !== 'ordinary' || current,
        verifyInternal: () => kind !== 'token' || current,
      });
      const result = await internal(f.app, {
        clientId: 'valid-client',
        sessionId: 'chat',
        input: selectors,
      });
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('unauthorized');
      expect(result.text).not.toContain('workerPath');
      expect(delegateSlice).toHaveBeenCalledOnce();
    },
  );
  it('aborts the internal host operation when its HTTP caller disconnects', async () => {
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const f = await setup({
      delegateSlice: async (input) => {
        started(input.signal);
        await new Promise<void>((_resolve, reject) =>
          input.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
        );
        return receipt;
      },
    });
    const call = internal(f.app, { clientId: 'valid-client', sessionId: 'chat', input: selectors });
    const settled = call.then(
      () => undefined,
      () => undefined,
    );
    const signal = await ready;
    const aborted = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    call.abort();
    await aborted;
    await settled;
    expect(signal.aborted).toBe(true);
  });
  it('bounds internal host work to 120 seconds and suppresses late successful receipts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>((resolve) => {
      started = resolve;
    });
    const f = await setup({
      delegateSlice: async (input) => {
        started(input.signal);
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return receipt;
      },
    });
    const call = internal(f.app, {
      clientId: 'valid-client',
      sessionId: 'chat',
      input: selectors,
    }).then((result) => result);
    const signal = await ready;
    await vi.advanceTimersByTimeAsync(120000);
    const result = await call;
    expect(signal.aborted).toBe(true);
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('workerPath');
  });
  it('redacts internal host errors and malformed output without leaking a false receipt', async () => {
    for (const delegateSlice of [
      async () => {
        throw Error('/private/credentials');
      },
      async () => ({ private: '/private/credentials' }),
    ]) {
      const f = await setup({ delegateSlice });
      const result = await internal(f.app, {
        clientId: 'valid-client',
        sessionId: 'chat',
        input: selectors,
      });
      expect(result.status).toBe(503);
      expect(result.text).not.toContain('/private');
      expect(result.text).not.toContain('workerPath');
    }
  });
  it('uses only interactive operator authority for advisor previews and saves, with fresh revocation across the host wait', async () => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const advisorSave = vi.fn(async (input: { assertAuthorized(): void; actor: unknown }) => {
      input.assertAuthorized();
      expect(input.actor).toEqual({ kind: 'operator', id: auth.id });
      revokeAuthSession(auth);
      return { receipt: 'committed' };
    });
    const f = await setup({
      advisorSave,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = auth;
        next();
      },
    });
    const result = await request(f.app)
      .post('/api/telos/work/advisor/save')
      .send({ itemId: 'item' });
    expect(result.status).toBe(403);
    expect(advisorSave).toHaveBeenCalledOnce();
    expect(result.headers['cache-control']).toBe('private, no-store');
    const unavailable = await setup();
    expect(
      (
        await request(unavailable.app)
          .post('/api/telos/work/advisor/preview')
          .set('x-operator', 'authenticated')
          .send({})
      ).status,
    ).toBe(503);
    expect(
      (
        await request(unavailable.app)
          .post('/api/telos/work/advisor/save')
          .set('x-internal-token', 'host')
          .send({})
      ).status,
    ).toBe(403);
  });
  it('passes only host identity to the role owner and returns its exact retained receipt', async () => {
    const roleSetup = vi.fn(
      async (
        input: Parameters<NonNullable<Parameters<typeof createTelosWorkRouter>[0]['roleSetup']>>[0],
      ) => {
        input.assertAuthorized();
        expect(input.actor).toEqual({ kind: 'operator', id: 'verified-operator' });
        return { receipt: 'saved' };
      },
    );
    const f = await setup({ roleSetup });
    const result = await request(f.app)
      .post('/api/telos/work/roles/setup')
      .set('x-operator', 'authenticated')
      .send({ requestId: 'unchanged' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ receipt: 'saved' });
    expect(roleSetup).toHaveBeenCalledOnce();
    expect(result.headers['cache-control']).toBe('private, no-store');
  });

  it('denies a successful delayed receipt after operator revocation without repeating the host operation', async () => {
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const roleSetup = vi.fn(async () => {
      await Promise.resolve();
      revokeAuthSession(auth);
      return { receipt: 'committed-and-retained' };
    });
    const f = await setup({
      roleSetup,
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = auth;
        next();
      },
    });
    const result = await request(f.app)
      .post('/api/telos/work/roles/setup')
      .send({ requestId: 'same' });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('unauthorized');
    expect(roleSetup).toHaveBeenCalledOnce();
    expect(result.text).not.toContain('committed-and-retained');
  });

  it('keeps atomic role setup behind its context-authorizing host entry', async () => {
    const f = await setup();
    const before = await f.read();
    const result = await f.command({
      operation: 'setup_role',
      itemId: 'item',
      requestId: 'bypass',
      expectedRevision: before.body.revision,
      role: 'lead',
      conversationId: 'chat',
      expectedAssignmentRevision: 0,
    });
    expect(result.status).toBe(400);
    expect((await f.read()).body).toEqual(before.body);
  });

  it('reports role setup as unavailable without a configured ordinary host and denies internal-token substitution', async () => {
    const f = await setup();
    const path = '/api/telos/work/roles/setup';
    expect((await request(f.app).post(path).set('x-internal-token', 'host').send({})).status).toBe(
      403,
    );
    expect(
      (await request(f.app).post(path).set('x-operator', 'authenticated').send({})).status,
    ).toBe(503);
  });
  it('requires interactive operator authority before opening canonical data; internal headers cannot substitute', async () => {
    const f = await setup();
    expect((await request(f.app).get('/api/telos/work/items/item')).status).toBe(403);
    expect(
      (await request(f.app).get('/api/telos/work/items/item').set('x-internal-token', 'host'))
        .status,
    ).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
  });
  it('protects the complete record read before opening canonical data and returns only the selected item', async () => {
    const f = await setup();
    const path = '/api/telos/work/items/item/record';
    expect((await request(f.app).get(path)).status).toBe(403);
    expect((await request(f.app).get(path).set('x-internal-token', 'host')).status).toBe(403);
    expect(f.dbPath).not.toHaveBeenCalled();
    const response = await request(f.app).get(path).set('x-operator', 'authenticated');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toMatchObject({
      itemId: 'item',
      summary: 'Item',
      status: 'active',
      kind: null,
      categories: [],
      createdAt: null,
      updatedAt: 'original',
      sources: [],
      links: [],
    });
    expect(
      (
        await request(f.app)
          .get('/api/telos/work/items/missing/record')
          .set('x-operator', 'authenticated')
      ).status,
    ).toBe(404);
    const db = new Database(f.dbPath());
    db.prepare("UPDATE items SET acceptance_criteria=? WHERE id='item'").run(
      '{private invalid data',
    );
    db.close();
    const invalid = await request(f.app).get(path).set('x-operator', 'authenticated');
    expect(invalid.status).toBe(503);
    expect(invalid.text).not.toContain('private invalid data');
  });
  it('reads, links and replays using host identity while rejecting caller-selected actors and stale writes', async () => {
    const f = await setup();
    const before = await f.read();
    expect(before.status).toBe(200);
    const input = {
      operation: 'link',
      itemId: 'item',
      requestId: 'one',
      expectedRevision: before.body.revision,
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
    };
    const receipt = await f.command(input);
    expect(receipt.status).toBe(200);
    expect(receipt.headers['cache-control']).toBe('private, no-store');
    expect(receipt.body.actorId).toBe('operator:verified-operator');
    expect((await f.command(input)).body).toEqual(receipt.body);
    expect((await f.command({ ...input, actor: { kind: 'operator', id: 'spoof' } })).status).toBe(
      400,
    );
    expect((await f.command({ ...input, requestId: 'stale' })).status).toBe(409);
    const links = await request(f.app)
      .post('/api/telos/work/links')
      .set('x-operator', 'authenticated')
      .send(input.conversation);
    expect(links.body).toMatchObject([{ itemId: 'item', role: 'worker' }]);
  });
  it('gives internal chats explicit linked-item reads without granting work mutations', async () => {
    const f = await setup();
    expect(f.app.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    const internal = (client: string, token = 'host') =>
      request(f.app)
        .post('/api/internal/telos/work/read')
        .set('x-internal-token', token)
        .set('x-client-id', client)
        .send({ itemId: 'item' });
    expect((await internal('valid-client', 'wrong')).status).toBe(401);
    expect((await internal('stale')).status).toBe(409);
    expect((await internal('valid-client')).status).toBe(403);
    await f.command({
      operation: 'link',
      itemId: 'item',
      requestId: 'link',
      expectedRevision: (await f.read()).body.revision,
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'chat' },
    });
    expect((await internal('valid-client')).status).toBe(200);
    const denied = await internal('other-client');
    expect(
      denied.status,
      JSON.stringify({ headers: denied.headers, body: denied.body, text: denied.text }),
    ).toBe(403);
    expect(denied.body).toMatchObject({ code: 'unauthorized' });
    expect(
      (
        await request(f.app)
          .post('/api/internal/telos/work/commands')
          .set('x-internal-token', 'host')
          .send({})
      ).status,
    ).toBe(404);
  });
  it('keeps invalid operations atomic and returns safe errors for missing or unavailable owners', async () => {
    const f = await setup();
    const before = await f.read();
    expect(
      (
        await f.command({
          operation: 'reparent',
          itemId: 'item',
          requestId: 'cycle',
          expectedRevision: before.body.revision,
          parentId: 'item',
        })
      ).status,
    ).toBe(400);
    expect((await f.read()).body).toEqual(before.body);
    expect(
      (await request(f.app).get('/api/telos/work/items/missing').set('x-operator', 'authenticated'))
        .status,
    ).toBe(404);
    f.dbPath.mockImplementation(() => {
      throw Error('/private/credentials/config.db');
    });
    const unavailable = await f.read();
    expect(unavailable.status).toBe(503);
    expect(unavailable.text).not.toContain('/private/');
  });
});
