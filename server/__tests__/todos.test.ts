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
    getSessions: vi.fn().mockResolvedValue([]),
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

describe('todo routes', () => {
  it('GET /api/todos — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/todos');
    expect(res.status).toBe(401);
  });

  it('GET /api/todos — returns empty when script not found', async () => {
    const res = await request(app).get('/api/todos').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('profiles');
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.profiles)).toBe(true);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('GET /api/todos — accepts profile query param', async () => {
    const res = await request(app)
      .get('/api/todos')
      .query({ profile: 'centaur' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('profiles');
    expect(res.body).toHaveProperty('items');
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
});
