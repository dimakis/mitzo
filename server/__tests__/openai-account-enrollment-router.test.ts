import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createConnectionsRouter } from '../connections-router.js';
import {
  OpenAIAccountEnrollment,
  OpenAIAccountEnrollmentStore,
} from '../openai-account-enrollment.js';
import { openAIEnrollmentCredentialReference } from '../openai-account-enrollment-keychain.js';
vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));

describe('new OpenAI account enrollment routes', () => {
  it.each(
    [
      'https://gateway.example/' + '界'.repeat(500),
      'https://localhost./v1',
      'https://private.localhost./v1',
      'https://./v1',
    ].flatMap((endpoint) =>
      (['responses', 'messages'] as const).map((protocol) => ({ endpoint, protocol })),
    ),
  )(
    'rejects invalid $protocol endpoint before the real service reserves a journal row: $endpoint',
    async ({ endpoint, protocol }) => {
      const root = mkdtempSync(join(tmpdir(), 'api-endpoint-router-'));
      const store = new OpenAIAccountEnrollmentStore(join(root, 'accounts.db'));
      try {
        const reserve = vi.spyOn(store, 'reserve');
        let savedVersion = '';
        const keychain = {
          create: vi.fn(async (operationId: string) => {
            savedVersion = operationId;
            return openAIEnrollmentCredentialReference(operationId);
          }),
          read: vi.fn(async () => ({
            value: 'synthetic-key',
            version: savedVersion,
            managed: true,
          })),
        };
        const gateway = { create: vi.fn(), inspect: vi.fn() };
        const discoverApiModels = vi.fn();
        const gate = vi.fn();
        const enrollment = new OpenAIAccountEnrollment({
          store,
          keychain,
          gateway,
          discoverApiModels,
          gate: async <T>(work: () => Promise<T>) => {
            gate();
            return work();
          },
          validateKey: vi.fn(),
          existingAccountIds: () => [],
          gatewayBinding: 'https://gateway.invalid',
          workspace: 'default',
        });
        const app = express();
        app.use((_req, res, next) => {
          res.locals.authSession = { id: 'endpoint-router', expiresAt: Date.now() + 60000 };
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
            openAIAccounts: enrollment,
          }),
        );
        const authorization = await request(app)
          .post('/api/connections/reauthorize')
          .send({ passphrase: 'correct' });
        const input = {
          csrf: authorization.body.csrf,
          requestId: 'de274e02-72eb-4a31-9ced-90dfe76d3c65',
          label: 'Endpoint regression',
          projectLabel: 'Offline verification',
          apiKey: 'synthetic-key',
          billingConfirmed: true,
          connection: {
            endpoint,
            protocol,
            ...(protocol === 'messages' ? { authentication: 'bearer' } : {}),
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
        const rejected = await request(app).post('/api/connections/openai-accounts').send(input);
        expect(rejected.status).toBe(400);
        expect(rejected.body).toMatchObject({
          code: 'ENROLLMENT_INPUT_INVALID',
          effectStatus: 'not_started',
        });
        const catalog = await request(app)
          .post('/api/connections/api-models')
          .send({
            csrf: input.csrf,
            endpoint,
            apiKey: input.apiKey,
            ...(protocol === 'messages' ? { protocol, authentication: 'bearer' } : {}),
          });
        expect(catalog.status).toBe(400);
        expect(gate).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
        expect(store.rows()).toEqual([]);
        expect(keychain.create).not.toHaveBeenCalled();
        expect(gateway.create).not.toHaveBeenCalled();
        expect(discoverApiModels).not.toHaveBeenCalled();
        const correctedEndpoint = 'https://gateway.example/' + '界'.repeat(224) + 'boundary///';
        const corrected = await request(app)
          .post('/api/connections/openai-accounts')
          .send({
            ...input,
            connection: { ...input.connection, endpoint: correctedEndpoint },
          });
        expect(corrected.status).toBe(201);
        expect(corrected.body.account.state).toBe('ready');
        const normalized = new URL(correctedEndpoint).toString().replace(/\/+$/, '');
        expect(normalized.length).toBe(2048);
        const saved = store.readyProfiles()[0];
        expect(saved.provider).toBe(protocol === 'messages' ? 'anthropic-api' : 'openai');
        expect(saved.connection).toMatchObject({
          endpoint: normalized,
          protocol,
          ...(protocol === 'messages' ? { authentication: 'bearer' } : {}),
        });
        expect(enrollment.list()).toHaveLength(1);
        expect(reserve).toHaveBeenCalledOnce();
        expect(discoverApiModels).not.toHaveBeenCalled();
        expect(gateway.create).not.toHaveBeenCalled();
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
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
