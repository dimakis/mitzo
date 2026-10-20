import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  realpathSync,
} from 'fs';
import Database from 'better-sqlite3';
import { join } from 'path';
import { tmpdir } from 'os';
import { INTERNAL_TOKEN } from '../internal-token.js';
import * as commands from '../protected-sdk-command.js';
import { EventStore } from '../event-store.js';
import type { TelosOutcomeCreation, TelosOutcomeProposal } from '@mitzo/protocol';
import { randomUUID } from 'node:crypto';

const TEST_REPO = join(tmpdir(), `mitzo-test-repo-${process.pid}`);
const TODO_SCRIPT = join(TEST_REPO, 'command_center', 'todo_api.py');
const sourceSessions = vi.hoisted(() => new Map<string, string>());
const sourceEvents = vi.hoisted(() => new Map<string, EventStore>());

function sourceFixture(useDefaultPath = false) {
  const root = mkdtempSync(join(TEST_REPO, 'source-'));
  const dbPath = useDefaultPath
    ? join(TEST_REPO, 'command_center', 'data', 'smart_todo.db')
    : join(root, 'selected-telos.db');
  if (useDefaultPath) mkdirSync(join(TEST_REPO, 'command_center', 'data'), { recursive: true });
  const db = new Database(dbPath);
  db.exec(
    `CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,profile TEXT,status TEXT,starred INTEGER,context_hints TEXT,created_at TEXT,updated_at TEXT,idempotency_key TEXT UNIQUE);
    CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,source_id TEXT,url TEXT,title TEXT,author TEXT,timestamp TEXT,raw_snippet TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`,
  );
  db.close();
  vi.stubEnv('TELOS_DB_PATH', useDefaultPath ? '' : dbPath);
  sourceSessions.set('client-7', 'planning-7');
  const events = new EventStore(join(root, 'events.db'));
  events.upsertSession({
    sessionId: 'planning-7',
    conversationSource: 'mitzo',
    summary: 'Planning',
  });
  const sequence = events.append('planning-7', 'user_message', {
    messageId: 'reviewed-message',
    text: 'Exact original exchange approved by the operator.',
  });
  sourceEvents.set('planning-7', events);
  return {
    dbPath,
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning-7',
      boundary: { sequence, messageId: 'reviewed-message' },
      mode: 'selected' as const,
      messageIds: ['reviewed-message'],
      artifacts: [],
      purpose: 'Preserve reviewed planning',
      joiningBrief: '',
    },
    persist(input: TelosOutcomeCreation) {
      const db = new Database(dbPath);
      try {
        db.prepare(
          `INSERT INTO items(id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,idempotency_key)
          VALUES(?,?,?,?,?,?,'active',0,?,'fixture-time','fixture-time',?)`,
        ).run(
          'created-source',
          input.summary,
          input.intent,
          input.rationale,
          JSON.stringify(input.acceptanceCriteria),
          input.profile,
          JSON.stringify({ session_ids: input.contextHints?.sessionIds ?? [] }),
          input.idempotencyKey,
        );
        input.milestones.forEach((summary, index) =>
          db
            .prepare(
              `INSERT INTO items(id,parent_id,summary,profile,status,context_hints,created_at,updated_at)
            VALUES(?,'created-source',?,?,'active','{}','fixture-time','fixture-time')`,
            )
            .run(`created-milestone-${index}`, summary, input.profile),
        );
      } finally {
        db.close();
      }
      return { id: 'created-source', ...input };
    },
    close() {
      events.close();
      sourceEvents.delete('planning-7');
      if (useDefaultPath) rmSync(dbPath, { force: true });
      sourceSessions.clear();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

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

async function getAuthCookie(agent: request.Agent): Promise<string> {
  const res = await agent.post('/api/auth/login').send({ passphrase: process.env.AUTH_PASSPHRASE });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No cookie returned from login');
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies[0].split(';')[0];
}

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  mkdirSync(join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive'), { recursive: true });
  mkdirSync(join(TEST_REPO, 'command_center'), { recursive: true });

  const mod = await import('../app.js');
  app = mod.app;

  const agent = request(app);
  authCookie = await getAuthCookie(agent);
});

async function createReviewedOutcome(
  source: ReturnType<typeof sourceFixture>,
  outcome: TelosOutcomeProposal,
) {
  const body = { requestId: randomUUID(), selection: source.selection, outcome };
  const preview = await request(app)
    .post('/api/telos/work/source/outcome/preview')
    .set('Cookie', authCookie)
    .send(body);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  return request(app)
    .post('/api/telos/work/source/outcome/create')
    .set('Cookie', authCookie)
    .send({ ...body, previewSha256: preview.body.sha256 });
}

describe('todo routes', () => {
  it('mounts agent item routes behind host authentication and active session identity', async () => {
    expect(
      (await request(app).post('/api/internal/telos/items/get').send({ itemId: 'task' })).status,
    ).toBe(401);
    const response = await request(app)
      .post('/api/internal/telos/items/update')
      .set('X-Internal-Token', INTERNAL_TOKEN)
      .set('X-Client-Id', 'closed')
      .send({ itemId: 'task' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('Active Mitzo session required');
  });

  it('saved output metadata and downloads require operator authentication', async () => {
    expect((await request(app).get('/api/telos/items/t/artifacts')).status).toBe(401);
    expect((await request(app).get('/api/telos/artifacts/' + 'a'.repeat(32))).status).toBe(401);
  });

  it('GET /api/todos — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/todos');
    expect(res.status).toBe(401);
  });

  it('GET /api/todos — returns service unavailable when script not found', async () => {
    const res = await request(app).get('/api/todos').set('Cookie', authCookie);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Todo service unavailable' });
  });

  it('GET /api/todos — accepts profile query param', async () => {
    const res = await request(app)
      .get('/api/todos')
      .query({ profile: 'centaur' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Todo service unavailable' });
  });

  it('POST /api/todos/:id/action — unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/todos/abc123/action').send({ action: 'ack' });
    expect(res.status).toBe(401);
  });

  it('POST /api/todos/:id/action — invalid action returns 400', async () => {
    const res = await request(app)
      .post('/api/todos/abc123/action')
      .send({ action: 'invalid' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos/:id/action — valid action returns error when script not found', async () => {
    const res = await request(app)
      .post('/api/todos/abc123/action')
      .send({ action: 'ack' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos — unauthenticated returns 401', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ summary: 'Test task', profile: 'work' });
    expect(res.status).toBe(401);
  });

  it('POST /api/todos — missing summary returns 400', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ profile: 'work' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos — missing profile returns 400', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ summary: 'Test task' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos — empty summary returns 400', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ summary: '', profile: 'work' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos — valid body returns error when script not found', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ summary: 'New task', profile: 'work' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos — accepts optional parentId', async () => {
    const res = await request(app)
      .post('/api/todos')
      .send({ summary: 'Sub task', profile: 'work', parentId: 'parent-123' })
      .set('Cookie', authCookie);
    // Script won't exist in test env, but validates input is accepted
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos/outcomes — rejects an incomplete outcome contract', async () => {
    const res = await request(app)
      .post('/api/todos/outcomes')
      .send({ summary: 'Vague aspiration', profile: 'work' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos/outcomes — accepts a complete outcome contract', async () => {
    const res = await request(app)
      .post('/api/todos/outcomes')
      .send({
        summary: 'Ship searchable Telos outcomes',
        intent: 'People can find and understand durable work in ten seconds.',
        rationale: 'The current list hides intent inside activity logs.',
        acceptanceCriteria: ['Search matches title, intent, and context'],
        milestones: ['Add the structured creation contract'],
        profile: 'work',
        idempotencyKey: 'session-1:message-7',
      })
      .set('Cookie', authCookie);
    // The script is absent here, proving validation accepted the complete contract.
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos/:id/action — star action returns 500 when script not found', async () => {
    const res = await request(app)
      .post('/api/todos/abc123/action')
      .send({ action: 'star' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/todos/:id/action — unstar action returns 500 when script not found', async () => {
    const res = await request(app)
      .post('/api/todos/abc123/action')
      .send({ action: 'unstar' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('todo list execution', () => {
  afterEach(() => {
    try {
      unlinkSync(TODO_SCRIPT);
    } catch {
      // ignore
    }
  });

  it('GET /api/todos — accepts output larger than the Node default buffer', async () => {
    const largeOutputScript = `
import json
item = {
  "id": "large-item",
  "summary": "x" * 1100000,
  "profile": "work",
  "urgency": 0.5,
  "status": "active",
  "ageDays": 0,
  "sources": [],
  "contextHints": {}
}
print(json.dumps({"profiles": ["work"], "items": [item]}))
`;
    writeFileSync(TODO_SCRIPT, largeOutputScript);

    const res = await request(app).get('/api/todos').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.profiles).toEqual(['work']);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].summary).toHaveLength(1100000);
  });

  it('GET /api/todos — reports execution failures instead of an empty list', async () => {
    writeFileSync(TODO_SCRIPT, 'raise RuntimeError("boom")\n');

    const res = await request(app).get('/api/todos').set('Cookie', authCookie);

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Todo service unavailable' });
  });
});

describe('todo action success paths', () => {
  const successScript = `
import sys, json
action = sys.argv[sys.argv.index('--action') + 1]
item_id = sys.argv[sys.argv.index('--action') + 2]
print(json.dumps({"ok": True}))
`;

  beforeEach(() => {
    writeFileSync(TODO_SCRIPT, successScript);
  });

  afterEach(() => {
    try {
      unlinkSync(TODO_SCRIPT);
    } catch {
      // ignore
    }
  });

  it('passes numeric priority to the backend without changing the legacy actions', async () => {
    writeFileSync(
      TODO_SCRIPT,
      `import json, sys
assert sys.argv[1:] == ['--action', 'priority', 'item-1', '7']
print(json.dumps({'ok': True}))
`,
    );
    const res = await request(app)
      .post('/api/todos/item-1/action')
      .send({ action: 'priority', priority: 7 })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it.each([undefined, 0, 11, 7.5, true, '7'])(
    'rejects invalid priority %s before invoking the backend',
    async (priority) => {
      writeFileSync(TODO_SCRIPT, 'raise RuntimeError("must not execute")');
      const res = await request(app)
        .post('/api/todos/item-1/action')
        .send({ action: 'priority', priority })
        .set('Cookie', authCookie);
      expect(res.status).toBe(400);
    },
  );

  it('POST /api/todos/:id/action — star returns success', async () => {
    const res = await request(app)
      .post('/api/todos/item-1/action')
      .send({ action: 'star' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/todos/:id/action — unstar returns success', async () => {
    const res = await request(app)
      .post('/api/todos/item-1/action')
      .send({ action: 'unstar' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/todos/:id/action — ack returns success', async () => {
    const res = await request(app)
      .post('/api/todos/item-1/action')
      .send({ action: 'ack' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/todos/:id/action — script returning ok:false yields 404', async () => {
    const failScript = `
import json
print(json.dumps({"ok": False, "error": "Item not found"}))
`;
    writeFileSync(TODO_SCRIPT, failScript);

    const res = await request(app)
      .post('/api/todos/missing-id/action')
      .send({ action: 'star' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Item not found');
  });
});

describe('structured outcome creation', () => {
  let source: ReturnType<typeof sourceFixture>;
  beforeEach(() => {
    source = sourceFixture();
  });
  afterEach(() => {
    source.close();
    try {
      unlinkSync(TODO_SCRIPT);
    } catch {
      // ignore
    }
  });

  it('passes the validated contract to the Telos backend', async () => {
    const successScript = `
import json, sys
payload = json.loads(sys.argv[sys.argv.index('--create-outcome-json') + 1])
print(json.dumps({"ok": True, "created": True, "item": payload}))
`;
    writeFileSync(TODO_SCRIPT, successScript);
    const body = {
      summary: 'Ship searchable Telos outcomes',
      intent: 'People can find and understand durable work in ten seconds.',
      rationale: 'The current list hides intent inside activity logs.',
      acceptanceCriteria: ['Search matches title, intent, and context'],
      milestones: ['Add the structured creation contract'],
      profile: 'work',
      idempotencyKey: 'session-1:message-7',
      contextHints: { paths: ['frontend/src/pages/TodoView.tsx'] },
    };

    const res = await request(app).post('/api/todos/outcomes').send(body).set('Cookie', authCookie);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.item).toMatchObject(body);
  });

  it('retires token-only outcome creation before the workspace script or canonical stores mutate', async () => {
    const executed = join(TEST_REPO, 'retired-endpoint-executed');
    writeFileSync(
      TODO_SCRIPT,
      `from pathlib import Path\nPath(${JSON.stringify(executed)}).write_text('executed')\n`,
    );
    const res = await request(app)
      .post('/api/internal/telos/outcomes')
      .set('x-internal-token', INTERNAL_TOKEN)
      .set('x-client-id', 'client-7')
      .send({ summary: 'Unreviewed proposal' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error: expect.stringContaining('Reviewed original source approval is required'),
    });
    const db = new Database(source.dbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM links').get()).toEqual({ count: 0 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'telos_work_%'").all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
    expect(() => readFileSync(executed)).toThrow();
  });
});

describe('enrolled mutable controller commands', () => {
  const operator = join(TEST_REPO, 'operator');
  const enrollment = join(operator, 'enrollment.json');
  const config = join(operator, 'runtime.json');
  const outcomeProposal = {
    summary: 'Protected fixture outcome',
    intent: 'Preserve the existing Todo contract.',
    rationale: 'Controller entrypoints require the runtime fence.',
    acceptanceCriteria: ['Authority remains unchanged'],
    milestones: ['Run the existing entrypoint safely'],
    profile: 'work',
  };
  const outcome = { ...outcomeProposal, idempotencyKey: 'fixture-request' };
  let source: ReturnType<typeof sourceFixture>;
  const runner = vi.fn<commands.ProtectedSdkCommandRunner>();
  let factory: import('vitest').MockInstance<typeof commands.createWorkspaceRuntimeCommandRunner>;
  beforeEach(() => {
    source = sourceFixture();
    mkdirSync(operator, { recursive: true });
    writeFileSync(
      config,
      JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
      { mode: 0o600 },
    );
    writeFileSync(
      enrollment,
      JSON.stringify({
        kind: 'workspace-runtime-v1',
        config: realpathSync(config),
        release: join(realpathSync(operator), 'release'),
        python: join(realpathSync(operator), 'python'),
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', realpathSync(enrollment));
    runner.mockReset().mockImplementation(async (_command, args, options) => {
      if (args.includes('--create-outcome-json')) {
        expect(options.env.TELOS_DB_PATH).toBe(source.dbPath);
        const input = JSON.parse(args[args.indexOf('--create-outcome-json') + 1]);
        return {
          stdout: JSON.stringify({ ok: true, created: true, item: source.persist(input) }),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify(
          args.includes('--list') || args.includes('--refresh')
            ? { profiles: ['work'], items: [] }
            : { ok: true, created: true },
        ),
        stderr: '',
      };
    });
    factory = vi.spyOn(commands, 'createWorkspaceRuntimeCommandRunner').mockReturnValue(runner);
    writeFileSync(
      TODO_SCRIPT,
      'import json\nprint(json.dumps({"profiles": ["work"], "items": []}))\n',
    );
  });
  afterEach(() => {
    factory.mockRestore();
    source.close();
    unlinkSync(TODO_SCRIPT);
  });

  it('keeps operator authority intact after a document edit followed by opening Todos', async () => {
    const original = readFileSync(enrollment, 'utf8');
    const script = `import pathlib, json\npathlib.Path(${JSON.stringify(realpathSync(enrollment))}).write_text('compromised')\nprint(json.dumps({"profiles": ["work"], "items": []}))\n`;
    const edit = await request(app)
      .put('/api/files/write')
      .set('Cookie', authCookie)
      .send({
        path: TODO_SCRIPT,
        content: script,
        expectedContent: readFileSync(TODO_SCRIPT, 'utf8'),
      });
    expect(edit.status).toBe(200);
    const result = await request(app).get('/api/todos').set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(runner).toHaveBeenCalledWith(
      'python3',
      [TODO_SCRIPT, '--list'],
      expect.objectContaining({
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
    expect(readFileSync(enrollment, 'utf8')).toBe(original);
  });

  it.each([
    ['get', '/api/todos?refresh=true&profile=work', undefined, 200, '--refresh'],
    ['post', '/api/todos', { summary: 'Fixture', profile: 'work' }, 201, '--create'],
    ['post', '/api/todos/item-1/action', { action: 'ack' }, 200, '--action'],
    ['post', '/api/todos/outcomes', outcome, 201, '--create-outcome-json'],
  ] as const)(
    'protects %s %s while retaining its response contract',
    async (method, path, body, status, argument) => {
      const requestBuilder = request(app)
        [method](path)
        .set('Cookie', authCookie)
        .set('x-internal-token', INTERNAL_TOKEN)
        .set('x-client-id', 'client-7');
      const result = await (body ? requestBuilder.send(body) : requestBuilder);
      expect(runner).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining([TODO_SCRIPT, argument]),
        expect.objectContaining({ timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }),
      );
      expect(result.status).toBe(status);
    },
  );

  it('keeps retired token-only creation outside the protected runner', async () => {
    const result = await request(app)
      .post('/api/internal/telos/outcomes')
      .set('x-internal-token', INTERNAL_TOKEN)
      .set('x-client-id', 'client-7')
      .send(outcomeProposal);
    expect(result.status).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'runs reviewed creation through the protected canonical owner with fallback database=%s',
    async (fallback) => {
      if (fallback) {
        source.close();
        source = sourceFixture(true);
        vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', realpathSync(enrollment));
      }
      const result = await createReviewedOutcome(source, outcomeProposal);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.work).toMatchObject({
        itemId: 'created-source',
        kind: 'outcome',
        assignments: [],
        attempts: [],
        links: [
          { role: 'origin', conversation: { namespace: 'mitzo', conversationId: 'planning-7' } },
        ],
      });
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith(
        'python3',
        expect.arrayContaining([TODO_SCRIPT, '--create-outcome-json']),
        expect.objectContaining({
          env: expect.objectContaining({ TELOS_DB_PATH: source.dbPath }),
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
      const canonicalInput = JSON.parse(runner.mock.calls[0][1][2]);
      expect(canonicalInput.idempotencyKey).toMatch(/^telos-source:/);
      expect(canonicalInput.contextHints.sessionIds).toEqual(['planning-7']);
      const db = new Database(source.dbPath, { readonly: true });
      try {
        expect(db.prepare('SELECT role,conversation_id FROM telos_work_links').all()).toEqual([
          { role: 'origin', conversation_id: 'planning-7' },
        ]);
        expect(db.prepare('SELECT * FROM telos_work_assignments').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM telos_work_attempts').all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it('fails closed when runtime protection cannot initialize without executing the workspace script', async () => {
    factory.mockImplementation(() => {
      throw new Error('Fixture protection unavailable');
    });
    const original = readFileSync(enrollment, 'utf8');
    writeFileSync(
      TODO_SCRIPT,
      `import pathlib\npathlib.Path(${JSON.stringify(realpathSync(enrollment))}).write_text('compromised')\n`,
    );
    const result = await request(app).get('/api/todos').set('Cookie', authCookie);
    expect(result.status).toBe(502);
    expect(runner).not.toHaveBeenCalled();
    expect(readFileSync(enrollment, 'utf8')).toBe(original);
  });

  it.runIf(process.platform === 'darwin' && process.env.MITZO_TEST_OS_SANDBOX === '1')(
    'physically denies enrolled authority reads and writes from the edited Todo entrypoint',
    async () => {
      factory.mockRestore();
      const original = readFileSync(enrollment, 'utf8');
      const report = join(TEST_REPO, 'todo-fence-report.json');
      const script = `import pathlib, json\np=pathlib.Path(${JSON.stringify(realpathSync(enrollment))})\nresult={}\ntry:\n p.read_text()\n result['readDenied']=False\nexcept PermissionError:\n result['readDenied']=True\ntry:\n p.write_text('compromised')\n result['writeDenied']=False\nexcept PermissionError:\n result['writeDenied']=True\npathlib.Path(${JSON.stringify(report)}).write_text(json.dumps(result))\nprint(json.dumps({'profiles':['work'],'items':[]}))\n`;
      const edit = await request(app)
        .put('/api/files/write')
        .set('Cookie', authCookie)
        .send({
          path: TODO_SCRIPT,
          content: script,
          expectedContent: readFileSync(TODO_SCRIPT, 'utf8'),
        });
      expect(edit.status).toBe(200);
      const result = await request(app).get('/api/todos').set('Cookie', authCookie);
      expect(result.status).toBe(200);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({
        readDenied: true,
        writeDenied: true,
      });
      expect(readFileSync(enrollment, 'utf8')).toBe(original);
    },
  );
});
