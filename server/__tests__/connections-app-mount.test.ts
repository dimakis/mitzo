import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';

vi.mock('../auth.js', () => ({
  login: vi.fn(),
  authenticateToken: vi.fn(),
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-internal-token')) return next();
    if (req.header('x-browser') === 'yes') {
      res.locals.authSession = { id: 'browser', expiresAt: Date.now() + 60_000 };
      return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
  },
  registerAuthSession: vi.fn(() => () => undefined),
  revokeAuthSession: vi.fn(),
  verifyPassphrase: (value: string) => value === 'correct',
  COOKIE_NAME: 'cc_auth',
  MAX_AGE_HOURS: 24,
}));

describe('Connections app mount', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it('uses the local 2kb parser before the app-wide 10mb parser and rejects internal auth', async () => {
    const { app, setConnectionsRuntime } = await import('../app.js');
    const directory = mkdtempSync(join(tmpdir(), 'connections-app-'));
    directories.push(directory);
    const store = new ConnectionStore(join(directory, 'connections.db'));
    setConnectionsRuntime({
      store,
      service: {} as never,
      eligibleAccountIds: () => [],
      gateway: 'openshell',
      workspace: 'default',
      legacyProviders: async () => [],
    });
    const oversized = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'x'.repeat(3_000) });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: 'Body too large' });
    const internal = await request(app)
      .get('/api/connections')
      .set('x-internal-token', 'internal-only');
    expect(internal.status).toBe(401);
    store.close();
    setConnectionsRuntime(null);
  });
});
