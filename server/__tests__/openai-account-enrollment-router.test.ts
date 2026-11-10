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
    const enrollment = {
      list: vi.fn(() => [account]),
      enroll: vi.fn(async () => account),
      discoverModels: vi.fn(async (_endpoint: string, _key: string, _signal: AbortSignal) => ({
        models: [{ id: 'vendor/model', label: 'Hosted' }],
        partial: true,
      })),
    };
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
    const discover = (body: Record<string, unknown>) =>
      request(app).post('/api/connections/api-models').set('x-browser', 'yes').send(body);
    const catalogInput = { endpoint: 'https://gateway.example/v1', apiKey: 'PRIVATE' };
    expect((await discover(catalogInput)).status).toBe(400);
    expect((await discover({ ...catalogInput, csrf: 'wrong' })).status).toBe(403);
    expect(
      (await discover({ ...catalogInput, csrf, endpoint: 'https://localhost/v1' })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/connections/api-models')
          .set('x-browser', 'yes')
          .set('origin', 'https://untrusted.example')
          .send({ ...catalogInput, csrf })
      ).status,
    ).toBe(403);
    expect(enrollment.discoverModels).not.toHaveBeenCalled();
    const catalog = await discover({ ...catalogInput, csrf });
    expect(catalog.status).toBe(200);
    expect(catalog.body).toEqual({
      models: [{ id: 'vendor/model', label: 'Hosted' }],
      partial: true,
    });
    expect(enrollment.discoverModels).toHaveBeenCalledWith(
      catalogInput.endpoint,
      catalogInput.apiKey,
      expect.any(AbortSignal),
    );
    expect(
      (await discover({ ...catalogInput, csrf, protocol: 'messages', authentication: 'bearer' }))
        .status,
    ).toBe(200);
    expect(enrollment.discoverModels).toHaveBeenLastCalledWith(
      catalogInput.endpoint,
      catalogInput.apiKey,
      expect.any(AbortSignal),
      { protocol: 'messages', authentication: 'bearer' },
    );
    const escapedKey = '\\'.repeat(16384);
    expect((await discover({ ...catalogInput, csrf, apiKey: escapedKey })).status).toBe(200);
    expect(enrollment.discoverModels).toHaveBeenLastCalledWith(
      catalogInput.endpoint,
      escapedKey,
      expect.any(AbortSignal),
    );
    expect(
      (
        await discover({
          ...catalogInput,
          csrf,
          apiKey: escapedKey,
          protocol: 'messages',
          authentication: 'api-key',
        })
      ).status,
    ).toBe(200);
    expect(enrollment.discoverModels).toHaveBeenLastCalledWith(
      catalogInput.endpoint,
      escapedKey,
      expect.any(AbortSignal),
      { protocol: 'messages', authentication: 'api-key' },
    );
    enrollment.discoverModels.mockRejectedValueOnce(Error('PRIVATE_KEY private upstream response'));
    const failedCatalog = await discover({ ...catalogInput, csrf });
    expect(failedCatalog.status).toBe(422);
    expect(failedCatalog.body.code).toBe('CATALOG_UNAVAILABLE');
    expect(JSON.stringify(failedCatalog.body)).not.toContain('PRIVATE');
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
    const custom = {
      ...input,
      connection: {
        endpoint: 'https://gateway.example/v1',
        protocol: 'responses',
        qualification: {
          source: 'operator',
          streaming: true,
          toolCalls: true,
          continuation: true,
          cancellation: true,
        },
      },
      models: [{ id: 'vendor/model', label: 'Hosted' }],
    };
    expect((await post({ ...custom, csrf })).status).toBe(201);
    expect(enrollment.enroll).toHaveBeenLastCalledWith(custom, expect.any(AbortSignal));
    const messages = {
      ...custom,
      connection: { ...custom.connection, protocol: 'messages', authentication: 'bearer' },
    };
    expect((await post({ ...messages, csrf })).status).toBe(201);
    expect(enrollment.enroll).toHaveBeenLastCalledWith(messages, expect.any(AbortSignal));
    const largeSelection = {
      ...custom,
      apiKey: 'k'.repeat(16384),
      models: Array.from({ length: 200 }, (_, index) => {
        const id = '界'.repeat(253) + String(index).padStart(3, '0');
        return { id, label: id };
      }),
    };
    expect(Buffer.byteLength(JSON.stringify(largeSelection))).toBeGreaterThan(300000);
    for (const connection of [custom.connection, messages.connection]) {
      const selection = { ...largeSelection, connection };
      expect((await post({ ...selection, csrf })).status).toBe(201);
      expect(enrollment.enroll).toHaveBeenLastCalledWith(selection, expect.any(AbortSignal));
      const callsBeforeInvalid = enrollment.enroll.mock.calls.length;
      const invalidEndpoint = await post({
        ...custom,
        csrf,
        connection: { ...connection, endpoint: 'http://gateway.example/v1' },
      });
      expect(invalidEndpoint.status).toBe(400);
      expect(invalidEndpoint.body).toMatchObject({
        code: 'ENROLLMENT_INPUT_INVALID',
        effectStatus: 'not_started',
      });
      expect(enrollment.enroll).toHaveBeenCalledTimes(callsBeforeInvalid);
    }
    expect(
      (
        await post({
          ...custom,
          csrf,
          connection: { ...custom.connection, qualification: undefined },
        })
      ).status,
    ).toBe(400);
    enrollment.enroll.mockRejectedValueOnce(new Error('PRIVATE_KEY from provider'));
    const failed = await post({ ...input, csrf });
    expect(failed.status).toBe(422);
    expect(JSON.stringify(failed.body)).not.toContain('PRIVATE');
    expect((await post({ ...input, csrf, apiKey: 'x'.repeat(22000) })).status).toBe(400);
    expect((await post({ ...input, csrf, apiKey: 'x'.repeat(1024 * 1024) })).status).toBe(413);
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
