import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskOrchestrator } from '../task-orchestrator.js';
import { TaskStore } from '../task-store.js';
import { handleTaskArtifact, handleTaskComplete } from '../task-tools.js';
import { buildTaskContextPrompt } from '../task-context.js';

const TEST_REPO = join(tmpdir(), `mitzo-task-routes-test-${process.pid}`);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-task-routes-test-${process.pid}`);
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
    registry: { get: vi.fn(), findBySessionId: vi.fn() },
    eventStore: { getEventsAfter: vi.fn().mockReturnValue([]) },
    setTaskStore: vi.fn(),
    sendToChat: vi.fn().mockResolvedValue(true),
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

describe('POST /api/loop/spawn', () => {
  afterEach(async () => {
    // Reset orchestrator to null after each test
    const mod = await import('../app.js');
    (mod as unknown as { setOrchestrator: (o: unknown) => void }).setOrchestrator(null as never);
  });

  it('returns 503 when orchestrator is not initialized', async () => {
    const res = await request(app)
      .post('/api/loop/spawn')
      .send({ enabled: true })
      .set('Cookie', authCookie);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Orchestrator/i);
  });

  it('returns 400 when enabled is missing', async () => {
    const mod = await import('../app.js');
    mod.setOrchestrator({ setSpawnEnabled: vi.fn(), getStatus: vi.fn() } as never);

    const res = await request(app).post('/api/loop/spawn').send({}).set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enabled/i);
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const mod = await import('../app.js');
    mod.setOrchestrator({ setSpawnEnabled: vi.fn(), getStatus: vi.fn() } as never);

    const res = await request(app)
      .post('/api/loop/spawn')
      .send({ enabled: 'yes' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });

  it('sets spawn enabled and returns status', async () => {
    const mockStatus = {
      state: 'idle',
      goalId: null,
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
      spawnEnabled: true,
    };
    const mod = await import('../app.js');
    mod.setOrchestrator({
      setSpawnEnabled: vi.fn(),
      getStatus: vi.fn().mockReturnValue(mockStatus),
    } as never);

    const res = await request(app)
      .post('/api/loop/spawn')
      .send({ enabled: true })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.spawnEnabled).toBe(true);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).post('/api/loop/spawn').send({ enabled: true });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/loop/start', () => {
  afterEach(async () => {
    const mod = await import('../app.js');
    mod.setOrchestrator(null as never);
  });

  it('explains when an existing chat must be selected', async () => {
    const mod = await import('../app.js');
    const goal = mod.taskStore.create({ title: 'Reuse workflow' });
    const start = vi.fn();
    mod.setOrchestrator({
      getStatus: () => ({ state: 'idle' }),
      requiresClientId: () => true,
      start,
    } as never);

    const res = await request(app)
      .post('/api/loop/start')
      .send({ goalId: goal.id })
      .set('Cookie', authCookie);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'client_id_required', requiredField: 'sessionId' });
    expect(start).not.toHaveBeenCalled();
  });

  it('resolves a selected session to its driver client ID', async () => {
    const mod = await import('../app.js');
    const { registry } = await import('../chat.js');
    const goal = mod.taskStore.create({ title: 'Reuse workflow' });
    vi.mocked(registry.findBySessionId).mockReturnValue({
      clientId: 'connection-1:session-1',
      session: {},
    } as never);
    vi.mocked(registry.get).mockReturnValue({} as never);
    const start = vi.fn().mockReturnValue({ state: 'running' });
    mod.setOrchestrator({
      getStatus: () => ({ state: 'idle' }),
      requiresClientId: () => false,
      start,
    } as never);

    const res = await request(app)
      .post('/api/loop/start')
      .send({ goalId: goal.id, sessionId: 'session-1' })
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith(goal.id, {
      specMode: undefined,
      clientId: 'connection-1:session-1',
    });
  });
});

describe('mapped worker Task Board review', () => {
  afterEach(async () => {
    const mod = await import('../app.js');
    mod.setOrchestrator(null as never);
    const { registry, sendToChat } = await import('../chat.js');
    vi.mocked(registry.get).mockReset();
    vi.mocked(registry.findBySessionId).mockReset();
    vi.mocked(sendToChat).mockClear();
  });

  async function completedMappedWorker() {
    const mod = await import('../app.js');
    const { registry, sendToChat } = await import('../chat.js');
    const suffix = mod.taskStore.getTree().length;
    const workerId = `review-worker-${suffix}`;
    const task = mod.taskStore.createOrRecoverTelosExecutionTask(
      { title: 'Exact reviewed slice', annotations: ['retained provenance'] },
      {
        attemptId: `review-attempt-${suffix}`,
        childItemId: 'review-child',
        leadConversationId: 'review-lead',
        workerConversationId: workerId,
        contextSnapshotId: 'review-context',
        contextHash: 'a'.repeat(64),
      },
    );
    const session = {
      sessionId: workerId,
      taskContext: { currentTaskId: task.id, goalId: task.id },
    };
    vi.mocked(registry.get).mockReturnValue(session as never);
    vi.mocked(registry.findBySessionId).mockReturnValue({
      clientId: 'active-worker-client',
      session,
    } as never);
    const deps = {
      store: mod.taskStore,
      getClientId: vi.fn(() => 'active-worker-client'),
      setTaskContext: vi.fn(),
      clearTaskContext: vi.fn(),
      broadcastStatus: vi.fn(),
      broadcastTasks: vi.fn(),
      spawnSession: vi.fn().mockResolvedValue('unrequested-worker'),
      assertTaskExecutionScope: vi.fn(),
    };
    const owner = new TaskOrchestrator(deps);
    mod.setOrchestrator(owner);
    expect(handleTaskArtifact(mod.taskStore, task.id, 'report', 'saved evidence')).toContain(
      'Artifact stored',
    );
    expect(handleTaskComplete(mod.taskStore, task.id, 'Worker result for review')).toContain(
      'pending_review',
    );
    owner.onTaskCompleted(task.id);
    expect(owner.getStatus().state).toBe('idle');
    expect(mod.taskStore.get(task.id)?.status).toBe('pending_review');
    vi.mocked(sendToChat).mockClear();
    return { mod, task, owner, deps, session, sendToChat };
  }

  it('retains HTTP rejection feedback for an idle-loop mapped worker without submitting a turn', async () => {
    const f = await completedMappedWorker();
    const before = f.mod.taskStore.get(f.task.id)!;
    const mapping = f.mod.taskStore.getTelosExecutionBinding(f.task.id);
    const loop = f.owner.getStatus();
    const start = vi.spyOn(f.owner, 'start');
    const tick = vi.spyOn(f.owner, 'tick');
    const delegate = vi.spyOn(f.owner, 'delegateSlice');

    const res = await request(app)
      .post(`/api/tasks/${f.task.id}/reject`)
      .set('Cookie', authCookie)
      .send({ feedback: 'Add the missing acceptance evidence' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(f.mod.taskStore.get(f.task.id)).toEqual({
      ...before,
      status: 'pending',
      annotations: [...before.annotations, 'review_feedback: Add the missing acceptance evidence'],
      updatedAt: expect.any(Number),
    });
    expect(f.mod.taskStore.getTelosExecutionBinding(f.task.id)).toEqual(mapping);
    expect(f.owner.getStatus()).toEqual(loop);
    expect(f.session.taskContext).toEqual({ currentTaskId: f.task.id, goalId: f.task.id });
    expect(f.sendToChat).not.toHaveBeenCalled();
    expect(f.deps.spawnSession).not.toHaveBeenCalled();
    expect(f.deps.setTaskContext).not.toHaveBeenCalled();
    expect(f.deps.clearTaskContext).not.toHaveBeenCalled();
    expect(f.deps.assertTaskExecutionScope).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(delegate).not.toHaveBeenCalled();
    expect(f.deps.broadcastTasks).toHaveBeenCalledOnce();
    expect(f.deps.broadcastStatus).not.toHaveBeenCalled();

    const reopened = new TaskStore(join(TEST_REPO, '.mitzo', 'tasks.db'));
    try {
      expect(reopened.get(f.task.id)).toEqual(f.mod.taskStore.get(f.task.id));
      expect(reopened.getTelosExecutionBinding(f.task.id)).toEqual(mapping);
      expect(buildTaskContextPrompt(reopened, f.task.id)).toContain(
        'review_feedback: Add the missing acceptance evidence',
      );
    } finally {
      reopened.close();
    }
  });

  it('keeps mapped approval explicit and preserves an unauthenticated rejection unchanged', async () => {
    const f = await completedMappedWorker();
    const before = f.mod.taskStore.get(f.task.id);
    const unauthorized = await request(app)
      .post(`/api/tasks/${f.task.id}/reject`)
      .send({ feedback: 'Untrusted feedback' });
    expect(unauthorized.status).toBe(401);
    expect(f.mod.taskStore.get(f.task.id)).toEqual(before);
    const approved = await request(app)
      .post(`/api/tasks/${f.task.id}/approve`)
      .set('Cookie', authCookie);
    expect(approved.status).toBe(200);
    expect(f.mod.taskStore.get(f.task.id)?.status).toBe('done');
    expect(f.sendToChat).not.toHaveBeenCalled();
    expect(f.deps.spawnSession).not.toHaveBeenCalled();
    expect(f.owner.getStatus().state).toBe('idle');
  });
});
