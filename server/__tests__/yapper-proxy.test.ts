// Tests for the Yapper proxy routes mounted in app.ts.
// The proxy forwards /api/yapper/* → http://localhost:8700/* (HTTP)
// and the upgrade handler routes /api/yapper-ws/* → ws://localhost:8700/* (WS).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createServer } from 'http';
import type { Server } from 'http';
import { WebSocketServer } from 'ws';

// --- Mocks required by app.ts ---

vi.mock('../chat.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('os');
  const repo = join(tmpdir(), `mitzo-yapper-test-${process.pid}`);
  return {
    getSessions: vi.fn().mockResolvedValue({ sessions: [], hasMore: false }),
    getMessages: vi.fn().mockResolvedValue([]),
    renameSessionById: vi.fn().mockResolvedValue(undefined),
    hideSession: vi.fn(),
    clearHiddenSessions: vi.fn(),
    BASE_REPO: repo,
    repoConfig: {
      quickActions: [],
      allowedPaths: [],
      roots: [],
      resolvedVenvPaths: [],
      toolTierOverrides: {},
      inboxPath: null,
      resolvedInboxPath: null,
      repos: {},
      contextBlocks: {},
    },
    getMcpServerNames: vi.fn().mockReturnValue([]),
    AVAILABLE_MODELS: [],
    registry: { get: vi.fn() },
    eventStore: { append: vi.fn(), getEventsAfter: vi.fn().mockReturnValue([]) },
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

// A minimal fake Yapper HTTP + WS server for testing
let fakeYapper: Server;
let fakeYapperWss: WebSocketServer;
const FAKE_YAPPER_PORT = 18700;

beforeAll(async () => {
  // Spin up a fake Yapper server on port 18700
  fakeYapper = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/v1/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          voices: [{ id: 'af_heart', name: 'Heart', language: 'en', gender: 'f' }],
        }),
      );
      return;
    }
    if (req.url === '/v1/synthesize' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ echoed: parsed }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  fakeYapperWss = new WebSocketServer({ noServer: true });
  fakeYapper.on('upgrade', (req, socket, head) => {
    fakeYapperWss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'hello', from: 'yapper' }));
      ws.on('message', (msg) => {
        ws.send(msg); // echo
      });
    });
  });

  await new Promise<void>((resolve) => fakeYapper.listen(FAKE_YAPPER_PORT, resolve));

  // Override YAPPER_PROXY_TARGET for tests
  process.env.YAPPER_PROXY_TARGET = `http://localhost:${FAKE_YAPPER_PORT}`;

  const mod = await import('../app.js');
  app = mod.app;
});

// --- HTTP proxy tests ---

describe('GET /api/yapper/health', () => {
  it('proxies to the Yapper health endpoint and returns 200', async () => {
    const res = await request(app).get('/api/yapper/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('strips /api/yapper prefix — voices endpoint works', async () => {
    const res = await request(app).get('/api/yapper/v1/voices');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ voices: expect.any(Array) });
  });

  it('returns 404 for unknown Yapper paths', async () => {
    const res = await request(app).get('/api/yapper/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('/api/yapper proxy — mounted before authMiddleware', () => {
  it('does NOT require auth cookie (proxy is public — Yapper handles auth if any)', async () => {
    // No cookie sent — should still proxy, not 401
    const res = await request(app).get('/api/yapper/health');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/yapper/v1/synthesize', () => {
  it('forwards POST body to Yapper without express.json() consuming it', async () => {
    const payload = { text: 'Hello world', voice: 'af_heart' };
    const res = await request(app)
      .post('/api/yapper/v1/synthesize')
      .send(payload)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ echoed: payload });
  });
});
