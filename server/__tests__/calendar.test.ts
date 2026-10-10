import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  linkSync,
  unlinkSync,
  symlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const runtime = vi.hoisted(() => ({
  calendar: vi.fn(),
  latestBriefing: vi.fn(),
  briefingsRoot: '',
}));
vi.mock('../workspace-runtime-client.js', () => ({
  workspaceRuntimeConfigured: () => Object.hasOwn(process.env, 'MITZO_WORKSPACE_RUNTIME_CONFIG'),
  createWorkspaceRuntimeClient: () => runtime,
}));
afterEach(() => {
  delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
  vi.clearAllMocks();
  runtime.briefingsRoot = join(TEST_REPO, 'command_center', 'briefings');
});

const TEST_REPO = join(tmpdir(), `mitzo-test-repo-${process.pid}`);
const TEST_ENROLLMENT = join(TEST_REPO, 'runtime-enrollment.json');
const TEST_RUNTIME_CONFIG = join(TEST_REPO, 'runtime-config.json');

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
    registry: { get: vi.fn() },
    eventStore: { getEventsAfter: vi.fn().mockReturnValue([]) },
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
  runtime.briefingsRoot = join(TEST_REPO, 'command_center', 'briefings');
  mkdirSync(runtime.briefingsRoot, { recursive: true });
  mkdirSync(TEST_REPO, { recursive: true });
  writeFileSync(
    TEST_RUNTIME_CONFIG,
    JSON.stringify({ gwsExecutable: '/synthetic/gws', jiraLibPath: '/synthetic/jira' }),
    { mode: 0o600 },
  );
  writeFileSync(
    TEST_ENROLLMENT,
    JSON.stringify({
      kind: 'workspace-runtime-v1',
      config: realpathSync(TEST_RUNTIME_CONFIG),
      release: realpathSync(TEST_REPO) + '/installed-runtime',
      python: '/synthetic/python',
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive'), { recursive: true });

  const mod = await import('../app.js');
  app = mod.app;

  const agent = request(app);
  authCookie = await getAuthCookie(agent);
});

describe('calendar routes', () => {
  it('returns a bounded generic error for a failing unenrolled briefing lookup', async () => {
    const date = '2046-12-24';
    const dangling = join(TEST_REPO, 'command_center', 'briefings', `${date}.md`);
    symlinkSync(join(TEST_REPO, 'missing-private-report'), dangling);
    try {
      const result = await request(app)
        .get('/api/briefings/latest')
        .query({ date })
        .set('Cookie', authCookie)
        .timeout({ response: 750 });
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: 'Saved briefing unavailable' });
      expect(JSON.stringify(result.body)).not.toContain(TEST_REPO);
    } finally {
      unlinkSync(dangling);
    }
  });
  it('GET /api/calendar — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/calendar');
    expect(res.status).toBe(401);
  });

  it('GET /api/calendar — returns calendar data with default params', async () => {
    const res = await request(app).get('/api/calendar').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('startDate');
    expect(res.body).toHaveProperty('endDate');
    expect(res.body).toHaveProperty('events');
    expect(res.body).toHaveProperty('sprints');
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.sprints)).toBe(true);
  });

  it('GET /api/calendar — accepts date and days params', async () => {
    const res = await request(app)
      .get('/api/calendar')
      .query({ date: '2026-04-10', days: '3' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.startDate).toBe('2026-04-10');
    expect(res.body.endDate).toBe('2026-04-12');
  });

  it('GET /api/calendar — invalid date returns 400', async () => {
    const res = await request(app)
      .get('/api/calendar')
      .query({ date: 'not-a-date' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });

  it('GET /api/calendar — days clamped to 1-31 range', async () => {
    const res = await request(app)
      .get('/api/calendar')
      .query({ date: '2026-04-10', days: '100' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    // days should be clamped to 31
    const start = new Date('2026-04-10');
    const end = new Date(res.body.endDate);
    const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diff).toBeLessThanOrEqual(31);
  });
});

describe('enrolled calendar and briefing routes', () => {
  it('revokes cached Inbox and notification delivery when an indexed file becomes authority', async () => {
    const authority = join(TEST_REPO, 'mgmt_lib', 'inbox', 'cached-operator-runtime.md');
    const original = readFileSync(TEST_ENROLLMENT, 'utf8');
    writeFileSync(authority, original, { mode: 0o600 });
    const id = 'inbox:cached-operator-runtime.md';
    const indexed = await request(app)
      .get(`/api/inbox/records/${encodeURIComponent(id)}`)
      .set('Cookie', authCookie);
    expect(indexed.status).toBe(200);
    expect(indexed.body.inbox.content).toBe(original);
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(authority);
    try {
      for (const endpoint of ['/api/inbox/records/', '/api/notifications/']) {
        const result = await request(app)
          .get(endpoint + encodeURIComponent(id))
          .set('Cookie', authCookie);
        expect(result.status).toBe(404);
        expect(JSON.stringify(result.body)).not.toContain(original);
      }
      for (const endpoint of [
        '/api/inbox/feed?view=all',
        '/api/inbox/feed?view=archive',
        '/api/notifications?filter=all',
      ]) {
        const result = await request(app).get(endpoint).set('Cookie', authCookie);
        expect(result.status).toBe(200);
        expect(JSON.stringify(result.body)).not.toContain('cached-operator-runtime.md');
      }
    } finally {
      unlinkSync(authority);
    }
  });
  it('blocks document writes to enrolled authority before any runtime use while preserving reports', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    for (const file of [TEST_ENROLLMENT, TEST_RUNTIME_CONFIG]) {
      const original = readFileSync(file, 'utf8');
      const result = await request(app)
        .put('/api/files/write')
        .set('Cookie', authCookie)
        .send({ path: file, content: '{"python":"/attacker"}', expectedContent: original });
      expect(result.status).toBe(403);
      expect(readFileSync(file, 'utf8')).toBe(original);
    }
    const output = join(runtime.briefingsRoot, '2026-10-10.md');
    writeFileSync(output, '# Report');
    const readable = await request(app)
      .get('/api/files/read')
      .query({ path: output })
      .set('Cookie', authCookie);
    expect(readable.status).toBe(200);
  });

  it('protects an enrolled authority file from inbox read, archive and deletion routes', async () => {
    const authority = join(TEST_REPO, 'mgmt_lib', 'inbox', 'operator-runtime.md');
    const original = readFileSync(TEST_ENROLLMENT, 'utf8');
    writeFileSync(authority, original, { mode: 0o600 });
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(authority);
    for (const method of ['get', 'post', 'delete'] as const) {
      const path = '/api/inbox/operator-runtime.md' + (method === 'post' ? '/approve' : '');
      const result = await request(app)[method](path).set('Cookie', authCookie);
      expect(result.status).toBe(403);
      expect(readFileSync(authority, 'utf8')).toBe(original);
    }
    delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
    const afterRemoval = await request(app)
      .delete('/api/inbox/operator-runtime.md')
      .set('Cookie', authCookie);
    expect(afterRemoval.status).toBe(403);
    expect(readFileSync(authority, 'utf8')).toBe(original);
    const listing = await request(app).get('/api/inbox').set('Cookie', authCookie);
    expect(
      listing.body.some((item: { filename: string }) => item.filename === 'operator-runtime.md'),
    ).toBe(false);
    const feed = await request(app).get('/api/inbox/feed?view=all').set('Cookie', authCookie);
    expect(feed.status).toBe(200);
    expect(JSON.stringify(feed.body)).not.toContain('operator-runtime.md');
    const record = await request(app)
      .get('/api/inbox/records/inbox%3Aoperator-runtime.md')
      .set('Cookie', authCookie);
    expect(record.status).toBe(404);
  });
  it('fails closed before document writes through a hardlink alias', async () => {
    const alias = join(TEST_REPO, 'runtime-config-alias.json');
    linkSync(TEST_RUNTIME_CONFIG, alias);
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    try {
      const original = readFileSync(alias, 'utf8');
      const result = await request(app)
        .put('/api/files/write')
        .set('Cookie', authCookie)
        .send({ path: alias, content: '{"gwsExecutable":"/attacker"}', expectedContent: original });
      expect(result.status).toBe(403);
      expect(readFileSync(TEST_RUNTIME_CONFIG, 'utf8')).toBe(original);
    } finally {
      unlinkSync(alias);
    }
  });
  it('blocks inbox approval that would replace an archived operator enrollment', async () => {
    const source = join(TEST_REPO, 'mgmt_lib', 'inbox', 'archived-authority.md');
    const destination = join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive', 'archived-authority.md');
    const original = readFileSync(TEST_ENROLLMENT, 'utf8');
    writeFileSync(source, '# ordinary draft');
    writeFileSync(destination, original, { mode: 0o600 });
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(destination);
    const result = await request(app)
      .post('/api/inbox/archived-authority.md/approve')
      .set('Cookie', authCookie);
    expect(result.status).toBe(403);
    expect(readFileSync(destination, 'utf8')).toBe(original);
    expect(readFileSync(source, 'utf8')).toBe('# ordinary draft');
  });
  it('keeps calendar response and clamping while using the enrolled runtime', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.calendar.mockResolvedValue({
      startDate: '2026-10-10',
      endDate: '2026-11-09',
      events: [],
      sprints: [],
    });
    const result = await request(app)
      .get('/api/calendar')
      .query({ date: '2026-10-10', days: '100' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(runtime.calendar).toHaveBeenCalledWith(
      { date: '2026-10-10', days: 31 },
      expect.any(AbortSignal),
    );
    expect(result.body.endDate).toBe('2026-11-09');
  });
  it('fails closed instead of executing mutable calendar code', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.calendar.mockRejectedValue(new Error('private information must not escape'));
    const result = await request(app)
      .get('/api/calendar')
      .query({ date: '2026-10-10', days: 3 })
      .set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      startDate: '2026-10-10',
      endDate: '2026-10-12',
      events: [],
      sprints: [],
      error: 'Workspace runtime calendar unavailable',
    });
  });
  it('returns a briefing path in the existing browser contract', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.latestBriefing.mockResolvedValue({
      filename: '2026-10-10.md',
      path: join(runtime.briefingsRoot, '2026-10-10.md'),
      date: '2026-10-10',
      generatedAt: '2026-10-10T08:00:00Z',
    });
    const result = await request(app)
      .get('/api/briefings/latest')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(result.body.path).toBe(join(runtime.briefingsRoot, '2026-10-10.md'));
    writeFileSync(result.body.path, '# Saved briefing');
    const document = await request(app)
      .get('/api/files/read')
      .query({ path: result.body.path })
      .set('Cookie', authCookie);
    expect(document.status).toBe(200);
    expect(document.body.content).toBe('# Saved briefing');
    expect(runtime.latestBriefing).toHaveBeenCalledWith(
      { date: '2026-10-10' },
      expect.any(AbortSignal),
    );
  });
  it('rejects a briefing enrollment outside the existing document roots', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.briefingsRoot = '/private/unrelated-documents';
    runtime.latestBriefing.mockResolvedValue(null);
    const result = await request(app)
      .get('/api/briefings/latest')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(503);
    expect(runtime.latestBriefing).not.toHaveBeenCalled();
    const home = await request(app)
      .get('/api/home/briefing')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(home.status).toBe(503);
    expect(runtime.latestBriefing).not.toHaveBeenCalled();
  });
  it('distinguishes runtime failure from no saved briefing without leaking diagnostics', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.latestBriefing.mockRejectedValue(new Error('credential details'));
    const result = await request(app)
      .get('/api/briefings/latest')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Workspace runtime briefing unavailable' });
    const home = await request(app)
      .get('/api/home/briefing')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(home.status).toBe(503);
    expect(home.body).toEqual({ error: 'Saved content is unavailable. Retry.' });
  });
  it.each(['enrollment', 'configuration'] as const)(
    'denies private %s disguised as a dated briefing in both consumers',
    async (kind) => {
      const date = kind === 'enrollment' ? '2046-12-20' : '2046-12-21';
      const authority = join(runtime.briefingsRoot, `${date}.md`);
      const enrollment = JSON.parse(readFileSync(TEST_ENROLLMENT, 'utf8'));
      const selectedEnrollment = join(TEST_REPO, `briefing-${kind}-enrollment.json`);
      const secret = readFileSync(
        kind === 'enrollment' ? TEST_ENROLLMENT : TEST_RUNTIME_CONFIG,
        'utf8',
      );
      writeFileSync(authority, secret, { mode: 0o600 });
      if (kind === 'configuration') {
        writeFileSync(
          selectedEnrollment,
          JSON.stringify({ ...enrollment, config: realpathSync(authority) }),
          { mode: 0o600 },
        );
      }
      process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(
        kind === 'enrollment' ? authority : selectedEnrollment,
      );
      runtime.latestBriefing.mockResolvedValue({
        filename: `${date}.md`,
        path: authority,
        date,
        generatedAt: '2046-12-20T08:00:00Z',
      });
      try {
        for (const endpoint of ['/api/briefings/latest', '/api/home/briefing']) {
          const result = await request(app).get(endpoint).query({ date }).set('Cookie', authCookie);
          expect(result.status).toBe(503);
          expect(JSON.stringify(result.body)).not.toContain(secret);
        }
        delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
        const removed = await request(app)
          .get('/api/home/briefing')
          .query({ date })
          .set('Cookie', authCookie);
        expect(removed.status).toBe(404);
        expect(JSON.stringify(removed.body)).not.toContain(secret);
      } finally {
        unlinkSync(authority);
        if (kind === 'configuration') unlinkSync(selectedEnrollment);
      }
    },
  );
  it('opens the enrolled Today selection instead of an unrelated legacy briefing', async () => {
    const date = '2046-12-22';
    const legacy = join(runtime.briefingsRoot, `${date}.md`);
    writeFileSync(legacy, '# Legacy report');
    const alternateRoot = join(TEST_REPO, 'reports', 'briefings');
    mkdirSync(alternateRoot, { recursive: true });
    runtime.briefingsRoot = realpathSync(alternateRoot);
    const selected = join(runtime.briefingsRoot, `${date}.md`);
    writeFileSync(selected, '# Enrolled report');
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = realpathSync(TEST_ENROLLMENT);
    runtime.latestBriefing.mockResolvedValue({
      filename: `${date}.md`,
      path: selected,
      date,
      generatedAt: '2046-12-22T08:00:00Z',
    });
    try {
      const today = await request(app)
        .get('/api/briefings/latest')
        .query({ date })
        .set('Cookie', authCookie);
      const opened = await request(app)
        .get('/api/home/briefing')
        .query({ date })
        .set('Cookie', authCookie);
      expect(today.status).toBe(200);
      expect(opened.status).toBe(200);
      expect(opened.body.path).toBe(today.body.path);
      expect(opened.body.content).toBe('# Enrolled report');
      expect(opened.body.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(runtime.latestBriefing).toHaveBeenCalledTimes(2);
      expect(runtime.latestBriefing).toHaveBeenLastCalledWith({ date }, expect.any(AbortSignal));
      delete process.env.MITZO_WORKSPACE_RUNTIME_CONFIG;
      const unenrolled = await request(app)
        .get('/api/home/briefing')
        .query({ date })
        .set('Cookie', authCookie);
      expect(unenrolled.status).toBe(200);
      expect(unenrolled.body.content).toBe('# Legacy report');
    } finally {
      unlinkSync(legacy);
      unlinkSync(selected);
    }
  });
});
