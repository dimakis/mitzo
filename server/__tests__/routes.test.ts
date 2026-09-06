import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'fs';
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
    getSessions: vi.fn().mockResolvedValue({
      sessions: [{ id: 's1', summary: 'Test', lastModified: 1 }],
      hasMore: false,
    }),
    getSessionsCached: vi.fn().mockReturnValue({
      sessions: [{ id: 's1', summary: 'Test', lastModified: 1 }],
      hasMore: false,
    }),
    reconcileSessionsBackground: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([{ messageId: 'm1', role: 'assistant', blocks: [] }]),
    renameSessionById: vi.fn().mockResolvedValue(undefined),
    hideSession: vi.fn(),
    hideAllSessions: vi.fn(),
    startChat: vi.fn(),
    BASE_REPO: repo,
    getRepoConfig: vi.fn(() => ({
      quickActions: [],
      allowedPaths: [],
      roots: [
        { label: 'Main', path: repo },
        { label: 'Tools', path: '/some/tools' },
      ],
      resolvedVenvPaths: [],
      toolTierOverrides: {},
      inboxPath: 'mgmt_lib/inbox',
      resolvedInboxPath: pjoin(repo, 'mgmt_lib/inbox'),
      repos: {},
      contextBlocks: {},
    })),
    getMcpServerNames: vi.fn().mockReturnValue(['test-mcp']),
    AVAILABLE_MODELS: [{ id: 'test-model', label: 'Test', desc: 'Test model' }],
    registry: {
      get: vi.fn(),
      getActiveSessions: vi.fn().mockReturnValue([
        {
          clientId: 'client-1',
          sessionId: 's1',
          mode: 'agent',
          cwd: '/tmp/repo',
          attached: true,
          cumulativeSessionTokens: 1000,
          cumulativeCostUsd: 0.05,
          hasSnapshot: false,
          taskContext: null,
          observerCount: 0,
        },
      ]),
      findBySessionId: vi.fn().mockImplementation((id: string) => {
        if (id === 's1') return { clientId: 'conn-abc:s1', session: {} };
        return null;
      }),
      suspend: vi.fn(),
    },
    setTaskStore: vi.fn(),
    eventStore: {
      append: vi.fn(),
      getEventsAfter: vi.fn().mockReturnValue([]),
      searchSessions: vi.fn().mockReturnValue([
        {
          sessionId: 's1',
          summary: 'Test',
          snippet: '...matched text...',
          matchedAt: 1000,
          updatedAt: 2000,
        },
      ]),
      getSession: vi.fn().mockImplementation((id: string) => {
        if (id === 's1') {
          return {
            sessionId: 's1',
            summary: 'Test',
            branch: 'main',
            cwd: '/tmp/repo',
            mode: 'agent',
            wtId: null,
            isActive: true,
            isHidden: false,
            promptCount: 0,
            manuallyRenamed: false,
            initialPrompt: null,
            inputTokens: 5000,
            outputTokens: 3000,
            cacheReadTokens: 1000,
            cacheCreationTokens: 500,
            totalCostUsd: 0.05,
            numTurns: 3,
            durationMs: 10000,
            durationApiMs: 8000,
            goalId: null,
            createdAt: 1000,
            updatedAt: 2000,
          };
        }
        return null;
      }),
      setSessionState: vi.fn(),
    },
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

import { hideSession, hideAllSessions, renameSessionById, eventStore } from '../chat.js';
import { resolvePending } from '../permissions.js';

let app: Express;
let authCookie: string;

async function getAuthCookie(agent: request.Agent): Promise<string> {
  const res = await agent.post('/api/auth/login').send({ passphrase: process.env.AUTH_PASSPHRASE });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) throw new Error('No cookie returned from login');
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies[0].split(';')[0];
}

