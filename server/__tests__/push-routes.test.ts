import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-push-test-${process.pid}`);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-push-test-${process.pid}`);
  return {
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn(),
    hideSession: vi.fn(),
    clearHiddenSessions: vi.fn(),
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

let app: Express;
let authCookie: string;

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  mkdirSync(join(TEST_REPO, '.mitzo'), { recursive: true });
  process.env.BASE_REPO = TEST_REPO;

  const mod = await import('../app.js');
  app = mod.app;

  // Login to get auth cookie
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  const cookies = loginRes.headers['set-cookie'];
  authCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  rmSync(TEST_REPO, { recursive: true, force: true });
});

describe('POST /api/push/register', () => {
  it('registers a device token', async () => {
    const res = await request(app)
      .post('/api/push/register')
      .set('Cookie', authCookie)
      .send({ token: 'device-token-abc123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects missing token', async () => {
    const res = await request(app).post('/api/push/register').set('Cookie', authCookie).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('token is required');
  });

  it('rejects non-string token', async () => {
    const res = await request(app)
      .post('/api/push/register')
      .set('Cookie', authCookie)
      .send({ token: 12345 });

    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/push/register')
      .send({ token: 'device-token-abc123' });

    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/push/register', () => {
  it('removes a registered device token', async () => {
    // Register first
    await request(app)
      .post('/api/push/register')
      .set('Cookie', authCookie)
      .send({ token: 'token-to-remove' });

    const res = await request(app)
      .delete('/api/push/register')
      .set('Cookie', authCookie)
      .send({ token: 'token-to-remove' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 200 even for non-existent token (idempotent)', async () => {
    const res = await request(app)
      .delete('/api/push/register')
      .set('Cookie', authCookie)
      .send({ token: 'nonexistent-token' });

    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app).delete('/api/push/register').send({ token: 'some-token' });

    expect(res.status).toBe(401);
  });
});
