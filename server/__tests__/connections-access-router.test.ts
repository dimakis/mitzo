import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { revokeAuthSession } from '../auth.js';
import { createConnectionsAccessRouter } from '../connections-access-router.js';

describe('Connections & access read route', () => {
  it('requires browser authentication, disables caching, and works without managed runtime', async () => {
    const accounts = vi.fn(() => []);
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'test', expiresAt: Date.now() + 60_000 };
      next();
    });
    app.use(
      '/api/connections-access',
      createConnectionsAccessRouter(() => ({ accounts })),
    );
    expect((await request(app).get('/api/connections-access')).status).toBe(401);
    expect(accounts).not.toHaveBeenCalled();
    const response = await request(app).get('/api/connections-access').set('x-browser', 'yes');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.sources).toContainEqual({
      id: 'managed',
      state: 'not-configured',
      reason: 'This source is not configured.',
    });
    expect(accounts).toHaveBeenCalledOnce();
    expect(
      (await request(app).post('/api/connections-access').set('x-browser', 'yes')).status,
    ).toBe(404);
  });
});

it.each(['logout', 'expiry'] as const)(
  'rejects inventory when %s occurs after personal metadata settles but before another source finishes',
  async (event) => {
    const session = { id: `inventory-${event}`, expiresAt: Date.now() + 60_000 };
    let release!: () => void;
    const slow = new Promise<Array<{ name: string; type: string }>>((resolve) => {
      release = () => resolve([]);
    });
    const personal = vi.fn(() => [
      { id: 'personal_one', label: 'Personal', revision: 1, state: 'connected' as const },
    ]);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.authSession = session;
      next();
    });
    app.use(
      '/api/connections-access',
      createConnectionsAccessRouter(() => ({ personal, legacy: () => slow })),
    );
    const pending = request(app)
      .get('/api/connections-access')
      .then((response) => response);
    await vi.waitFor(() => expect(personal).toHaveBeenCalledOnce());
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      if (event === 'logout') revokeAuthSession(session);
      else clock = vi.spyOn(Date, 'now').mockReturnValue(session.expiresAt + 1);
      release();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ error: 'Operator authorization expired or revoked' });
      expect(JSON.stringify(response.body)).not.toContain('personal_one');
    } finally {
      clock?.mockRestore();
      release();
    }
  },
);