const INBOX_DIR = join(TEST_REPO, 'mgmt_lib', 'inbox');
const SAMPLE_INBOX_ITEM = `---
agent: troubadour
timestamp: 2026-04-03T15:41:49
status: pending
tags: [cross-spoke, okrs]
---

# Connection: okrs/ → team_home/

Some body text here.
`;

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  writeFileSync(join(TEST_REPO, 'test.txt'), 'hello world');
  mkdirSync(join(TEST_REPO, 'subdir'), { recursive: true });
  writeFileSync(join(TEST_REPO, 'subdir', 'nested.txt'), 'nested content');
  mkdirSync(join(INBOX_DIR, 'archive'), { recursive: true });
  writeFileSync(join(INBOX_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_INBOX_ITEM);

  process.env.NTFY_AUTH_TOKEN = 'test-ntfy-token';

  const mod = await import('../app.js');
  app = mod.app;

  const agent = request(app);
  authCookie = await getAuthCookie(agent);
});

beforeEach(() => {
  vi.mocked(hideSession).mockClear();
  vi.mocked(hideAllSessions).mockClear();
});

// --- Auth Routes ---

describe('auth routes', () => {
  it('POST /api/auth/login — correct passphrase returns 200 + cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(res.headers['set-cookie']).toBeDefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toContain('cc_auth=');
  });

  it('POST /api/auth/login — wrong passphrase returns 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ passphrase: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid passphrase');
  });

  it('POST /api/auth/logout — clears cookie', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/auth/check — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/auth/check');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/check — authenticated returns 200', async () => {
    const res = await request(app).get('/api/auth/check').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// --- Bearer Token Auth ---

describe('bearer token auth', () => {
  let bearerToken: string;

  beforeAll(async () => {
    // Get a JWT from login response
    const res = await request(app)
      .post('/api/auth/login')
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    bearerToken = res.body.token;
  });

  it('GET /api/auth/check — accepts Authorization: Bearer header', async () => {
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${bearerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/sessions — works with Bearer token instead of cookie', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${bearerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it('rejects invalid Bearer token', async () => {
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', 'Bearer invalid-token');
    expect(res.status).toBe(401);
  });

  it('rejects malformed Authorization header', async () => {
    const res = await request(app).get('/api/auth/check').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
  });
});

// --- Security: CSP Headers ---

describe('security headers', () => {
  it('responses include CSP with img-src allowing data: URIs', async () => {
    const res = await request(app).get('/api/version');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("img-src 'self' data:");
  });

  it('responses include X-Content-Type-Options', async () => {
    const res = await request(app).get('/api/version');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

// --- Security: Login Rate Limiting ---

describe('login rate limiting', () => {
  it('returns 429 after exceeding login attempts', async () => {
    const agent = request(app);
    const attempts = [];
    for (let i = 0; i < 10; i++) {
      attempts.push(agent.post('/api/auth/login').send({ passphrase: 'wrong' }));
    }
    const results = await Promise.all(attempts);
    const got429 = results.some((r) => r.status === 429);
    expect(got429).toBe(true);

    const last429 = results.filter((r) => r.status === 429);
    expect(last429[0].body.error).toContain('Too many login attempts');
  });
});

// --- Permission Route ---

describe('permission route', () => {
  it('POST /api/permission/:permId/respond — valid token + decision', async () => {
    const res = await request(app)
      .post('/api/permission/p1/respond')
      .query({ token: 'test-ntfy-token', decision: 'once' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: 'once' });
  });

  it('POST /api/permission/:permId/respond — invalid token returns 401', async () => {
    const res = await request(app)
      .post('/api/permission/p1/respond')
      .query({ token: 'bad-token', decision: 'once' });
    expect(res.status).toBe(401);
  });

  it('POST /api/permission/:permId/respond — bad decision returns 400', async () => {
    const res = await request(app)
      .post('/api/permission/p1/respond')
      .query({ token: 'test-ntfy-token', decision: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('POST /api/permission/:permId/respond — unknown permId returns 404', async () => {
    vi.mocked(resolvePending).mockReturnValueOnce(false);
    const res = await request(app)
      .post('/api/permission/unknown/respond')
      .query({ token: 'test-ntfy-token', decision: 'once' });
    expect(res.status).toBe(404);
  });
});

// --- Session Routes ---

describe('session routes', () => {
  it('GET /api/sessions/active — returns active sessions from registry', async () => {
    const res = await request(app).get('/api/sessions/active').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      clientId: 'client-1',
      sessionId: 's1',
      mode: 'agent',
      attached: true,
    });
  });

  it('GET /api/sessions/active — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/sessions/active');
    expect(res.status).toBe(401);
  });

  it('GET /api/sessions — annotates sessions with active status and token data', async () => {
    const res = await request(app).get('/api/sessions').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    const s1 = res.body.sessions.find((s: { id: string }) => s.id === 's1');
    expect(s1).toBeDefined();
    expect(s1.isActive).toBe(true);
    expect(s1.isAttached).toBe(true);
    expect(s1.totalTokens).toBe(9500); // 5000 + 3000 + 1000 + 500
    expect(s1.numTurns).toBe(3);
  });

  it('GET /api/sessions — authenticated returns paginated shape', async () => {
    const res = await request(app).get('/api/sessions').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
  });

  it('GET /api/sessions — uses cached path by default', async () => {
    const { getSessionsCached } = await import('../chat.js');
    await request(app).get('/api/sessions?offset=5&limit=10').set('Cookie', authCookie);
    expect(getSessionsCached).toHaveBeenCalledWith(5, 10);
  });

  it('GET /api/sessions — clamps invalid offset and limit', async () => {
    const { getSessionsCached } = await import('../chat.js');
    await request(app).get('/api/sessions?offset=-1&limit=999').set('Cookie', authCookie);
    expect(getSessionsCached).toHaveBeenCalledWith(0, 100);
  });

  it('GET /api/sessions — uses defaults when no params', async () => {
    const { getSessionsCached } = await import('../chat.js');
    await request(app).get('/api/sessions').set('Cookie', authCookie);
    expect(getSessionsCached).toHaveBeenCalledWith(0, 20);
  });

  it('GET /api/sessions?full=1 — uses filesystem scan', async () => {
    const { getSessions } = await import('../chat.js');
    await request(app).get('/api/sessions?full=1').set('Cookie', authCookie);
    expect(getSessions).toHaveBeenCalledWith(0, 20);
  });

  it('GET /api/sessions — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });

  it('GET /api/sessions/:id/messages — returns messages', async () => {
    const res = await request(app).get('/api/sessions/s1/messages').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('DELETE /api/sessions/:id — hides session', async () => {
    const res = await request(app).delete('/api/sessions/s1').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(hideSession).toHaveBeenCalledWith('s1');
  });

  it('DELETE /api/sessions — hides all sessions', async () => {
    const res = await request(app).delete('/api/sessions').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(hideAllSessions).toHaveBeenCalled();
  });

  it('PUT /api/sessions/:id/rename — renames session', async () => {
    const res = await request(app)
      .put('/api/sessions/s1/rename')
      .set('Cookie', authCookie)
      .send({ title: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(renameSessionById).toHaveBeenCalledWith('s1', 'New Name');
  });

  it('PUT /api/sessions/:id/rename — empty body returns 400', async () => {
    const res = await request(app)
      .put('/api/sessions/s1/rename')
      .set('Cookie', authCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('PUT /api/sessions/:id/rename — not found returns 404', async () => {
    vi.mocked(renameSessionById).mockRejectedValueOnce(new Error('Session not found'));
    const res = await request(app)
      .put('/api/sessions/bad/rename')
      .set('Cookie', authCookie)
      .send({ title: 'Name' });
    expect(res.status).toBe(404);
  });

  it('PUT /api/sessions/:id/rename — unauthenticated returns 401', async () => {
    const res = await request(app).put('/api/sessions/s1/rename').send({ title: 'Name' });
    expect(res.status).toBe(401);
  });

  it('GET /api/sessions/:id/meta — returns session metadata', async () => {
    const res = await request(app).get('/api/sessions/s1/meta').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: 's1',
      branch: 'main',
      wtId: null,
      cwd: '/tmp/repo',
      mode: 'agent',
      isActive: true,
      totalTokens: 9500,
      totalCostUsd: 0.05,
      numTurns: 3,
    });
  });

  it('GET /api/sessions/:id/meta — unknown session returns 404', async () => {
    const res = await request(app).get('/api/sessions/unknown/meta').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('GET /api/sessions/:id/meta — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/sessions/s1/meta');
    expect(res.status).toBe(401);
  });
});

// --- Session Search Routes ---

describe('session search routes', () => {
  it('GET /api/sessions/search?q=text — returns matching results', async () => {
    const res = await request(app).get('/api/sessions/search?q=matched').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].sessionId).toBe('s1');
    expect(res.body.results[0].snippet).toBe('...matched text...');
    expect(vi.mocked(eventStore.searchSessions)).toHaveBeenCalledWith('matched', 20);
  });

  it('GET /api/sessions/search — empty query returns empty results', async () => {
    const res = await request(app).get('/api/sessions/search?q=').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('GET /api/sessions/search — missing q param returns empty results', async () => {
    const res = await request(app).get('/api/sessions/search').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('GET /api/sessions/search — clamps limit to 50', async () => {
    await request(app).get('/api/sessions/search?q=test&limit=999').set('Cookie', authCookie);
    expect(vi.mocked(eventStore.searchSessions)).toHaveBeenCalledWith('test', 50);
  });

  it('GET /api/sessions/search — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/sessions/search?q=test');
    expect(res.status).toBe(401);
  });
});

// --- Config Routes ---

describe('config routes', () => {
  it('GET /api/version — returns version info without auth', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('commit');
    expect(res.body).toHaveProperty('updateAvailable');
  });

  it('GET /api/models — returns model list', async () => {
    const res = await request(app).get('/api/models').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('id');
  });

  it('GET /api/config — returns config with contextBlocks', async () => {
    const res = await request(app).get('/api/config').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('repoPath');
    expect(res.body).toHaveProperty('mcpServers');
    expect(res.body).toHaveProperty('quickActions');
    expect(res.body).toHaveProperty('contextBlocks');
    expect(typeof res.body.contextBlocks).toBe('object');
  });

  it('GET /api/config — includes fileViewerRoots from repoConfig.roots', async () => {
    const res = await request(app).get('/api/config').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fileViewerRoots');
    expect(res.body.fileViewerRoots).toEqual([
      { label: 'Main', path: TEST_REPO },
      { label: 'Tools', path: '/some/tools' },
    ]);
  });

  it('GET /api/worktrees — returns worktree list', async () => {
    const res = await request(app).get('/api/worktrees').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// --- File Routes ---

describe('file routes', () => {
  it('GET /api/files — lists directory entries', async () => {
    const res = await request(app)
      .get('/api/files')
      .query({ dir: TEST_REPO })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dir');
    expect(res.body).toHaveProperty('entries');
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('test.txt');
    expect(names).toContain('subdir');
  });

  it('GET /api/files — path traversal returns 403', async () => {
    const res = await request(app)
      .get('/api/files')
      .query({ dir: '/etc' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
  });

  it('GET /api/files — nonexistent directory returns 404', async () => {
    const res = await request(app)
      .get('/api/files')
      .query({ dir: join(TEST_REPO, 'nope') })
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('GET /api/files/read — reads file content', async () => {
    const res = await request(app)
      .get('/api/files/read')
      .query({ path: join(TEST_REPO, 'test.txt') })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hello world');
    expect(res.body.ext).toBe('.txt');
  });

  it('GET /api/files/read — disallowed path returns 403', async () => {
    const res = await request(app)
      .get('/api/files/read')
      .query({ path: '/etc/passwd' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
  });

  it('GET /api/files/read — missing file returns 404', async () => {
    const res = await request(app)
      .get('/api/files/read')
      .query({ path: join(TEST_REPO, 'gone.txt') })
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('PUT /api/files/write — writes file', async () => {
    const filePath = join(TEST_REPO, 'test.txt');
    const res = await request(app)
      .put('/api/files/write')
      .set('Cookie', authCookie)
      .send({ path: filePath, content: 'updated content' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, path: filePath });
  });

  it('PUT /api/files/write — missing body fields returns 400', async () => {
    const res = await request(app).put('/api/files/write').set('Cookie', authCookie).send({});
    expect(res.status).toBe(400);
  });

  it('GET /api/files/list — returns entries and currentDir', async () => {
    const res = await request(app)
      .get('/api/files/list')
      .query({ dir: TEST_REPO })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('currentDir', TEST_REPO);
    expect(res.body).toHaveProperty('entries');
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('test.txt');
  });

  it('GET /api/files/list — path traversal returns 403', async () => {
    const res = await request(app)
      .get('/api/files/list')
      .query({ dir: '/etc' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
  });

  it('GET /api/files/roots — returns configured roots', async () => {
    const res = await request(app).get('/api/files/roots').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { label: 'Main', path: TEST_REPO },
      { label: 'Tools', path: '/some/tools' },
    ]);
  });

  it('PUT /api/files/write — disallowed path returns 403', async () => {
    const res = await request(app)
      .put('/api/files/write')
      .set('Cookie', authCookie)
      .send({ path: '/tmp/outside/file.txt', content: 'nope' });
    expect(res.status).toBe(403);
  });

  it('GET /api/files/download — downloads file with Content-Disposition', async () => {
    const dlFile = join(TEST_REPO, 'download-test.txt');
    writeFileSync(dlFile, 'download me');
    const res = await request(app)
      .get('/api/files/download')
      .query({ path: dlFile })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('download-test.txt');
    expect(res.text).toBe('download me');
  });

  it('GET /api/files/download — disallowed path returns 403', async () => {
    const res = await request(app)
      .get('/api/files/download')
      .query({ path: '/etc/passwd' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
  });

  it('GET /api/files/download — missing file returns 404', async () => {
    const res = await request(app)
      .get('/api/files/download')
      .query({ path: join(TEST_REPO, 'gone.txt') })
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('GET /api/files/download — directory returns 400', async () => {
    const res = await request(app)
      .get('/api/files/download')
      .query({ path: join(TEST_REPO, 'subdir') })
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });
});

// --- Inbox Routes ---

describe('inbox routes', () => {
  it('GET /api/inbox — returns inbox items', async () => {
    const res = await request(app).get('/api/inbox').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('filename');
    expect(res.body[0]).toHaveProperty('agent');
    expect(res.body[0]).toHaveProperty('title');
  });

  it('GET /api/inbox — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/inbox');
    expect(res.status).toBe(401);
  });

  it('GET /api/inbox/:filename — returns full item content', async () => {
    const res = await request(app)
      .get('/api/inbox/20260403_154149_01_troubadour.md')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(res.body.content).toContain('Connection: okrs/');
  });

  it('GET /api/inbox/:filename — nonexistent returns 404', async () => {
    const res = await request(app).get('/api/inbox/nonexistent.md').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('POST /api/inbox/:filename/approve — moves to archive', async () => {
    // Create a fresh item for this test
    writeFileSync(join(INBOX_DIR, '20260401_000000_01_test.md'), SAMPLE_INBOX_ITEM);
    const res = await request(app)
      .post('/api/inbox/20260401_000000_01_test.md/approve')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /api/inbox/:filename/approve — nonexistent returns 404', async () => {
    const res = await request(app)
      .post('/api/inbox/nonexistent.md/approve')
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/inbox/:filename — discards item', async () => {
    writeFileSync(join(INBOX_DIR, '20260402_000000_01_discard.md'), SAMPLE_INBOX_ITEM);
    const res = await request(app)
      .delete('/api/inbox/20260402_000000_01_discard.md')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('DELETE /api/inbox/:filename — nonexistent returns 404', async () => {
    const res = await request(app).delete('/api/inbox/nonexistent.md').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });
});

// --- Skills Routes ---

describe('skills routes', () => {
  it('GET /api/skills — returns array of skills', async () => {
    const res = await request(app).get('/api/skills').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/skills — defaults to BASE_REPO when cwd omitted', async () => {
    const res = await request(app).get('/api/skills').set('Cookie', authCookie);
    expect(res.status).toBe(200);
  });

  it('GET /api/skills — rejects cwd outside allowed paths', async () => {
    const res = await request(app)
      .get('/api/skills')
      .query({ cwd: '/etc' })
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
  });

  it('GET /api/skills — accepts valid cwd', async () => {
    const res = await request(app)
      .get('/api/skills')
      .query({ cwd: TEST_REPO })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/skills — unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(401);
  });

  it('GET /api/skills — skill entries have expected shape', async () => {
    // Invalidate the cached registry so newly written skills are discovered
    const { invalidateSkillRegistries } = await import('../app.js');
    invalidateSkillRegistries();

    // Create a skill in the test repo
    const skillsDir = join(TEST_REPO, '.mitzo', 'skills', 'test-skill');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'SKILL.md'),
      '---\ndescription: "A test skill"\nallowed-tools:\n  - Read\n  - Glob\n---\n\nDo the thing with $ARGUMENTS',
    );

    const res = await request(app)
      .get('/api/skills')
      .query({ cwd: TEST_REPO })
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    const skill = res.body.find((s: { name: string }) => s.name === 'test-skill');
    expect(skill).toBeDefined();
    expect(skill.description).toBe('A test skill');
    expect(skill.scope).toBe('repo');
    expect(skill.allowedTools).toEqual(['Read', 'Glob']);
    // filePath should NOT be exposed to the client
    expect(skill.filePath).toBeUndefined();
  });

  describe('POST /api/sessions/suspend', () => {
    it('returns 204 and calls registry.suspend for valid request', async () => {
      const res = await request(app)
        .post('/api/sessions/suspend')
        .set('Cookie', authCookie)
        .send({ connectionId: 'conn-abc', sessions: [{ sessionId: 's1', lastSeq: 5 }] });
      expect(res.status).toBe(204);

      const { registry } = (await import('../chat.js')) as unknown as {
        registry: { suspend: ReturnType<typeof vi.fn> };
      };
      expect(registry.suspend).toHaveBeenCalledWith('conn-abc:s1', 5);
    });

    it('returns 400 when connectionId is missing', async () => {
      const res = await request(app)
        .post('/api/sessions/suspend')
        .set('Cookie', authCookie)
        .send({ sessions: [{ sessionId: 's1', lastSeq: 0 }] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when sessions array is empty', async () => {
      const res = await request(app)
        .post('/api/sessions/suspend')
        .set('Cookie', authCookie)
        .send({ connectionId: 'conn-abc', sessions: [] });
      expect(res.status).toBe(400);
    });

    it('skips sessions not owned by the connectionId', async () => {
      const { registry } = (await import('../chat.js')) as unknown as {
        registry: { suspend: ReturnType<typeof vi.fn> };
      };
      registry.suspend.mockClear();

      const res = await request(app)
        .post('/api/sessions/suspend')
        .set('Cookie', authCookie)
        .send({ connectionId: 'conn-other', sessions: [{ sessionId: 's1', lastSeq: 0 }] });
      expect(res.status).toBe(204);
      expect(registry.suspend).not.toHaveBeenCalled();
    });

    it('authenticates via cookie (sendBeacon sends cookies automatically)', async () => {
      const res = await request(app)
        .post('/api/sessions/suspend')
        .set('Cookie', authCookie)
        .send({ connectionId: 'conn-abc', sessions: [{ sessionId: 's1', lastSeq: 0 }] });
      expect(res.status).toBe(204);
    });
  });
});
