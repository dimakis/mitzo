import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventStore } from '../event-store.js';

const catalog = vi.hoisted(() => ({ refresh: vi.fn(async () => {}), catalog: () => [] }));
vi.mock('../account-profiles.js', async (original) => ({
  ...(await original<object>()),
  loadAccountProfiles: () => ({ ...catalog, privateCodexRoots: () => [] }),
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
