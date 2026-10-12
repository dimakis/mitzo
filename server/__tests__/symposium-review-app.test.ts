import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';
import request from 'supertest';
import { mkdirSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(realpathSync(tmpdir()), `mitzo-review-app-test-${process.pid}`);

const mockGetMessages = vi.fn().mockResolvedValue([]);
const mockGetTranscript = vi
  .fn()
  .mockResolvedValue({ messages: [], current: null, currents: [], cursor: 0 });
const mockGetReconnect = vi.fn().mockReturnValue({ messages: [], current: null, currents: [] });
const mockSendToChat = vi.fn().mockResolvedValue(true);
const mockFindBySessionId = vi.fn().mockReturnValue(null);

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { realpathSync: prealpath } = require('fs');
  const repo = pjoin(prealpath(ptmpdir()), `mitzo-review-app-test-${process.pid}`);
  return {
    broadcastDurableSymposiumEvent: vi.fn(),
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: (...args: unknown[]) => mockGetMessages(...args),
    getSessionTranscript: (...args: unknown[]) => mockGetTranscript(...args),
    getReconnectTranscript: (...args: unknown[]) => mockGetReconnect(...args),
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
let server: Server;
let authCookie: string;

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  mkdirSync(join(TEST_REPO, '.mitzo'), { recursive: true, mode: 0o700 });
  vi.stubEnv('BASE_REPO', TEST_REPO);
  vi.stubEnv('REPO_PATH', TEST_REPO);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(TEST_REPO, 'private-codex'));

  const mod = await import('../app.js');
  app = mod.app;
  // Native session facts moved to the actual lazy semantic service; the
  // ordinary chat mock cannot supply a retained native session anymore.
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline fixture',
    provider: 'openai-codex' as const,
    profileRevision: 'fixture',
    model: 'offline-model',
  };
  const facts = mod.getSymposiumBootstrapDependencies().facts;
  facts.createSymposiumSession({
    sessionId: 'session',
    idempotencyKey: 'review-fixture',
    fingerprint: 'review-fixture',
    summary: 'Unactivated review fixture',
    binding,
    config: {
      version: 2,
      revision: 1,
      state: 'draft',
      anchorSeatId: 'primary',
      activeSeatCap: 1,
      seats: [
        {
          id: 'primary',
          name: 'Fixture',
          role: 'coder',
          model: binding.model,
          accountBinding: binding,
          systemPrompt: 'Offline fixture',
          color: '#335577',
        },
      ],
      turnRules: { mode: 'directed', maxTurns: 1 },
      interceptMode: 'manual',
    },
    profileSelections: {},
  });
  expect(facts.getSession('session')?.sessionType).toBe('symposium');
  server = await listenOnLoopback(app);

  // Login to get auth cookie
  const loginRes = await request(server)
    .post('/api/auth/login')
    .send({ passphrase: process.env.AUTH_PASSPHRASE });
  const cookies = loginRes.headers['set-cookie'];
  authCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(async () => {
  if (server) await closeTestServer(server);
  vi.unstubAllEnvs();
  rmSync(TEST_REPO, { recursive: true, force: true });
});

describe('production review route initialization', () => {
  it('mounts an authenticated durable review view with a truthful native capability state', async () => {
    const result = await request(server)
      .get('/api/sessions/session/symposium/reviews')
      .set('Cookie', authCookie);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      available: false,
      workflows: [],
      criterionChecks: [],
      stopAvailable: false,
      cleanupAvailable: false,
      applicationRun: {
        available: false,
        initialArtifact: null,
        reason: 'Trusted initial artifact unavailable',
      },
    });
  });
  it('requires authentication', async () => {
    expect((await request(server).get('/api/sessions/session/symposium/reviews')).status).toBe(401);
  });
});

describe('production messages replay error containment', () => {
  it.each(['', '?transcript=1', '?throughSeq=7'])(
    'returns a safe error and keeps serving after replay failure %s',
    async (query) => {
      const secret = 'private transcript must not escape';
      mockGetMessages.mockRejectedValueOnce(new Error(secret));
      mockGetTranscript.mockRejectedValueOnce(new Error(secret));
      mockGetReconnect.mockImplementationOnce(() => {
        throw new Error(secret);
      });
      try {
        const failed = await request(server)
          .get('/api/sessions/session/messages' + query)
          .set('Cookie', authCookie)
          .timeout(1000);
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({ error: 'Session transcript unavailable' });
        expect(JSON.stringify(failed.body)).not.toContain(secret);
      } finally {
        mockGetMessages.mockReset().mockResolvedValue([]);
        mockGetTranscript
          .mockReset()
          .mockResolvedValue({ messages: [], current: null, currents: [], cursor: 0 });
        mockGetReconnect.mockReset().mockReturnValue({ messages: [], current: null, currents: [] });
      }
      const next = await request(server)
        .get('/api/sessions/session/messages' + query)
        .set('Cookie', authCookie);
      expect(next.status).toBe(200);
    },
  );
});
