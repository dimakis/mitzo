import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSessionLaunchRouter } from '../session-launch-routes.js';
import { SessionLaunchError } from '../session-launch-store.js';

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => log }));
const authListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../auth.js', () => ({
  isAuthSessionCurrent: (auth: { id: string }) => auth.id !== 'revoked',
  registerAuthSession: (_auth: unknown, listener: () => void) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  },
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
function fixture(login: string | null = 'current', startupTimeoutMs?: number) {
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
      propose: vi.fn(() => record),
      linked: vi.fn(() => []),
      link: vi.fn(),
      unlink: vi.fn(),
    },
    port: { validate: vi.fn(async () => {}) },
    approve: vi.fn(async (_id, _owner, _edits, _revision, _authority, effect) => {
      effect?.('borrowed-db');
      return { ...record, state: 'created', revision: 2 };
    }),
    refresh: vi.fn(async (_id: string, _owner: string, _authority: unknown) => record),
    resume: vi.fn(async (_id: string, _owner: string, _revision: number, _authority: unknown) => ({
      ...record,
      state: 'created',
      revision: 5,
    })),
    release: vi.fn(async () => ({ ...record, state: 'cancelled', revision: 2 })),
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
      session: (id) =>
        id === 'source'
          ? { title: 'Origin chat' }
          : id === 'target'
            ? { title: 'Target chat' }
            : undefined,
      withAuthority: async (_auth, signal, action) =>
        action({
          operatorConnectionId: 'host-owned',
          authSessionId: login!,
          signal,
          assertCurrent() {},
        }),
      ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
    }),
  );
  return { app, defaults, launches, controller };
}
/** Sends a request, then drops its connection as a backgrounded phone does. */
async function disconnectDuring(
  app: express.Express,
  path: string,
  body: unknown,
  started: () => boolean,
) {
  const server: Server = app.listen(0);
  try {
    let socketClosed = false;
    server.on('connection', (socket) => socket.once('close', () => (socketClosed = true)));
    const { port } = server.address() as AddressInfo;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const client = httpRequest({
      port,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    });
    client.on('error', () => {
      /* This test deliberately destroys the client connection. */
    });
    client.end(payload);
    await vi.waitFor(() => expect(started()).toBe(true));
    client.destroy();
    await vi.waitFor(() => expect(socketClosed).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    server.close();
  }
}
function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}
const signalOf = (authority: unknown) => (authority as { signal: AbortSignal }).signal;
const rejectOnAbort = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
describe('reviewed session launch routes', () => {
  it('keeps approved startup running when the requesting client disconnects; reads still cancel', async () => {
    const f = fixture();
    const startupGate = gated();
    let startup: AbortSignal | undefined;
    f.launches.approve.mockImplementationOnce(async (_id, _owner, _edits, _rev, authority) => {
      startup = signalOf(authority);
      await startupGate.gate;
      return { ...record, state: 'running', revision: 3 };
    });
    await disconnectDuring(
      f.app,
      `/api/session-launch/requests/${record.proposalId}/approve`,
      { expectedRevision: 1, title: record.title, prompt: record.prompt, configuration },
      () => Boolean(startup),
    );
    // A backgrounded phone is not a cancellation of committed startup effects.
    expect(startup!.aborted).toBe(false);
    startupGate.open();
    await vi.waitFor(() => expect(f.controller.changed).toHaveBeenCalledWith('source'));
    expect(authListeners.size).toBe(0);

    const readGate = gated();
    let read: AbortSignal | undefined;
    f.launches.refresh.mockImplementationOnce(async (_id, _owner, authority) => {
      read = signalOf(authority);
      await readGate.gate;
      return record;
    });
    await disconnectDuring(
      f.app,
      `/api/session-launch/requests/${record.proposalId}`,
      undefined,
      () => Boolean(read),
    );
    expect(read!.aborted).toBe(true);
    readGate.open();
  });
  it('bounds detached startup by login revocation and the shared startup deadline', async () => {
    const revoked = fixture();
    let signal: AbortSignal | undefined;
    revoked.launches.resume.mockImplementationOnce(async (_id, _owner, _rev, authority) => {
      signal = signalOf(authority);
      return rejectOnAbort(signal);
    });
    const pending = request(revoked.app)
      .post(`/api/session-launch/requests/${record.proposalId}/resume`)
      .send({ expectedRevision: 4 })
      .then((response) => response);
    await vi.waitFor(() => expect(signal).toBeDefined());
    for (const listener of authListeners) listener();
    expect(signal!.aborted).toBe(true);
    expect((await pending).status).toBe(503);

    const bounded = fixture('current', 20);
    let deadline: AbortSignal | undefined;
    bounded.launches.approve.mockImplementationOnce(
      async (_id, _owner, _edits, _rev, authority) => {
        deadline = signalOf(authority);
        return rejectOnAbort(deadline);
      },
    );
    const timedOut = await request(bounded.app)
      .post(`/api/session-launch/requests/${record.proposalId}/approve`)
      .send({ expectedRevision: 1, title: record.title, prompt: record.prompt, configuration });
    expect(timedOut.status).toBe(503);
    expect(timedOut.text).toContain('Check the retained request before retrying');
    expect((deadline!.reason as Error).name).toBe('TimeoutError');
    expect(authListeners.size).toBe(0);
  });
  it('requires exact authenticated release review and delivers an owner refusal without private causes', async () => {
    const f = fixture();
    const path = `/api/session-launch/requests/${record.proposalId}/release`;
    expect(
      (
        await request(f.app)
          .post(path)
          .set('Origin', 'https://hostile.example')
          .send({ expectedRevision: 1 })
      ).status,
    ).toBe(403);
    expect(
      (await request(fixture('revoked').app).post(path).send({ expectedRevision: 1 })).status,
    ).toBe(403);
    expect((await request(f.app).post(path).send({})).status).toBe(400);
    expect(f.launches.release).not.toHaveBeenCalled();
    f.launches.release.mockRejectedValueOnce(
      new SessionLaunchError('Release is unconfirmed. Recover the original request.', 409, {
        cause: Error('private owner detail'),
      }),
    );
    const refusal = await request(f.app).post(path).send({ expectedRevision: 1 });
    expect(refusal.status).toBe(409);
    expect(refusal.text).toContain('Release is unconfirmed');
    expect(refusal.text).not.toContain('private owner detail');
    expect(f.launches.release).toHaveBeenCalledWith(
      record.proposalId,
      'user',
      1,
      expect.objectContaining({ authSessionId: 'current' }),
    );
    expect(f.defaults.saveInTransaction).not.toHaveBeenCalled();
  });
  it('keeps link mutations authenticated, same origin and separate from launches and grants', async () => {
    const f = fixture();
    expect(
      (await request(f.app).put('/api/session-launch/links/source/missing').send({})).status,
    ).toBe(404);
    expect(
      (
        await request(f.app)
          .put('/api/session-launch/links/source/target')
          .set('Origin', 'https://hostile.example')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(fixture('revoked').app)
          .delete('/api/session-launch/links/source/target')
          .send({})
      ).status,
    ).toBe(403);
    expect(f.launches.store.link).not.toHaveBeenCalled();
    expect(
      (await request(f.app).put('/api/session-launch/links/source/target').send({})).status,
    ).toBe(200);
    expect(f.launches.store.link).toHaveBeenCalledWith(
      'user',
      'source',
      'target',
      'Origin chat',
      'Target chat',
    );
    expect(f.launches.approve).not.toHaveBeenCalled();
    expect(
      (await request(f.app).delete('/api/session-launch/links/source/target').send({})).status,
    ).toBe(200);
    expect(f.launches.store.unlink).toHaveBeenCalledWith('user', 'source', 'target');
  });
  it('starts from Links only through explicit authenticated approval using the retained request identity', async () => {
    const f = fixture();
    const body = {
      requestId: record.requestId,
      sourceSessionId: 'source',
      title: record.title,
      prompt: record.prompt,
      configuration,
      saveAsDefault: false,
    };
    expect((await request(f.app).get('/api/session-launch/requests?sessionId=source')).status).toBe(
      200,
    );
    expect(f.launches.approve).not.toHaveBeenCalled();
    expect(
      (await request(fixture('revoked').app).post('/api/session-launch/requests/start').send(body))
        .status,
    ).toBe(403);
    expect(
      (
        await request(f.app)
          .post('/api/session-launch/requests/start')
          .set('Origin', 'https://hostile.example')
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (await request(f.app).post('/api/session-launch/requests/start').send(body)).status,
    ).toBe(200);
    expect(f.launches.store.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: 'user',
        sourceSessionId: 'source',
        requestId: record.requestId,
      }),
    );
    expect(f.launches.approve).toHaveBeenCalledWith(
      record.proposalId,
      'user',
      expect.objectContaining({ configuration }),
      1,
      expect.anything(),
      undefined,
    );
  });
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
  it('logs a refused or failed launch with a stable code and proposal ID, never prompts or causes', async () => {
    const f = fixture();
    const approve = () =>
      request(f.app)
        .post(`/api/session-launch/requests/${record.proposalId}/approve`)
        .send({ expectedRevision: 1, title: 'T', prompt: 'Secret handoff text', configuration });
    f.launches.approve.mockRejectedValueOnce(
      new SessionLaunchError(
        'Agent-created sessions start only on a Local Mac Codex or Claude account.',
        409,
        { cause: Error('private provider detail') },
      ),
    );
    log.warn.mockClear();
    expect((await approve()).status).toBe(409);
    expect(log.warn).toHaveBeenCalledWith('Session launch request refused', {
      code: 'session_launch_refused',
      status: 409,
      method: 'POST',
      route: '/requests/:proposalId/approve',
      proposalId: record.proposalId,
      reason: 'Agent-created sessions start only on a Local Mac Codex or Claude account.',
    });
    f.launches.approve.mockRejectedValueOnce(Error('private storage detail: Secret handoff text'));
    log.error.mockClear();
    expect((await approve()).status).toBe(503);
    expect(log.error).toHaveBeenCalledWith('Session launch request failed', {
      code: 'session_launch_unavailable',
      status: 503,
      method: 'POST',
      route: '/requests/:proposalId/approve',
      proposalId: record.proposalId,
      causeType: 'Error',
    });
    const logged = JSON.stringify([log.warn.mock.calls, log.error.mock.calls]);
    for (const secret of ['Secret handoff text', 'private provider detail', 'private storage'])
      expect(logged).not.toContain(secret);
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
