import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import request from 'supertest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-cors-test-${process.pid}`);

// Set CORS_ALLOWED_ORIGINS before app module loads
process.env.CORS_ALLOWED_ORIGINS = 'capacitor://localhost,https://custom.example.com';

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-cors-test-${process.pid}`);
  return {
    broadcastDurableSymposiumEvent: vi.fn(),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn(),
    hideSession: vi.fn(),
    hideAllSessions: vi.fn(),
    BASE_REPO: repo,
    getRepoConfig: vi.fn(() => ({
      quickActions: [],
      allowedPaths: [],
      roots: [],
      resolvedVenvPaths: [],
      toolTierOverrides: {},
      inboxPath: '',
      resolvedInboxPath: '',
      repos: {},
      contextBlocks: {},
    })),
    getMcpServerNames: vi.fn().mockReturnValue([]),
    AVAILABLE_MODELS: [],
    registry: {
      get: vi.fn(),
      getActiveSessions: vi.fn().mockReturnValue([]),
    },
    setTaskStore: vi.fn(),
    eventStore: {
      append: vi.fn(),
      getEventsAfter: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
    },
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

let server: Server;

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  const mod = await import('../app.js');
  server = await listenOnLoopback(mod.app);
});

afterAll(async () => {
  if (server) await closeTestServer(server);
});

describe('CORS middleware', () => {
  it('adds CORS headers for allowed origin', async () => {
    const res = await request(server).get('/api/version').set('Origin', 'capacitor://localhost');
    expect(res.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('exposes the original download filename to the authenticated iOS webview', async () => {
    const file = join(TEST_REPO, 'Résumé.docx');
    writeFileSync(file, Buffer.from([0, 255, 128, 65]));
    const { login } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);
    const res = await request(server)
      .get('/api/files/download')
      .query({ path: file })
      .set('Origin', 'capacitor://localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9.docx");
    expect(res.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });

  it('adds CORS headers for second allowed origin', async () => {
    const res = await request(server)
      .get('/api/version')
      .set('Origin', 'https://custom.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://custom.example.com');
  });

  it('does not add CORS headers for disallowed origin', async () => {
    const res = await request(server).get('/api/version').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('allows the capability route transport identity header in OPTIONS preflight', async () => {
    const res = await request(server)
      .options('/api/capability-operations')
      .set('Origin', 'capacitor://localhost');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-headers']).toContain('X-Connection-ID');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('returns 204 for OPTIONS from disallowed origin but without CORS headers', async () => {
    const res = await request(server)
      .options('/api/version')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});

describe('WS query-param auth (verifyToken)', () => {
  it('verifyToken accepts valid JWT', async () => {
    const { login, verifyToken } = await import('../auth.js');
    const token = await login(process.env.AUTH_PASSPHRASE!);
    expect(token).toBeTruthy();
    expect(await verifyToken(token!)).toBe(true);
  });

  it('verifyToken rejects empty string', async () => {
    const { verifyToken } = await import('../auth.js');
    expect(await verifyToken('')).toBe(false);
  });

  it('verifyToken rejects garbage token', async () => {
    const { verifyToken } = await import('../auth.js');
    expect(await verifyToken('not.a.jwt')).toBe(false);
  });

  it('login response includes token for WS query-param auth', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ passphrase: process.env.AUTH_PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
    // Token should be a valid JWT (3 dot-separated base64 segments)
    expect(res.body.token.split('.').length).toBe(3);
  });
});
