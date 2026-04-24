import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_REPO = join(tmpdir(), `mitzo-suspend-test-${process.pid}`);

const mockSuspend = vi.fn();

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: ptmpdir } = require('os');
  const repo = pjoin(ptmpdir(), `mitzo-suspend-test-${process.pid}`);
  return {
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
      findBySessionId: vi.fn((sid: string) => {
        if (sid === 'sess-known') {
          return { clientId: 'conn-owner:sess-known', session: { sessionId: 'sess-known' } };
        }
        return null;
      }),
      suspend: mockSuspend,
    },
    setTaskStore: vi.fn(),
    eventStore: {
      append: vi.fn(),
      getEventsAfter: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
    },
    isIsolationEnabled: vi.fn().mockReturnValue(false),
    generateWtId: vi.fn().mockReturnValue('wt-test'),
    getSessionsCached: vi.fn().mockReturnValue({ sessions: [], hasMore: false }),
    reconcileSessionsBackground: vi.fn(),
  };
});

let app: Express;

beforeAll(async () => {
  mkdirSync(TEST_REPO, { recursive: true });
  mkdirSync(join(TEST_REPO, '.mitzo'), { recursive: true });
  process.env.BASE_REPO = TEST_REPO;

  const mod = await import('../app.js');
  app = mod.app;
});

afterAll(() => {
  rmSync(TEST_REPO, { recursive: true, force: true });
});

describe('POST /api/sessions/suspend', () => {
  it('returns 204 and calls registry.suspend for valid request', async () => {
    mockSuspend.mockClear();

    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({
        connectionId: 'conn-owner',
        sessions: [{ sessionId: 'sess-known', lastSeq: 42 }],
      });

    expect(res.status).toBe(204);
    expect(mockSuspend).toHaveBeenCalledWith('conn-owner:sess-known', 42);
  });

  it('does not require authentication (sendBeacon cannot set headers)', async () => {
    // No auth cookie — should still work
    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({
        connectionId: 'conn-owner',
        sessions: [{ sessionId: 'sess-known', lastSeq: 0 }],
      });

    expect(res.status).toBe(204);
  });

  it('rejects missing connectionId', async () => {
    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({ sessions: [{ sessionId: 'sess-known', lastSeq: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('connectionId is required');
  });

  it('rejects missing sessions array', async () => {
    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({ connectionId: 'conn-owner' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sessions array is required');
  });

  it('rejects empty sessions array', async () => {
    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({ connectionId: 'conn-owner', sessions: [] });

    expect(res.status).toBe(400);
  });

  it('skips unknown sessions without error', async () => {
    mockSuspend.mockClear();

    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({
        connectionId: 'conn-owner',
        sessions: [{ sessionId: 'sess-unknown', lastSeq: 0 }],
      });

    expect(res.status).toBe(204);
    expect(mockSuspend).not.toHaveBeenCalled();
  });

  it('rejects suspend from non-owner connectionId', async () => {
    mockSuspend.mockClear();

    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({
        connectionId: 'conn-attacker',
        sessions: [{ sessionId: 'sess-known', lastSeq: 0 }],
      });

    expect(res.status).toBe(204);
    expect(mockSuspend).not.toHaveBeenCalled();
  });

  it('handles multiple sessions in one request', async () => {
    // Re-mock findBySessionId to return both sessions
    const { registry } = await import('../chat.js');
    (registry.findBySessionId as ReturnType<typeof vi.fn>).mockImplementation((sid: string) => {
      if (sid === 'sess-a' || sid === 'sess-b') {
        return { clientId: `conn-owner:${sid}`, session: { sessionId: sid } };
      }
      return null;
    });
    mockSuspend.mockClear();

    const res = await request(app)
      .post('/api/sessions/suspend')
      .send({
        connectionId: 'conn-owner',
        sessions: [
          { sessionId: 'sess-a', lastSeq: 10 },
          { sessionId: 'sess-b', lastSeq: 20 },
        ],
      });

    expect(res.status).toBe(204);
    expect(mockSuspend).toHaveBeenCalledTimes(2);
    expect(mockSuspend).toHaveBeenCalledWith('conn-owner:sess-a', 10);
    expect(mockSuspend).toHaveBeenCalledWith('conn-owner:sess-b', 20);
  });
});
