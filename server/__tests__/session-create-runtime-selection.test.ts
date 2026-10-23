import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { closeTestServer, listenOnLoopback } from './loopback-test-server.js';

const effects = vi.hoisted(() => ({
  credential: vi.fn(async () => 'SYNTHETIC_KEY'),
  startChat: vi.fn(),
  worktrees: vi.fn(),
  isolation: vi.fn(() => true),
  config: vi.fn(() => ({ repos: {} })),
  id: vi.fn(() => 'fixture-session'),
  upsert: vi.fn(),
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: 'offline-session-create-token',
  isValidInternalToken: (token: unknown) => token === 'offline-session-create-token',
  isValidSignalCallbackToken: vi.fn(() => false),
  createSignalCallbackToken: vi.fn(),
  revokeSignalCallbackToken: vi.fn(),
}));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<typeof import('../credentials.js')>()),
  credentials: { resolve: effects.credential },
}));
vi.mock('../chat.js', async () => {
  const { createRoutesRuntimeLedgerFixture } = await import('./fixtures/routes-runtime-ledger.js');
  return {
    BASE_REPO: process.env.REPO_PATH,
    AVAILABLE_MODELS: [],
    startChat: effects.startChat,
    setTaskStore: vi.fn(),
    hideSession: vi.fn(),
    hideAllSessions: vi.fn(),
    renameSessionById: vi.fn(),
    stopChat: vi.fn(),
    sendToChat: vi.fn(),
    getRepoConfig: effects.config,
    isIsolationEnabled: effects.isolation,
    generateWtId: effects.id,
    getMcpServerNames: vi.fn(() => []),
    getConnectionRegistry: vi.fn(() => undefined),
    getSessionsCached: vi.fn(() => ({ sessions: [], hasMore: false })),
    reconcileSessionsBackground: vi.fn(),
    broadcastDurableSymposiumEvent: vi.fn(),
    registry: {
      get: vi.fn(),
      entries: vi.fn(function* () {}),
      dispose: vi.fn(),
      getActiveSessions: vi.fn(() => []),
      findBySessionId: vi.fn(() => null),
    },
    eventStore: {
      ...createRoutesRuntimeLedgerFixture(),
      getSession: vi.fn(() => null),
      upsertSession: effects.upsert,
      close: vi.fn(),
    },
  };
});
vi.mock('../worktree.js', () => ({
  createSessionWorktrees: effects.worktrees,
  createWorktree: vi.fn(),
  listWorktrees: vi.fn(() => []),
}));

let server: Server;
let closeApplication: (() => Promise<void>) | undefined;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-session-selection-'));
  mkdirSync(join(root, '.mitzo'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '');
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '');
  const { app, closeIdleApplicationResources } = await import('../app.js');
  closeApplication = closeIdleApplicationResources;
  server = await listenOnLoopback(app);
});
afterAll(async () => {
  if (server) await closeTestServer(server);
  await closeApplication?.();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  effects.isolation.mockReturnValue(true);
  effects.worktrees.mockReturnValue({ fixture: '/offline/worktree' });
  effects.startChat.mockImplementation(async () => {
    // Represents the first credential/provider effect if the old branch is reached.
    await effects.credential();
  });
});

it.each([
  { source: 'mitzo', initialPrompt: 'Investigate the issue' },
  { source: 'mitzo', initialPrompt: 'Investigate', mode: 'invalid' },
  { source: 'mitzo', initialPrompt: '' },
  { source: 'mitzo', initialPrompt: null },
  { source: 'mitzo', initialPrompt: 42 },
  {
    source: 'mitzo',
    initialPrompt: 'Investigate',
    accountId: 'work',
    runtime: { targetId: 'local' },
  },
])('rejects an unselected prompt before isolation, allocation or credentials: %j', async (body) => {
  const response = await request(server)
    .post('/api/sessions')
    .set('X-Internal-Token', 'offline-session-create-token')
    .send(body);
  expect(response.status).toBe(409);
  expect(response.body).toEqual({
    error: 'missing_runtime_selection',
    message:
      'Select an account, model and execution target through the ordinary chat or Telos workflow before starting a session.',
  });
  expect(effects.isolation).not.toHaveBeenCalled();
  expect(effects.config).not.toHaveBeenCalled();
  expect(effects.id).not.toHaveBeenCalled();
  expect(effects.worktrees).not.toHaveBeenCalled();
  expect(effects.upsert).not.toHaveBeenCalled();
  expect(effects.startChat).not.toHaveBeenCalled();
  expect(effects.credential).not.toHaveBeenCalled();
});
it('rejects unselected prompts even when isolation is disabled', async () => {
  effects.isolation.mockReturnValue(false);
  const response = await request(server)
    .post('/api/sessions')
    .set('X-Internal-Token', 'offline-session-create-token')
    .send({ source: 'mitzo', initialPrompt: 'Investigate' });
  expect(response.status).toBe(409);
  expect(effects.isolation).not.toHaveBeenCalled();
});
it.each(['cursor', 'claude', 'mitzo'])(
  'preserves no-prompt %s worktree registration',
  async (source) => {
    const response = await request(server)
      .post('/api/sessions')
      .set('X-Internal-Token', 'offline-session-create-token')
      .send({ source });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      sessionId: 'fixture-session',
      worktrees: { fixture: '/offline/worktree' },
      isolation: true,
      headless: false,
    });
    expect(effects.worktrees).toHaveBeenCalledExactlyOnceWith(
      'fixture-session',
      root,
      {},
      { prefix: source === 'cursor' ? '.cursor' : '.claude' },
    );
    expect(effects.startChat).not.toHaveBeenCalled();
    expect(effects.credential).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  'preserves no-prompt legacy fallback with isolation=%s',
  async (isolation) => {
    effects.isolation.mockReturnValue(isolation);
    const response = await request(server)
      .post('/api/sessions')
      .set('X-Internal-Token', 'offline-session-create-token')
      .send({ source: 'claude', mode: 'old-hook-value' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      isolation
        ? {
            sessionId: 'fixture-session',
            worktrees: { fixture: '/offline/worktree' },
            isolation: true,
            headless: false,
          }
        : { sessionId: null, worktrees: null, isolation: false },
    );
    expect(effects.worktrees).toHaveBeenCalledTimes(isolation ? 1 : 0);
    expect(effects.startChat).not.toHaveBeenCalled();
    expect(effects.credential).not.toHaveBeenCalled();
  },
);
it('still requires internal authentication before returning selection guidance', async () => {
  const response = await request(server)
    .post('/api/sessions')
    .send({ source: 'mitzo', initialPrompt: 'Investigate' });
  expect(response.status).toBe(401);
  expect(effects.worktrees).not.toHaveBeenCalled();
  expect(effects.startChat).not.toHaveBeenCalled();
});
