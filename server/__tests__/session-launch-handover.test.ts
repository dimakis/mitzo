import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SessionLaunchError, SessionLaunchStore } from '../session-launch-store.js';
import { SessionLaunchDefaultsStore } from '../session-launch-defaults.js';
import { SessionLaunchService } from '../session-launch-service.js';
import { createSessionLaunchRouter } from '../session-launch-routes.js';
import { initialSessionLaunchConfig } from '../session-launch-tools.js';

vi.mock('../auth.js', () => ({
  isAuthSessionCurrent: (auth: { id: string }) => auth.id === 'current',
  registerAuthSession: () => () => {},
}));
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const store = new SessionLaunchStore(':memory:');
  const defaults = new SessionLaunchDefaultsStore(':memory:');
  cleanup.push(
    () => store.close(),
    () => defaults.close(),
  );
  const start = vi.fn();
  const service = new SessionLaunchService(store, {
    validate: vi.fn(),
    start,
    inspect: vi.fn(),
  });
  const record = store.propose({
    operatorId: 'user',
    sourceSessionId: 'source',
    requestId: 'd712cf36-9659-48e8-8cb0-9d542a7bb200',
    title: 'Coordinator handover',
    prompt: '# Priorities\n\nLand Symposium.\n\nKeep Claude’s personal subscription. 🔧',
    configuration: initialSessionLaunchConfig(),
  });
  let login: string | null = 'current';
  let visible = true;
  const app = express();
  app.use(express.json(), (_req, res, next) => {
    if (login) res.locals.authSession = { id: login };
    next();
  });
  app.use(
    '/api/session-launch',
    createSessionLaunchRouter({
      controller: { defaults, launches: service, changed: vi.fn() },
      session: (id) => (id === 'source' && visible ? { title: 'Source' } : undefined),
      withAuthority: async (_auth, signal, action) =>
        action({
          operatorConnectionId: 'offline',
          authSessionId: 'current',
          signal,
          assertCurrent: () => signal.throwIfAborted(),
        }),
    }),
  );
  return {
    app,
    record,
    start,
    store,
    service,
    login: (value: string | null) => {
      login = value;
    },
    visible: (value: boolean) => {
      visible = value;
    },
  };
}
it('downloads exact retained Markdown before startup without filesystem access or dispatch', async () => {
  const f = fixture();
  const response = await request(f.app).get(
    `/api/session-launch/requests/${f.record.proposalId}/handover.md`,
  );
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toMatch(/^text\/markdown; charset=utf-8/);
  expect(response.headers['content-disposition']).toBe('attachment; filename="handover.md"');
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.text).toBe(f.record.prompt);
  expect(f.store.get(f.record.proposalId, 'user').state).toBe('pending');
  expect(f.start).not.toHaveBeenCalled();
});
it('labels a preflight refusal as not started and leaves the same proposal editable', async () => {
  const f = fixture();
  vi.mocked(f.service.port.validate).mockRejectedValue(
    new SessionLaunchError('Choose a compatible profile.'),
  );
  const response = await request(f.app)
    .post(`/api/session-launch/requests/${f.record.proposalId}/approve`)
    .send({
      expectedRevision: 1,
      title: f.record.title,
      prompt: f.record.prompt,
      configuration: f.record.configuration,
    });
  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({
    error: 'Choose a compatible profile.',
    code: 'session_launch_preflight_refused',
    effectStatus: 'not_started',
  });
  expect(f.store.get(f.record.proposalId, 'user')).toMatchObject({
    state: 'pending',
    allocationId: null,
    commandId: null,
  });
  expect(f.start).not.toHaveBeenCalled();
});
it.each([null, 'revoked'])('refuses handover downloads for login %s', async (login) => {
  const f = fixture();
  f.login(login);
  expect(
    (await request(f.app).get(`/api/session-launch/requests/${f.record.proposalId}/handover.md`))
      .status,
  ).toBe(403);
  expect(f.start).not.toHaveBeenCalled();
});
it('keeps hidden source handovers unavailable and never accepts filesystem paths', async () => {
  const f = fixture();
  f.visible(false);
  const response = await request(f.app).get(
    `/api/session-launch/requests/${f.record.proposalId}/handover.md`,
  );
  expect(response.status).toBe(404);
  expect(response.text).not.toContain('Priorities');
  expect(
    (await request(f.app).get('/api/session-launch/requests/not-a-uuid/handover.md')).status,
  ).toBe(400);
  expect(f.start).not.toHaveBeenCalled();
});
