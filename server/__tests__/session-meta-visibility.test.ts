import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventStore } from '../event-store.js';

const catalog = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), catalog: () => [] }));
const native = vi.hoisted(() => ({ hasConversation: vi.fn(() => false) }));
vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => ({ ...catalog, privateCodexRoots: () => [] }),
}));
vi.mock('../codex-chat-session.js', async (original) => ({
  ...(await original<object>()),
  readCodexQueue: () => undefined,
  getCodexConversationStore: () => native,
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  operatorAuthMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: '0'.repeat(64),
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
  createSignalCallbackToken: vi.fn(),
  revokeSignalCallbackToken: vi.fn(),
}));
let app: Express;
let store: EventStore;
let root: string;

it.each([false, true, 'unavailable'] as const)(
  'projects native presence for pre-runtime OpenAI metadata (%s) without inventing a runtime',
  async (presence) => {
    const id = `pre-runtime-${presence}`;
    store.upsertSession({
      sessionId: id,
      cwd: '/sandbox/workspaces/mgmt',
      accountBinding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'offline-fixture',
        profileRevision: 'fixture',
      },
    });
    if (presence === 'unavailable')
      native.hasConversation.mockImplementationOnce(() => {
        throw Error('Native read unavailable');
      });
    else native.hasConversation.mockReturnValueOnce(presence);
    const response = await request(app).get(`/api/sessions/${id}/meta`);
    expect(response.status).toBe(200);
    if (presence === 'unavailable')
      expect(response.body).not.toHaveProperty('hasNativeCodexConversation');
    else expect(response.body.hasNativeCodexConversation).toBe(presence);
    expect(store.getSessionRuntimeBinding(id)).toBeNull();
  },
);
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-meta-visibility-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('TELOS_DB_PATH', join(root, 'todo.db'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No network calls in metadata fixture');
    }),
  );
  const loaded = await import('../app.js');
  app = loaded.app;
  store = (await import('../chat.js')).eventStore;
});
afterAll(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('reports authoritative visibility while preserving hidden session metadata and missing 404', async () => {
  store.upsertSession({ sessionId: 'retained-briefing', summary: 'Report discussion' });
  const visible = await request(app).get('/api/sessions/retained-briefing/meta');
  expect(visible.status).toBe(200);
  expect(visible.body).toMatchObject({ sessionId: 'retained-briefing', isHidden: false });
  expect((await request(app).delete('/api/sessions/retained-briefing')).status).toBe(200);
  const hidden = await request(app).get('/api/sessions/retained-briefing/meta');
  expect(hidden.status).toBe(200);
  expect(hidden.body).toMatchObject({ sessionId: 'retained-briefing', isHidden: true });
  expect(store.getSession('retained-briefing')?.isHidden).toBe(true);
  expect((await request(app).get('/api/sessions/missing/meta')).status).toBe(404);
});
it('projects the persisted conversation creation time without changing it on metadata reads or later updates', async () => {
  const createdAt = Date.parse('2026-10-16T10:00:00Z');
  store.upsertSession({
    sessionId: 'chooser-created',
    summary: 'Original conversation',
    createdAt,
  });
  const before = store.getSession('chooser-created');
  const first = await request(app).get('/api/sessions/chooser-created/meta');
  expect(first.status).toBe(200);
  expect(first.body.createdAt).toBe(createdAt);
  expect(store.getSession('chooser-created')).toEqual(before);
  store.upsertSession({ sessionId: 'chooser-created', summary: 'Renamed later' });
  expect((await request(app).get('/api/sessions/chooser-created/meta')).body.createdAt).toBe(
    createdAt,
  );
});
it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 8640000000000001, '2026-10-16'])(
  'omits an absent or invalid creation timestamp (%s) while preserving metadata',
  async (createdAt) => {
    store.upsertSession({ sessionId: 'chooser-invalid-created', summary: 'Retained' });
    const original = store.getSession.bind(store);
    const read = vi.spyOn(store, 'getSession').mockImplementation((id) => {
      const meta = original(id);
      return meta && id === 'chooser-invalid-created'
        ? ({ ...meta, createdAt } as typeof meta)
        : meta;
    });
    try {
      const response = await request(app).get('/api/sessions/chooser-invalid-created/meta');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ sessionId: 'chooser-invalid-created' });
      expect(response.body).not.toHaveProperty('createdAt');
    } finally {
      read.mockRestore();
    }
  },
);
it('observes deletion during optional catalog refresh before returning reuse eligibility', async () => {
  store.upsertSession({
    sessionId: 'during-refresh',
    accountBinding: {
      accountId: 'work',
      accountLabel: 'Work',
      provider: 'openai',
      model: 'luna',
      profileRevision: 'fixture',
    },
  });
  catalog.refresh.mockImplementationOnce(async () => {
    store.hideSession('during-refresh');
  });
  const response = await request(app).get('/api/sessions/during-refresh/meta');
  expect(response.status).toBe(200);
  expect(response.body.isHidden).toBe(true);
});

