import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-review-app-test-${process.pid}`);

const mockSendToChat = vi.fn().mockResolvedValue(true);
const mockFindBySessionId = vi.fn().mockReturnValue(null);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-review-app-test-${process.pid}`);
  return {
    broadcastDurableSymposiumEvent: vi.fn(),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn(),
    hideSession: vi.fn(),
    hideAllSessions: vi.fn(),
    sendToChat: (...args: unknown[]) => mockSendToChat(...args),
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
      findBySessionId: (...args: unknown[]) => mockFindBySessionId(...args),
    },
    setTaskStore: vi.fn(),
    eventStore: {
      append: vi.fn(),
      getEventsAfter: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue({ id: 'session', sessionType: 'symposium' }),
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

describe('production review route initialization', () => {
  it('mounts an authenticated durable review view with a truthful native capability state', async () => {
    const result = await request(app)
      .get('/api/sessions/session/symposium/reviews')
      .set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ available: false, workflows: [] });
  });
  it('requires authentication', async () => {
    expect((await request(app).get('/api/sessions/session/symposium/reviews')).status).toBe(401);
  });
});
