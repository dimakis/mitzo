import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConnectionsRouter } from '../connections-router.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));

describe('new OpenAI account enrollment routes', () => {
  it('requires browser reauthorization, billing consent and fixed destinations; sanitizes failures', async () => {
    const account = {
      id: 'new-work',
      label: 'New Work',
      projectLabel: 'Active work project',
      state: 'ready',
    };
    const enrollment = { list: vi.fn(() => [account]), enroll: vi.fn(async () => account) };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'openai-enrollment-router', expiresAt: Date.now() + 60000 };
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
        openAIAccounts: enrollment as never,
      }),
    );
    const post = (body: Record<string, unknown>) =>
      request(app).post('/api/connections/openai-accounts').set('x-browser', 'yes').send(body);
    expect((await request(app).get('/api/connections/openai-accounts')).status).toBe(401);
    expect(
      (await request(app).get('/api/connections/openai-accounts').set('x-browser', 'yes')).body,
    ).toEqual({ enabled: true, accounts: [account] });
    const input = {
      requestId: 'de274e02-72eb-4a31-9ced-90dfe76d3c65',
      label: 'New Work',
      projectLabel: 'Active work project',
      apiKey: 'PRIVATE',
      billingConfirmed: true,
    };
    expect((await post({ ...input, csrf: 'missing' })).status).toBe(403);
    const authorization = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    const csrf = authorization.body.csrf;
    expect((await post({ ...input, csrf, billingConfirmed: false })).status).toBe(400);
    expect((await post({ ...input, csrf, providerName: 'existing-provider' })).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/connections/openai-accounts')
          .set('x-browser', 'yes')
          .set('origin', 'https://untrusted.example')
          .send({ ...input, csrf })
      ).status,
    ).toBe(403);
    expect(enrollment.enroll).not.toHaveBeenCalled();
    expect((await post({ ...input, csrf })).status).toBe(201);
    expect(enrollment.enroll).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    enrollment.enroll.mockRejectedValueOnce(new Error('PRIVATE_KEY from provider'));
    const failed = await post({ ...input, csrf });
    expect(failed.status).toBe(422);
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE');
    expect((await post({ ...input, csrf, apiKey: 'x'.repeat(22000) })).status).toBe(413);
  });
  it('keeps enrollment unavailable when not configured', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.authSession = { id: 'disabled-enrollment', expiresAt: Date.now() + 60000 };
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
      }),
    );
    expect((await request(app).get('/api/connections/openai-accounts')).status).toBe(503);
  });
});