it('retains the last admitted model and thinking when optional account refresh fails on reopen', async () => {
  const account = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as const,
    model: 'first',
    profileRevision: 'fixture',
  };
  const meta = {
    sessionId: 'ordinary-retained-settings',
    cwd: '/offline/retained-task',
    repositoryWorkspaceId: 'workspace',
    accountBinding: account,
  };
  const runtime = {
    version: 2,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
  };
  const selection = {
    version: 1 as const,
    model: 'first',
    thinking: 'low',
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
  };
  store.admitOrdinaryLocalCommand(meta, runtime, {
    clientMsgId: 'settings-first',
    requestFingerprint: 'first',
    selection,
    payload: { text: 'First' },
  });
  store.claimOrdinaryLocalCommandDispatch('settings-first');
  store.completeOrdinaryLocalCommand('settings-first');
  store.admitOrdinaryLocalContinuation(
    { ...meta, accountBinding: { ...account, model: 'next' } },
    runtime,
    {
      clientMsgId: 'settings-next',
      requestFingerprint: 'next',
      selection: { ...selection, model: 'next', thinking: 'high' },
      payload: { text: 'Next' },
    },
  );
  catalog.refresh.mockRejectedValueOnce(Error('Optional catalogue unreadable'));
  const response = await request(app).get(
    '/api/sessions/ordinary-retained-settings/meta?refresh=1',
  );
  expect(response.status).toBe(200);
  expect(response.body.modelSelection).toEqual({
    model: 'next',
    reasoningEffort: 'high',
    models: [],
  });
  expect(response.body.accountBinding.model).toBe('first');
  expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(runtime);
});

it('reads a pinned session’s recorded context by ID without catalog, runtime or list work', async () => {
  store.upsertSession({ sessionId: 'older-pin', summary: 'Older pin', inputTokens: 900000 });
  store.append('older-pin', 'token_update', {
    agentContext: 48000,
    sessionTotal: 900000,
    tokenLimits: { model: 'fixture', source: 'runtime', contextWindow: 200000 },
  });
  catalog.refresh.mockClear();
  const before = store.getLatestEvent('older-pin', 'token_update');
  const response = await request(app).get('/api/sessions/older-pin/context');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    sessionId: 'older-pin',
    contextUsage: {
      used: 48000,
      measuredAt: before!.createdAt,
      limits: { model: 'fixture', source: 'runtime', contextWindow: 200000, stale: false },
    },
  });
  expect(catalog.refresh).not.toHaveBeenCalled();
  expect(store.getLatestEvent('older-pin', 'token_update')).toEqual(before);
  store.upsertSession({ sessionId: 'no-measurement', inputTokens: 900000 });
  expect((await request(app).get('/api/sessions/no-measurement/context')).body).toEqual({
    sessionId: 'no-measurement',
    contextUsage: null,
  });
  store.hideSession('older-pin');
  expect((await request(app).get('/api/sessions/older-pin/context')).status).toBe(404);
  expect((await request(app).get('/api/sessions/missing/context')).status).toBe(404);
});
