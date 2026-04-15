import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-test-repo-${process.pid}`);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-test-repo-${process.pid}`);
  return {
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn().mockResolvedValue(undefined),
    hideSession: vi.fn(),
    clearHiddenSessions: vi.fn(),
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
  };
});

vi.mock('../permissions.js', () => ({
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
