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
    getSessions: vi.fn().mockResolvedValue([{ id: 's1', summary: 'Test', lastModified: 1 }]),
    getMessages: vi.fn().mockResolvedValue([{ messageId: 'm1', role: 'assistant', blocks: [] }]),
    renameSessionById: vi.fn().mockResolvedValue(undefined),
    hideSession: vi.fn(),
    clearHiddenSessions: vi.fn(),
    BASE_REPO: repo,
    repoConfig: {
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
    },
    getMcpServerNames: vi.fn().mockReturnValue(['test-mcp']),
    AVAILABLE_MODELS: [{ id: 'test-model', label: 'Test', desc: 'Test model' }],
    registry: { get: vi.fn() },
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

import { hideSession, clearHiddenSessions, renameSessionById } from '../chat.js';
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
  vi.mocked(clearHiddenSessions).mockClear();
});

// --- Auth Routes ---

describe('auth routes', () => {
  it('POST /api/auth/login — correct passphrase returns 200 + cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
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
  it('GET /api/sessions — authenticated returns array', async () => {
    const res = await request(app).get('/api/sessions').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
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

  it('DELETE /api/sessions — clears hidden sessions', async () => {
    const res = await request(app).delete('/api/sessions').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(clearHiddenSessions).toHaveBeenCalled();
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

  it('GET /api/config — returns config', async () => {
    const res = await request(app).get('/api/config').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('repoPath');
    expect(res.body).toHaveProperty('mcpServers');
    expect(res.body).toHaveProperty('quickActions');
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
