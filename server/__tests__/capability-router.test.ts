import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionStore } from '../connections-store.js';
import { createConnectionsRouter } from '../connections-router.js';
import { createCapabilityOperationsRouter } from '../connections/capabilities/router.js';

vi.mock('../auth.js', () => ({ verifyPassphrase: (value: string) => value === 'correct' }));

describe('capability operations router', () => {
  it('uses the authoritative conversation account, recent CSRF, and a shared approval service', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'capability-router-'));
    const store = new ConnectionStore(join(directory, 'connections.db'));
    const invoke = vi.fn(async (input) => ({ id: 'operation-1', ...input, status: 'succeeded' }));
    const capabilityService = {
      invoke,
      getOperation: vi.fn(),
      cancel: vi.fn(),
      listGrants: vi.fn(() => []),
      setGrant: vi.fn(),
    };
    const app = express();
    app.use((req, res, next) => {
      if (req.header('x-browser') === 'yes')
        res.locals.authSession = { id: 'browser', expiresAt: Date.now() + 60_000 };
      next();
    });
    app.use(
      '/api/connections',
      createConnectionsRouter({
        store,
        service: { supportsTemplate: vi.fn() } as never,
        capabilities: capabilityService as never,
        eligibleAccounts: () => [],
        gateway: 'openshell',
        workspace: 'default',
        legacyProviders: async () => [],
      }),
    );
    app.use(
      '/api/capability-operations',
      createCapabilityOperationsRouter({
        service: capabilityService as never,
        sessionId: (_req, res) => res.locals.authSession?.id,
        resolveConversationBinding: (_sessionId, conversationId) =>
          conversationId === 'conversation-1' ? { accountId: 'authoritative-account' } : undefined,
        approveForConversation: () => vi.fn(async () => true),
      }),
    );
    const body = {
      capabilityId: 'test.mutate',
      capabilityVersion: 1,
      connectionId: 'connection-1',
      connectionRevision: 1,
      conversationId: 'conversation-1',
      turnId: 'browser-turn',
      idempotencyKey: 'browser-request',
      input: { value: 'safe' },
    };
    expect(
      (await request(app).post('/api/capability-operations').set('x-browser', 'yes').send(body))
        .status,
    ).toBe(403);
    const auth = await request(app)
      .post('/api/connections/reauthorize')
      .set('x-browser', 'yes')
      .send({ passphrase: 'correct' });
    const accepted = await request(app)
      .post('/api/capability-operations')
      .set('x-browser', 'yes')
      .set('x-csrf-token', auth.body.csrf)
      .send(body);
    expect(accepted.status).toBe(202);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'authoritative-account',
        conversationId: 'conversation-1',
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(
      (
        await request(app)
          .post('/api/capability-operations')
          .set('x-browser', 'yes')
          .set('x-csrf-token', auth.body.csrf)
          .set('Origin', 'https://evil.example')
          .send(body)
      ).status,
    ).toBe(403);
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
