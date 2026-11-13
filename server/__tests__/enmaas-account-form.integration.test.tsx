// @vitest-environment node-compatible-dom
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import request from 'supertest';
import React, { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenAIAccountEnrollment } from '../../frontend/src/components/OpenAIAccountEnrollment.js';
import { apiFetch } from '../../frontend/src/lib/api-fetch.js';
import { createConnectionsRouter } from '../connections-router.js';
import {
  OpenAIAccountEnrollment as Enrollment,
  OpenAIAccountEnrollmentStore,
} from '../openai-account-enrollment.js';
import { openAIEnrollmentCredentialReference } from '../openai-account-enrollment-keychain.js';
import { discoverApiAccountModels } from '../api-account-setup.js';
import type { ConnectionSender } from '../credential-connections.js';

// Only the HTTP transport and external custody are replaced. The form, API client,
// router, input schemas, enrollment service and SQLite journal are real.
vi.mock('../../frontend/src/lib/api-fetch.js', () => ({ apiFetch: vi.fn() }));
vi.mock('../auth.js', () => ({
  verifyPassphrase: (value: string) => value === 'correct',
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it.each(['responses', 'messages'] as const)(
  'saves the EnMaaS %s form through the real enrollment route and journal',
  async (protocol) => {
    const root = mkdtempSync(join(tmpdir(), 'enmaas-form-route-'));
    const store = new OpenAIAccountEnrollmentStore(join(root, 'accounts.db'));
    try {
      const secrets = new Map<string, { value: string; version: string; managed: boolean }>();
      const keychain = {
        create: vi.fn(async (id: string, value: string) => {
          const ref = openAIEnrollmentCredentialReference(id);
          secrets.set(ref.service, { value, version: id, managed: true });
          return ref;
        }),
        read: vi.fn(async (ref: { service: string }) => secrets.get(ref.service)!),
      };
      const gateway = { create: vi.fn(), inspect: vi.fn() };
      const validateKey = vi.fn();
      const sender = vi.fn<ConnectionSender>(async () => ({
        status: 200,
        body: JSON.stringify({ data: [{ id: 'catalog/model', name: 'Catalog model' }] }),
      }));
      const enrollment = new Enrollment({
        store,
        keychain,
        gateway,
        validateKey,
        discoverApiModels: (endpoint, key, signal, options) =>
          discoverApiAccountModels(endpoint, key, signal, sender, options),
        gate: async (work) => work(),
        existingAccountIds: () => [],
        gatewayBinding: 'offline',
        workspace: 'default',
      });
      const app = express();
      app.use((_req, res, next) => {
        res.locals.authSession = { id: 'enmaas-form', expiresAt: Date.now() + 60000 };
        next();
      });
      app.use(
        '/api/connections',
        createConnectionsRouter({
          store: {} as never,
          service: {} as never,
          eligibleAccounts: () => [],
          gateway: 'offline',
          workspace: 'default',
          legacyProviders: async () => [],
          openAIAccounts: enrollment,
        }),
      );
      const authorization = await request(app)
        .post('/api/connections/reauthorize')
        .send({ passphrase: 'correct' });
      const receipts: number[] = [];
      vi.mocked(apiFetch).mockImplementation(async (path, init) => {
        const method = init?.method === 'POST' ? 'post' : 'get';
        let pending = request(app)[method](String(path));
        if (init?.body) pending = pending.send(JSON.parse(String(init.body)));
        const response = await pending;
        receipts.push(response.status);
        return new Response(JSON.stringify(response.body), { status: response.status });
      });
      render(
        <MemoryRouter>
          <OpenAIAccountEnrollment
            csrf={authorization.body.csrf}
            authorized
            onReauthorizationNeeded={() => {
              throw Error('Unexpected reauthorization');
            }}
          />
        </MemoryRouter>,
      );
      await screen.findByLabelText('Provider');
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
      fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: protocol } });
      fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'EnMaaS Work' } });
      fireEvent.change(screen.getByLabelText('API key'), {
        target: { value: 'synthetic-enmaas-key' },
      });
      const submit = screen.getByRole('button', { name: 'Connect EnMaaS' }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
      await act(async () => fireEvent.click(submit));
      expect(await screen.findByText('Account saved')).toBeTruthy();
      await waitFor(() => expect(receipts).toEqual([200, 200, 201, 200]));
      expect(sender.mock.calls[0][0]).toMatchObject({
        headers:
          protocol === 'messages'
            ? { 'x-api-key': 'synthetic-enmaas-key', 'anthropic-version': '2023-06-01' }
            : { Authorization: 'Bearer synthetic-enmaas-key' },
      });
      expect(keychain.create).toHaveBeenCalledOnce();
      expect(gateway.create).not.toHaveBeenCalled();
      expect(validateKey).not.toHaveBeenCalled();
      const [profile] = store.readyProfiles();
      expect(profile.connection).toMatchObject({
        protocol,
        ...(protocol === 'messages' ? { authentication: 'api-key' } : {}),
      });
      expect(profile.provider).toBe(protocol === 'messages' ? 'anthropic-api' : 'openai');
      expect(profile.models.map((model) => model.id)).toEqual([
        'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
        'rits/zai-org/glm-5-3',
        'catalog/model',
      ]);
      const unauthorized = await request(app)
        .post(`/api/connections/openai-accounts/${profile.id}/models`)
        .send({ csrf: 'invalid' });
      expect(unauthorized.status).toBe(403);
      expect(sender).toHaveBeenCalledOnce();
      sender.mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ data: [{ id: 'new/model' }] }),
      });
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Refresh models' })),
      );
      await screen.findByText('4 available · 4 shown');
      await waitFor(() => expect(receipts).toEqual([200, 200, 201, 200, 200, 200]));
      expect(store.readyProfiles()[0].models.map((model) => model.id)).toContain('new/model');
      expect(JSON.stringify(store.rows())).not.toContain('synthetic-enmaas-key');
      expect(screen.queryByLabelText('API key')).toBeNull();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
