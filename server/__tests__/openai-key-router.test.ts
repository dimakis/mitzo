import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConnectionsRouter } from '../connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));
describe('OpenAI credential management routes', () => {
  it('requires browser auth, fresh reauthorization, same origin, and account revision', async () => {
    const manager = {
      authorize: vi.fn(async () => ({ health: 'not_verified' })),
      list: vi.fn(async () => []),
      replace: vi.fn(async () => ({ health: 'ready' })),
      synchronize: vi.fn(async () => ({ health: 'ready' })),
    };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'openai-key-router', expiresAt: Date.now() + 60000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store: {} as never,
        service: {} as never,
        eligibleAccounts: () => [],
        gateway: 'test',
        workspace: 'default',
        legacyProviders: async () => [],
        openAIKeys: manager as never,
      }),
    );
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post('/api/connections/openai-keys/work/replace')
        .set('x-browser', 'yes')
        .send(body);
    expect((await request(app).get('/api/connections/openai-keys')).status).toBe(401);
    expect(
      (await request(app).get('/api/connections/openai-keys').set('x-browser', 'yes')).body,
    ).toEqual({ accounts: [] });
    expect(
      (await post({ csrf: 'no', revision: 'v1', apiKey: 'PRIVATE', sameProject: true })).status,
    ).toBe(403);
    const auth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    const csrf = auth.body.csrf;
    const authorize = (body: object) =>
      request(app)
        .post('/api/connections/openai-keys/work/authorize')
        .set('x-browser', 'yes')
        .send(body);
    expect((await authorize({ csrf: 'stale', revision: 'v1' })).status).toBe(403);
    expect(manager.authorize).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .post('/api/connections/openai-keys/work/authorize')
          .set('x-browser', 'yes')
          .set('origin', 'https://untrusted.example')
          .send({ csrf, revision: 'v1' })
      ).status,
    ).toBe(403);
    expect((await authorize({ csrf, revision: 'v1', apiKey: 'UNEXPECTED' })).status).toBe(400);
    expect((await authorize({ csrf, revision: 'v1' })).status).toBe(200);
    expect(manager.authorize).toHaveBeenCalledExactlyOnceWith(
      { accountId: 'work', revision: 'v1' },
      expect.any(AbortSignal),
    );
    expect(
      (
        await post({
          csrf,
          revision: 'v1',
          apiKey: 'PRIVATE',
          sameProject: true,
          providerName: 'other',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/connections/openai-keys/work/replace')
          .set('x-browser', 'yes')
          .set('origin', 'https://untrusted.example')
          .send({ csrf, revision: 'v1', apiKey: 'PRIVATE', sameProject: true })
      ).status,
    ).toBe(403);
    expect(manager.replace).not.toHaveBeenCalled();
    expect((await post({ csrf, revision: 'v1', apiKey: 'PRIVATE' })).status).toBe(200);
    expect(manager.replace).toHaveBeenCalledWith(
      { accountId: 'work', revision: 'v1', apiKey: 'PRIVATE' },
      expect.any(AbortSignal),
    );
    manager.replace.mockRejectedValueOnce(new Error('PRIVATE_KEY from child process'));
    const failure = await post({ csrf, revision: 'v1', apiKey: 'PRIVATE', sameProject: true });
    expect(failure.status).toBe(422);
    expect(JSON.stringify(failure.body)).not.toContain('PRIVATE');
    expect(
      (await post({ csrf, revision: 'v1', apiKey: 'x'.repeat(22000), sameProject: true })).status,
    ).toBe(413);
    expect(
      (
        await request(app)
          .post('/api/connections/openai-keys/work/synchronize')
          .set('x-browser', 'yes')
          .send({ csrf, revision: 'v1' })
      ).status,
    ).toBe(200);
    expect(manager.synchronize).toHaveBeenCalledWith(
      { accountId: 'work', revision: 'v1' },
      expect.any(AbortSignal),
    );
    // Cached clients can still send this obsolete field; the server does not
    // treat it as proof of the key's billing identity or forward it to custody.
    expect(
      (await post({ csrf, revision: 'v1', apiKey: 'PRIVATE', sameProject: false })).status,
    ).toBe(200);
    expect(manager.replace).toHaveBeenLastCalledWith(
      { accountId: 'work', revision: 'v1', apiKey: 'PRIVATE' },
      expect.any(AbortSignal),
    );
  });
});
