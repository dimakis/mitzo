import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { ApiToolCatalog } from '../api-tool-catalog.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import { CredentialConnections, CredentialConnectionStore } from '../credential-connections.js';
import { recentAppReauthorizationHandlers } from '../connections-router.js';
import { revokeAuthSession } from '../auth.js';
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));
async function fixture() {
  const catalog = new ApiToolCatalog(':memory:');
  const library = new AgentLibraryStore(':memory:');
  const store = new CredentialConnectionStore(':memory:');
  cleanup.push(
    () => catalog.close(),
    () => library.close(),
    () => store.close(),
  );
  const send = vi.fn(async () => ({
    status: 200,
    body: '{"entity_id":"sensor.office","state":"21","last_changed":"2026-10-17T00:00:00Z"}',
  }));
  const vault = {
    save: vi.fn(async () => ({ service: 'fixture', account: 'fixture' })),
    link: vi.fn(),
    read: vi.fn(async () => 'fake-secret'),
    remove: vi.fn(),
  };
  const service = new CredentialConnections(store, vault, send);
  const c = await service.create(
    {
      label: 'HA fixture',
      serviceTemplate: 'home-assistant',
      endpoint: 'https://ha.example.com',
      auth: { kind: 'bearer' },
      methods: ['GET'],
      paths: ['/api/'],
    },
    { secret: 'fixture' },
  );
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = auth;
    next();
  });
  app.post('/reauthorize', ...recentAppReauthorizationHandlers());
  app.use(
    '/api/agent-library',
    createAgentLibraryRouter(library, { apiTools: () => ({ catalog, service }) }),
  );
  const body = {
    id: randomUUID(),
    expectedVersion: 0,
    configuration: {
      template: 'home-assistant.state@1',
      label: 'Office',
      connectionId: c.id,
      entityId: 'sensor.office',
    },
  };
  const reauth = await request(app)
    .post('/reauthorize')
    .send({ passphrase: 'test-passphrase-for-vitest' })
    .expect(200);
  return { app, auth, catalog, service, send, vault, body, csrf: reauth.body.csrf };
}
it('configures, verifies, publishes and projects a reviewed template without implicit requests', async () => {
  const f = await fixture();
  const base = '/api/agent-library/api-tools';
  const initial = await request(f.app).get(base).expect(200);
  expect(initial.body.templates[0].id).toBe('home-assistant.state@1');
  expect(f.send).not.toHaveBeenCalled();
  const saved = await request(f.app)
    .post(base + '/drafts')
    .send(f.body)
    .expect(200);
  const body = { id: saved.body.draft.id, version: 1 };
  await request(f.app)
    .post(base + '/publish')
    .send(body)
    .expect(400);
  await request(f.app)
    .post(base + '/verify')
    .send(body)
    .expect(403);
  expect(f.send).not.toHaveBeenCalled();
  f.csrf = (
    await request(f.app)
      .post('/reauthorize')
      .send({ passphrase: 'test-passphrase-for-vitest' })
      .expect(200)
  ).body.csrf;
  await request(f.app)
    .post(base + '/verify')
    .set('x-csrf-token', f.csrf)
    .send(body)
    .expect(200);
  const published = await request(f.app)
    .post(base + '/publish')
    .send(body)
    .expect(200);
  expect(published.body.tool.id).toBe(`api:${body.id}`);
  const tools = await request(f.app).get('/api/agent-library/tools').expect(200);
  expect(tools.body.tools.some((t: { id: string }) => t.id === published.body.tool.id)).toBe(true);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.service.sessions(f.body.configuration.connectionId)).toEqual([]);
});
it('same-origin and operator revocation fence verification, retaining an unverified draft', async () => {
  const f = await fixture();
  const base = '/api/agent-library/api-tools';
  await request(f.app)
    .post(base + '/drafts')
    .set('Origin', 'https://evil.example')
    .send(f.body)
    .expect(403);
  await request(f.app)
    .post(base + '/drafts')
    .send(f.body)
    .expect(200);
  f.send.mockImplementationOnce(async () => {
    revokeAuthSession(f.auth.id);
    return { status: 200, body: '{}' };
  });
  await request(f.app)
    .post(base + '/verify')
    .set('x-csrf-token', f.csrf)
    .send({ id: f.body.id, version: 1 })
    .expect(400);
  expect(() => f.catalog.publish(f.body.id, 1, f.service)).toThrow(/verif/i);
});
it('routes only the explicit API tool lifecycle over retained-owner IPC', async () => {
  const { selectCustodianOperation, custodianRoute } =
    await import('../symposium-custodian-protocol.js');
  for (const [method, path, operation] of [
    ['GET', '/api/agent-library/api-tools', 'library.apiTools'],
    ['POST', '/api/agent-library/api-tools/drafts', 'library.apiDraft'],
    ['POST', '/api/agent-library/api-tools/verify', 'library.apiVerify'],
    ['POST', '/api/agent-library/api-tools/publish', 'library.apiPublish'],
  ]) {
    expect(selectCustodianOperation(method, path)?.operation).toBe(operation);
    expect(custodianRoute({ operation } as never)).toMatchObject({ method, path });
  }
  expect(selectCustodianOperation('POST', '/api/agent-library/api-tools/execute')).toBeNull();
});
