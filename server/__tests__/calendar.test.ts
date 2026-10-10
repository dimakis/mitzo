import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'fs';
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
  mkdirSync(join(TEST_REPO, 'mgmt_lib', 'inbox', 'archive'), { recursive: true });

  const mod = await import('../app.js');
  app = mod.app;

  const agent = request(app);
  authCookie = await getAuthCookie(agent);
});

describe('calendar routes', () => {
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
  it('keeps calendar response and clamping while using the enrolled runtime', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '/operator/enrollment.json';
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
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '/operator/enrollment.json';
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
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '/operator/enrollment.json';
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
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '/operator/enrollment.json';
    runtime.briefingsRoot = '/private/unrelated-documents';
    runtime.latestBriefing.mockResolvedValue(null);
    const result = await request(app)
      .get('/api/briefings/latest')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(503);
    expect(runtime.latestBriefing).not.toHaveBeenCalled();
  });
  it('distinguishes runtime failure from no saved briefing without leaking diagnostics', async () => {
    process.env.MITZO_WORKSPACE_RUNTIME_CONFIG = '/operator/enrollment.json';
    runtime.latestBriefing.mockRejectedValue(new Error('credential details'));
    const result = await request(app)
      .get('/api/briefings/latest')
      .query({ date: '2026-10-10' })
      .set('Cookie', authCookie);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'Workspace runtime briefing unavailable' });
  });
});
