import { expect, it, vi } from 'vitest';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';

vi.mock('../auth.js', () => ({
  login: vi.fn(),
  authenticateToken: vi.fn(),
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-operator') === 'yes') {
      res.locals.authSession = { id: 'operator-session', expiresAt: Date.now() + 60_000 };
      return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
  },
  operatorAuthMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header('x-operator') === 'yes') {
      res.locals.authSession = { id: 'operator-session', expiresAt: Date.now() + 60_000 };
      return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
  },
  registerAuthSession: vi.fn(() => () => undefined),
  revokeAuthSession: vi.fn(),
  verifyPassphrase: vi.fn(),
  COOKIE_NAME: 'cc_auth',
  MAX_AGE_HOURS: 24,
}));

it('requires authentication and represents unconfigured operations honestly', async () => {
  const { app } = await import('../app.js');
  expect((await request(app).get('/api/openshell/inventory')).status).toBe(401);
  const inventory = await request(app).get('/api/openshell/inventory').set('x-operator', 'yes');
  expect(inventory.status).toBe(503);
  expect(inventory.body).toMatchObject({
    available: false,
    collectedAt: expect.any(Number),
    scopes: [
      {
        provider: 'configured',
        workspace: 'unknown',
        status: 'unavailable',
        error: 'provider_inventory_unavailable',
      },
    ],
  });
  expect(inventory.body.sandboxes).toEqual([]);

  const capacity = await request(app).get('/api/openshell/capacity').set('x-operator', 'yes');
  expect(capacity.status).toBe(503);
  expect(capacity.body).toMatchObject({ available: false, state: 'unavailable' });
});
