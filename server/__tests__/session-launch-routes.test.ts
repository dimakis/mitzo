import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSessionLaunchRouter } from '../session-launch-routes.js';

vi.mock('../auth.js', () => ({
  isAuthSessionCurrent: (auth: { id: string }) => auth.id !== 'revoked',
  registerAuthSession: () => () => {},
}));
const configuration = {
  version: 1,
  runtime: {
    version: 1,
    account: null,
    agentProfile: null,
    execution: { location: 'local', targetId: 'host' },
  },
  mode: 'ask',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const record = {
  proposalId: 'eed96088-dc2d-4379-8b55-e9674860b63f',
  requestId: '118f76f7-c3d2-4aa0-9293-f57d164de72b',
  sourceSessionId: 'source',
  title: 'New chat',
  prompt: 'Handoff',
  configuration,
  revision: 1,
  state: 'pending',
  childSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  allocationId: 'private-id',
};
function fixture(login: string | null = 'current') {
  const defaults = {
    get: vi.fn(() => ({ revision: 2, configuration })),
    save: vi.fn(() => ({ revision: 3, configuration })),
    saveInTransaction: vi.fn(),
  };
  const launches = {
    store: {
      forSession: vi.fn(() => [record]),
      get: vi.fn(() => record),
      cancel: vi.fn(() => ({ ...record, state: 'cancelled', revision: 2 })),
    },
    port: { validate: vi.fn(async () => {}) },
    approve: vi.fn(async (_id, _owner, _edits, _revision, _authority, effect) => {
      effect?.('borrowed-db');
      return { ...record, state: 'created', revision: 2 };
    }),
    refresh: vi.fn(async () => record),
    resume: vi.fn(async () => ({ ...record, state: 'created', revision: 5 })),
  };
  const controller = { defaults, launches, changed: vi.fn() };
  const app = express();
  app.use(express.json(), (_req, res, next) => {
    if (login) res.locals.authSession = { id: login, expiresAt: Date.now() + 100000 };
    next();
  });
  app.use(
    '/api/session-launch',
    createSessionLaunchRouter({
      controller: controller as never,
      session: (id) => (id === 'source' ? { title: 'Origin chat' } : undefined),
      withAuthority: async (_auth, signal, action) =>
        action({
          operatorConnectionId: 'host-owned',
          authSessionId: login!,
          signal,
          assertCurrent() {},
        }),
    }),
  );
  return { app, defaults, launches };
}
describe('reviewed session launch routes', () => {
  it('requires explicit authenticated revision-fenced startup recovery', async () => {
    const f = fixture();
    await request(f.app).get('/api/session-launch/requests?sessionId=source');
    expect(f.launches.resume).not.toHaveBeenCalled();
    const response = await request(f.app)
      .post(`/api/session-launch/requests/${record.proposalId}/resume`)
      .send({ expectedRevision: 4 });
    expect(response.status).toBe(200);
    expect(f.launches.resume).toHaveBeenCalledWith(
      record.proposalId,
      'user',
      4,
      expect.objectContaining({ authSessionId: 'current', operatorConnectionId: 'host-owned' }),
    );
    expect(response.body.allocationId).toBeUndefined();
  });
  it('requires current human authentication and rejects cross-origin writes', async () => {
    expect((await request(fixture(null).app).get('/api/session-launch/defaults')).status).toBe(403);
    expect((await request(fixture('revoked').app).get('/api/session-launch/defaults')).status).toBe(
      403,
    );
    const f = fixture();
    expect(
      (
        await request(f.app)
          .put('/api/session-launch/defaults')
          .set('Origin', 'https://other.example')
          .send({ expectedRevision: 2, configuration })
      ).status,
    ).toBe(403);
    expect(f.defaults.save).not.toHaveBeenCalled();
  });
  it('reads stable persistent defaults and excludes private startup identities', async () => {
    const f = fixture();
    const defaults = await request(f.app).get('/api/session-launch/defaults');
    expect(defaults.body).toEqual({ revision: 2, configuration });
    expect(defaults.headers['cache-control']).toContain('no-store');
    const list = await request(f.app).get('/api/session-launch/requests?sessionId=source');
    expect(list.status).toBe(200);
    expect(list.body.requests[0].allocationId).toBeUndefined();
    expect(f.launches.approve).not.toHaveBeenCalled();
  });
  it('passes only the complete edited configuration and authenticated authority to startup', async () => {
    const f = fixture();
    const edits = { title: 'Reviewed title', prompt: 'Reviewed handoff', configuration };
    const response = await request(f.app)
      .post(`/api/session-launch/requests/${record.proposalId}/approve`)
      .send({ expectedRevision: 1, ...edits, saveAsDefault: true });
    expect(response.status).toBe(200);
    expect(f.launches.approve).toHaveBeenCalledWith(
      record.proposalId,
      'user',
      edits,
      1,
      expect.objectContaining({ authSessionId: 'current', operatorConnectionId: 'host-owned' }),
      expect.any(Function),
    );
    expect(f.defaults.saveInTransaction).toHaveBeenCalledWith(
      'user',
      { expectedRevision: 2, configuration },
      'borrowed-db',
    );
    expect(response.body.allocationId).toBeUndefined();
  });
});
