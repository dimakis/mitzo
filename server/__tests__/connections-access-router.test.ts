import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
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
