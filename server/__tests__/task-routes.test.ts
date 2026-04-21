import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-task-routes-test-${process.pid}`);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-task-routes-test-${process.pid}`);
  return {
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
  mkdirSync(join(TEST_REPO, '.mitzo'), { recursive: true });

  const mod = await import('../app.js');
  app = mod.app;

  const agent = request(app);
  authCookie = await getAuthCookie(agent);
});

afterAll(async () => {
  // Clean up the task store
  try {
    const mod = await import('../app.js');
    if (mod.taskStore?.close) mod.taskStore.close();
  } catch {
    // ignore
  }
  try {
    rmSync(TEST_REPO, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('task routes', () => {
  // --- Auth ---

  it('GET /api/tasks — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('POST /api/tasks — unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/tasks').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  // --- GET /api/tasks ---

  it('GET /api/tasks — returns empty task list', async () => {
    const res = await request(app).get('/api/tasks').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tasks');
    expect(Array.isArray(res.body.tasks)).toBe(true);
  });

  // --- POST /api/tasks ---

  it('POST /api/tasks — creates a task', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Test task' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('task');
    expect(res.body.task.title).toBe('Test task');
    expect(res.body.task.status).toBe('pending');
    expect(res.body.task.id).toBeTruthy();
  });

  it('POST /api/tasks — missing title returns 400', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'no title' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });

  it('POST /api/tasks — empty title returns 400', async () => {
    const res = await request(app).post('/api/tasks').send({ title: '' }).set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });

  it('POST /api/tasks — accepts optional fields', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({
        title: 'Full task',
        description: 'desc',
        priority: 5,
        sessionPolicy: 'spawn',
        annotations: ['a'],
      })
      .set('Cookie', authCookie);
    expect(res.status).toBe(201);
    expect(res.body.task.description).toBe('desc');
    expect(res.body.task.priority).toBe(5);
    expect(res.body.task.sessionPolicy).toBe('spawn');
    expect(res.body.task.annotations).toEqual(['a']);
  });

  // --- GET /api/tasks/:id ---

  it('GET /api/tasks/:id — returns a task', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Findable' })
      .set('Cookie', authCookie);
    const id = createRes.body.task.id;

    const res = await request(app).get(`/api/tasks/${id}`).set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Findable');
  });

  it('GET /api/tasks/:id — 404 for nonexistent', async () => {
    const res = await request(app).get('/api/tasks/nonexistent').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  // --- PATCH /api/tasks/:id ---

  it('PATCH /api/tasks/:id — updates a task', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Update me' })
      .set('Cookie', authCookie);
    const id = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ title: 'Updated', status: 'active' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Updated');
    expect(res.body.task.status).toBe('active');
  });

  it('PATCH /api/tasks/:id — 404 for nonexistent', async () => {
    const res = await request(app)
      .patch('/api/tasks/nonexistent')
      .send({ title: 'nope' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  // --- DELETE /api/tasks/:id ---

  it('DELETE /api/tasks/:id — deletes a task', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Delete me' })
      .set('Cookie', authCookie);
    const id = createRes.body.task.id;

    const res = await request(app).delete(`/api/tasks/${id}`).set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const getRes = await request(app).get(`/api/tasks/${id}`).set('Cookie', authCookie);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /api/tasks/:id — 404 for nonexistent', async () => {
    const res = await request(app).delete('/api/tasks/nonexistent').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });
});
