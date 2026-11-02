import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventStore } from '../event-store.js';
type EffectsEligibility =
  typeof import('../retained-local-codex-effects.js').reconcilableLocalCodexCommand;

const fixture = vi.hoisted(() => ({
  auth: { id: 'original-operator', expiresAt: Date.now() + 3600000 },
  native: { hasConversation: () => false },
  eligible: vi.fn((): string | undefined => 'saved-command'),
  effectsEligible: vi.fn<EffectsEligibility>(() => undefined),
  originalEffects: undefined as EffectsEligibility | undefined,
  workspace: vi.fn(() => {
    throw Error('Repository preparation state is unavailable');
  }),
  continue: vi.fn(async () => {}),
  authorize: vi.fn(),
  queue: { paused: true, connected: false, queued: 1, interrupted: 0 },
}));
vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => ({
    refresh: async () => {},
    catalog: () => [],
    privateCodexRoots: () => [],
  }),
}));
vi.mock('../codex-chat-session.js', async (original) => ({
  ...(await original<object>()),
  readCodexQueue: () => fixture.queue,
  readCodexQueueOverview: () => ({
    queued: [{ id: 'saved-command', preview: 'Saved input' }],
    cancelledIds: [],
  }),
  getCodexConversationStore: () => fixture.native,
}));
vi.mock('../retained-local-codex-recovery.js', async (original) => ({
  ...(await original<object>()),
  recoverableLocalCodexCommand: fixture.eligible,
}));
vi.mock('../retained-local-codex-effects.js', async (original) => {
  const actual = await original<typeof import('../retained-local-codex-effects.js')>();
  fixture.originalEffects = actual.reconcilableLocalCodexCommand;
  return { ...actual, reconcilableLocalCodexCommand: fixture.effectsEligible };
});
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: fixture.workspace,
}));
vi.mock('../chat.js', async (original) => ({
  ...(await original<object>()),
  continueOwnedLocalCodexQueue: fixture.continue,
}));
vi.mock('../ordinary-codex-continuation-status.js', () => ({
  ordinaryCodexContinuationStatus: () => ({ available: false }),
}));
vi.mock('../owned-codex-queue-control.js', () => ({
  assertOwnedCodexQueueControl: fixture.authorize,
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  authMiddleware: (_req: Request, res: Response, next: NextFunction) => {
    res.locals.authSession = fixture.auth;
    next();
  },
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
const id = 'retained-work-api-local';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-local-queue-routing-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('TELOS_DB_PATH', join(root, 'todo.db'));
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'codex-private'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in offline queue routing fixture');
    }),
  );
  app = (await import('../app.js')).app;
  store = (await import('../chat.js')).eventStore;
  const account = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai' as const,
    model: 'offline-fixture',
    profileRevision: 'fixture',
  };
  store.admitOrdinaryLocalCommand(
    {
      sessionId: id,
      cwd: '/offline/retained-task',
      repositoryWorkspaceId: 'workspace',
      accountBinding: account,
    },
    {
      version: 2,
      account: { accountId: 'work', provider: 'openai', profileRevision: 'fixture' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
    },
    {
      clientMsgId: 'saved-command',
      requestFingerprint: 'offline-fingerprint',
      selection: {
        version: 1,
        model: 'offline-fixture',
        thinking: 'low',
        agent: { profileId: 'published', revision: 1 },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
      },
      payload: { text: 'Saved input' },
    },
  );
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  fixture.queue.paused = true;
  fixture.queue.connected = false;
  fixture.eligible.mockReturnValue('saved-command');
  fixture.effectsEligible.mockReturnValue(undefined);
  fixture.authorize.mockImplementation(() => {});
  fixture.continue.mockResolvedValue();
});
afterAll(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('projects local Work API Codex queue and actor-qualified saved continuation', async () => {
  const response = await request(app).get(`/api/sessions/${id}/meta`);
  expect(response.status).toBe(200);
  expect(response.body.codexQueue).toMatchObject({ ...fixture.queue, canContinue: true });
  expect(fixture.eligible).toHaveBeenCalledWith(store, fixture.native, id, fixture.auth.id);
  fixture.eligible.mockReturnValue(undefined);
  expect((await request(app).get(`/api/sessions/${id}/meta`)).body.codexQueue.canContinue).toBe(
    false,
  );
  fixture.effectsEligible.mockReturnValue('interrupted-command');
  expect((await request(app).get(`/api/sessions/${id}/meta`)).body.codexQueue.canContinue).toBe(
    true,
  );
  expect(fixture.effectsEligible).toHaveBeenCalledWith(
    store,
    fixture.native,
    id,
    fixture.auth.id,
    expect.any(Function),
  );
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  fixture.eligible.mockClear();
  fixture.effectsEligible.mockClear();
  expect((await request(app).get(`/api/sessions/${id}/meta`)).body.codexQueue.canContinue).toBe(
    false,
  );
  expect(fixture.eligible).not.toHaveBeenCalled();
  expect(fixture.effectsEligible).not.toHaveBeenCalled();
  // Keep the actual helper/factory error boundary in this HTTP projection case.
  // A missing isolated store must suppress the action without breaking metadata.
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  fixture.effectsEligible.mockImplementationOnce(fixture.originalEffects!);
  fixture.workspace.mockClear();
  const missingWorkspace = await request(app).get(`/api/sessions/${id}/meta`);
  expect(missingWorkspace.status).toBe(200);
  expect(missingWorkspace.body.codexQueue.canContinue).toBe(false);
  expect(fixture.effectsEligible).toHaveBeenCalledOnce();
  expect(fixture.workspace).toHaveBeenCalledWith(true);
  expect(fixture.continue).not.toHaveBeenCalled();
});
it('includes local Work API Codex in existing queue details route', async () => {
  const response = await request(app).get(`/api/sessions/${id}/codex-queue`);
  expect(response.status).toBe(200);
  expect(response.body.queued[0].id).toBe('saved-command');
});
it('routes explicit continue to owned local recovery with the current SSE identity', async () => {
  const response = await request(app)
    .post(`/api/sessions/${id}/codex-queue/continue`)
    .set('X-Connection-ID', 'current-signed-sse')
    .send({});
  expect(response.status).toBe(200);
  expect(fixture.authorize).toHaveBeenCalled();
  expect(fixture.continue).toHaveBeenCalledWith(id, fixture.auth, 'current-signed-sse');
});
it('rejects unauthorized queue recovery before the local consumer runs', async () => {
  fixture.authorize.mockImplementation(() => {
    throw Error('Wrong operator');
  });
  expect(
    (await request(app).post(`/api/sessions/${id}/codex-queue/continue`).send({})).status,
  ).toBe(403);
  expect(fixture.continue).not.toHaveBeenCalled();
});
it('reports consumer recovery failure rather than local dispatch success', async () => {
  fixture.continue.mockRejectedValueOnce(Error('Saved input no longer safe'));
  const response = await request(app)
    .post(`/api/sessions/${id}/codex-queue/continue`)
    .set('X-Connection-ID', 'current-signed-sse')
    .send({});
  expect(response.status).toBe(409);
  expect(fixture.continue).toHaveBeenCalledOnce();
});

it('does not offer saved recovery while a live unpaused owner is already progressing', async () => {
  fixture.queue.paused = false;
  fixture.queue.connected = true;
  const response = await request(app).get(`/api/sessions/${id}/meta`);
  expect(response.status).toBe(200);
  expect(response.body.codexQueue.canContinue).toBe(false);
  expect(fixture.eligible).not.toHaveBeenCalled();
});
