import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { createConnectionsRouter } from '../connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
describe('connections router', () => {
  it('denies internal-only mutations and requires recent csrf reauthorization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connections-router-'));
    const store = new ConnectionStore(join(dir, 'db'));
    const service = { provision: vi.fn(), revoke: vi.fn() };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'session', expiresAt: Date.now() + 1_000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store,
        service: service as never,
        eligibleAccounts: () => ['work'],
      }),
    );
    const internal = await request(app)
      .post('/api/connections')
      .set('x-internal-token', 'token')
      .send({});
    expect(internal.status).toBe(401);
    const reauth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    expect(reauth.headers['cache-control']).toBe('no-store');
    const rejected = await request(app)
      .post('/api/connections')
      .set('x-browser', 'yes')
      .send({ label: 'Jira', email: 'a@example.com', token: 'secret', accountIds: ['work'] });
    expect(rejected.status).toBe(403);
    expect(JSON.stringify(rejected.body)).not.toContain('secret');
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
