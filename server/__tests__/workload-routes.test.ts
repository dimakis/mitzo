import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-workload-routes-test-${process.pid}`);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-workload-routes-test-${process.pid}`);
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
  // Clean up stores
  try {
    const mod = await import('../app.js');
    if (mod.taskStore?.close) mod.taskStore.close();
    if (mod.workloadStore?.close) mod.workloadStore.close();
  } catch {
    // ignore
  }
  try {
    rmSync(TEST_REPO, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('workload routes', () => {
  // --- Auth ---

  it('POST /api/workload/signals — unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/workload/signals').send({
      sourceType: 'test',
      sourceId: '123',
      url: 'https://example.com',
      title: 'Test',
      author: 'Test Author',
      timestamp: new Date().toISOString(),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/workload/items — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/workload/items');
    expect(res.status).toBe(401);
  });

  // --- POST /api/workload/signals ---

  it('POST /api/workload/signals — creates new item and source', async () => {
    const signal = {
      sourceType: 'github',
      sourceId: 'pr-123',
      url: 'https://github.com/org/repo/pull/123',
      title: 'Fix critical bug',
      snippet: 'This PR fixes a critical issue',
      author: 'alice',
      timestamp: new Date().toISOString(),
      profile: 'default',
      urgencyHint: 0.8,
    };

    const res = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      created: true,
      item: {
        title: signal.title,
        snippet: signal.snippet,
        status: 'active',
        profile: 'default',
        starred: false,
      },
    });
    expect(res.body.item.sources).toHaveLength(1);
    expect(res.body.item.sources[0]).toMatchObject({
      sourceType: 'github',
      sourceId: 'pr-123',
      title: signal.title,
    });
  });

  it('POST /api/workload/signals — deduplicates by (sourceType, sourceId)', async () => {
    const signal = {
      sourceType: 'jira',
      sourceId: 'PROJ-456',
      url: 'https://jira.example.com/browse/PROJ-456',
      title: 'Implement feature',
      author: 'bob',
      timestamp: new Date().toISOString(),
    };

    // First call creates
    const res1 = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    expect(res1.status).toBe(201);
    expect(res1.body.created).toBe(true);

    // Second call with same sourceType + sourceId returns existing
    const res2 = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send({ ...signal, timestamp: new Date().toISOString() });
    expect(res2.status).toBe(200);
    expect(res2.body.created).toBe(false);
    expect(res2.body.item.id).toBe(res1.body.item.id);
  });

  it('POST /api/workload/signals — validates timestamp format', async () => {
    const signal = {
      sourceType: 'test',
      sourceId: 'invalid-ts',
      url: 'https://example.com',
      title: 'Test',
      author: 'Test',
      timestamp: 'not-a-valid-date',
    };

    const res = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);

    expect(res.status).toBe(400);
  });

  it('POST /api/workload/signals — validates URL format', async () => {
    const signal = {
      sourceType: 'test',
      sourceId: 'bad-url',
      url: 'not a url',
      title: 'Test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };

    const res = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);

    expect(res.status).toBe(400);
  });

  it('POST /api/workload/signals — merges context hints', async () => {
    const signal = {
      sourceType: 'test',
      sourceId: 'hints-test',
      url: 'https://example.com',
      title: 'Test hints',
      author: 'Test',
      timestamp: new Date().toISOString(),
      contextHints: {
        repos: ['repo1', 'repo2'],
        keywords: ['urgent'],
        taskHint: 'Review and merge',
      },
    };

    const res = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);

    expect(res.status).toBe(201);
    expect(res.body.item.contextHints).toMatchObject({
      repos: ['repo1', 'repo2'],
      keywords: ['urgent'],
      taskHint: 'Review and merge',
    });
  });

  // --- POST /api/workload/signals/batch ---

  it('POST /api/workload/signals/batch — ingests multiple signals', async () => {
    const signals = [
      {
        sourceType: 'batch-test',
        sourceId: 'batch-1',
        url: 'https://example.com/1',
        title: 'Batch item 1',
        author: 'Test',
        timestamp: new Date().toISOString(),
      },
      {
        sourceType: 'batch-test',
        sourceId: 'batch-2',
        url: 'https://example.com/2',
        title: 'Batch item 2',
        author: 'Test',
        timestamp: new Date().toISOString(),
      },
    ];

    const res = await request(app)
      .post('/api/workload/signals/batch')
      .set('Cookie', authCookie)
      .send({ signals });

    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.created).toBe(2);
    expect(res.body.total).toBe(2);
  });

  it('POST /api/workload/signals/batch — validates max batch size', async () => {
    const signals = Array.from({ length: 101 }, (_, i) => ({
      sourceType: 'batch',
      sourceId: `batch-${i}`,
      url: `https://example.com/${i}`,
      title: `Item ${i}`,
      author: 'Test',
      timestamp: new Date().toISOString(),
    }));

    const res = await request(app)
      .post('/api/workload/signals/batch')
      .set('Cookie', authCookie)
      .send({ signals });

    expect(res.status).toBe(400);
  });

  // --- GET /api/workload/items ---

  it('GET /api/workload/items — lists all items', async () => {
    const res = await request(app).get('/api/workload/items').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('profiles');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('GET /api/workload/items — filters by status', async () => {
    // Create item and complete it
    const signal = {
      sourceType: 'status-test',
      sourceId: 'st-1',
      url: 'https://example.com',
      title: 'Status test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    await request(app)
      .patch(`/api/workload/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({ status: 'completed' });

    const res = await request(app)
      .get('/api/workload/items?status=completed')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.items.some((item: { id: string }) => item.id === itemId)).toBe(true);
  });

  // --- GET /api/workload/items/:id ---

  it('GET /api/workload/items/:id — returns item by ID', async () => {
    const signal = {
      sourceType: 'get-test',
      sourceId: 'gt-1',
      url: 'https://example.com',
      title: 'Get test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const res = await request(app).get(`/api/workload/items/${itemId}`).set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.item.id).toBe(itemId);
  });

  it('GET /api/workload/items/:id — returns 404 for missing item', async () => {
    const res = await request(app)
      .get('/api/workload/items/nonexistent-id')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
  });

  // --- PATCH /api/workload/items/:id ---

  it('PATCH /api/workload/items/:id — updates item fields', async () => {
    const signal = {
      sourceType: 'update-test',
      sourceId: 'ut-1',
      url: 'https://example.com',
      title: 'Update test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const res = await request(app)
      .patch(`/api/workload/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({
        title: 'Updated title',
        starred: true,
        urgency: 0.9,
      });

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: itemId,
      title: 'Updated title',
      starred: true,
      urgency: 0.9,
    });
  });

  it('PATCH /api/workload/items/:id — returns 404 for missing item', async () => {
    const res = await request(app)
      .patch('/api/workload/items/nonexistent-id')
      .set('Cookie', authCookie)
      .send({ title: 'New title' });

    expect(res.status).toBe(404);
  });

  it('PATCH /api/workload/items/:id — validates input', async () => {
    const signal = {
      sourceType: 'validation-test',
      sourceId: 'vt-1',
      url: 'https://example.com',
      title: 'Validation test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const res = await request(app)
      .patch(`/api/workload/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({ urgency: 2.0 }); // Invalid: > 1.0

    expect(res.status).toBe(400);
  });

  // --- DELETE /api/workload/items/:id ---

  it('DELETE /api/workload/items/:id — deletes item', async () => {
    const signal = {
      sourceType: 'delete-test',
      sourceId: 'dt-1',
      url: 'https://example.com',
      title: 'Delete test',
      author: 'Test',
      timestamp: new Date().toISOString(),
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const res = await request(app)
      .delete(`/api/workload/items/${itemId}`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify deletion
    const getRes = await request(app)
      .get(`/api/workload/items/${itemId}`)
      .set('Cookie', authCookie);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /api/workload/items/:id — returns 404 for missing item', async () => {
    const res = await request(app)
      .delete('/api/workload/items/nonexistent-id')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
  });

  // --- POST /api/workload/items/:id/promote ---

  it('POST /api/workload/items/:id/promote — creates task from item', async () => {
    const signal = {
      sourceType: 'promote-test',
      sourceId: 'pt-1',
      url: 'https://example.com',
      title: 'Promote test',
      snippet: 'This should become a task',
      author: 'Test',
      timestamp: new Date().toISOString(),
      contextHints: {
        repos: ['test-repo'],
        taskHint: 'Review carefully',
      },
    };
    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const res = await request(app)
      .post(`/api/workload/items/${itemId}/promote`)
      .set('Cookie', authCookie)
      .send({ description: 'Additional context' });

    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      title: signal.title,
      status: 'pending',
    });
    expect(res.body.task.description).toContain('Additional context');
    expect(res.body.task.description).toContain('Review carefully');
    expect(res.body.item.status).toBe('acknowledged');
    expect(res.body.item.goalId).toBe(res.body.task.id);
  });

  it('POST /api/workload/items/:id/promote — returns 404 for missing item with no body title', async () => {
    const res = await request(app)
      .post('/api/workload/items/nonexistent-id/promote')
      .set('Cookie', authCookie)
      .send({});

    expect(res.status).toBe(404);
  });

  it('POST /api/workload/items/:id/promote — returns 404 for missing item with description but no title', async () => {
    const res = await request(app)
      .post('/api/workload/items/nonexistent-id/promote')
      .set('Cookie', authCookie)
      .send({ description: 'has context but no title' });

    expect(res.status).toBe(404);
  });

  it('POST /api/workload/items/:id/promote — creates task from body fallback (Telos item)', async () => {
    const res = await request(app)
      .post('/api/workload/items/telos-item-123/promote')
      .set('Cookie', authCookie)
      .send({
        title: 'Telos task title',
        description: 'Extra context',
        contextHints: {
          repos: ['mitzo'],
          taskHint: 'Check the API layer',
        },
        sources: [{ type: 'telos', url: 'https://example.com', title: 'Source doc' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({
      title: 'Telos task title',
      status: 'pending',
    });
    expect(res.body.task.description).toContain('Extra context');
    expect(res.body.task.description).toContain('Check the API layer');
    expect(res.body.task.annotations).toEqual(
      expect.arrayContaining([expect.stringContaining('Source doc')]),
    );
    expect(res.body.item).toBeUndefined();
  });

  it('POST /api/workload/items/:id/promote — fallback does not broadcast workload update', async () => {
    const { setWorkloadBroadcast } = await import('../app.js');
    const broadcasts: unknown[] = [];
    setWorkloadBroadcast((msg: Record<string, unknown>) => broadcasts.push(msg));

    await request(app)
      .post('/api/workload/items/telos-no-broadcast/promote')
      .set('Cookie', authCookie)
      .send({ title: 'No broadcast test' });

    const workloadBroadcasts = broadcasts.filter((b: any) => b.type === 'workload_item_updated');
    expect(workloadBroadcasts).toHaveLength(0);

    // Reset — no broadcast callback in test environment
    setWorkloadBroadcast(() => {});
  });

  it('POST /api/workload/items/:id/promote — broadcasts workload_item_updated', async () => {
    // Create an item first
    const signal = {
      sourceType: 'broadcast-test',
      sourceId: `broadcast-promote-${Date.now()}`,
      url: 'https://example.com/broadcast',
      title: 'Broadcast promote test',
      author: 'tester',
      timestamp: new Date().toISOString(),
      profile: 'default',
    };

    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    expect(createRes.status).toBe(201);
    const itemId = createRes.body.item.id;

    // Promote it — verify response has goalId set
    const promoteRes = await request(app)
      .post(`/api/workload/items/${itemId}/promote`)
      .set('Cookie', authCookie)
      .send({});
    expect(promoteRes.status).toBe(201);
    expect(promoteRes.body.item.goalId).toBe(promoteRes.body.task.id);
  });

  it('POST /api/workload/items/:id/promote — links goalId to created task', async () => {
    const signal = {
      sourceType: 'link-test',
      sourceId: `link-promote-${Date.now()}`,
      url: 'https://example.com/link',
      title: 'Link promote test',
      author: 'tester',
      timestamp: new Date().toISOString(),
      profile: 'default',
    };

    const createRes = await request(app)
      .post('/api/workload/signals')
      .set('Cookie', authCookie)
      .send(signal);
    const itemId = createRes.body.item.id;

    const promoteRes = await request(app)
      .post(`/api/workload/items/${itemId}/promote`)
      .set('Cookie', authCookie)
      .send({});

    // Verify the item's goalId matches the task id
    expect(promoteRes.body.item.goalId).toBeTruthy();
    expect(promoteRes.body.task.id).toBeTruthy();
    expect(promoteRes.body.item.goalId).toBe(promoteRes.body.task.id);

    // Verify item status changed to acknowledged
    expect(promoteRes.body.item.status).toBe('acknowledged');
  });
});
