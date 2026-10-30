import express from 'express';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { reserveRepositoryStartup } from '../ordinary-repository-startup.js';
const mock = vi.hoisted(() => ({
  evidence: vi.fn(() => 'e'.repeat(64)),
  receipts: [
    { callId: 'fixture', toolName: 'fixture', requestHash: 'r', resultHash: 'x', isError: 0 },
  ],
}));
vi.mock('../callback-incident-evidence.js', async (original) => {
  const actual = await original<typeof import('../callback-incident-evidence.js')>();
  return {
    ...actual,
    callbackIncident: {
      ...actual.callbackIncident,
      toolsHash: actual.incidentHash(JSON.stringify(mock.receipts)),
    },
    readCallbackIncidentEvidence: mock.evidence,
    inspectCallbackIncidentToolEvents: vi.fn(() => 'f'.repeat(64)),
  };
});
import { callbackIncident as incident } from '../callback-incident-evidence.js';
import { createCallbackIncidentRepairRouter } from '../callback-incident-repair.js';

function fixture() {
  mock.evidence.mockReset().mockReturnValue('e'.repeat(64));
  const binding = {
    accountId: 'work-openai',
    provider: 'openai',
    profileRevision: '102a20a80da4ff7425a6c68fb023b9b55cfd8fea2b4f2f746a9d54f42eab8f24',
  };
  const meta = {
    accountBinding: binding,
    repositoryWorkspaceId: incident.workspaceId,
    cwd: '/offline',
  };
  const runtime = {
    harness: { implementation: 'codex' },
    execution: {
      location: 'local',
      targetId: 'host-mac-codex',
      targetRevision: '5dfe0f4b100dcd3a12523aeba65d8355853b1b5d7ca8fef85d7a07ba7579062f',
    },
  };
  const releaseHold = vi.fn();
  const events = {
    reserveOrdinaryStartup: vi.fn(() => releaseHold),
    getSession: vi.fn(() => meta),
    getSessionRuntimeBinding: vi.fn(() => runtime),
    getLatestEvent: vi.fn(() => null),
    hasUncertainOrdinaryCommand: vi.fn(() => false),
    getEventsAfter: vi.fn(() => [{ seq: incident.terminalSeq, type: 'session_end' }]),
    getEventsOfType: vi.fn(() => []),
  };
  const native = {
    readHostCustody: vi.fn(() => ({ login: { homeRoot: { dev: 1, ino: 1 } } })),
    read: vi.fn(() => ({ cwd: '/offline' })),
    inspectCallbackIncident: vi.fn(() => 'a'.repeat(64)),
    callbackIncidentToolReceipts: vi.fn(() => mock.receipts),
    applyCallbackIncident: vi.fn(() => ({ status: 'reconciled' })),
  };
  const registry = { findBySessionId: vi.fn(() => undefined) };
  const authorize = vi.fn((_id, auth) => {
    if (!auth) throw Error('login required');
  });
  const enabled = vi.fn(() => true);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-operator']) res.locals.authSession = { id: 'operator' };
    next();
  });
  app.use(
    '/api/sessions',
    createCallbackIncidentRepairRouter({
      enabled,
      originalSourceRoot: () => '/fixed/source',
      events: events as never,
      native: () => native as never,
      registry,
      authorize,
    }),
  );
  const post = (action: string, body: object = {}, auth = true, id = incident.sessionId) => {
    const call = request(app)
      .post(`/api/sessions/${id}/codex-callback-repair/${action}`)
      .send(body);
    if (auth) call.set('X-Operator', '1');
    return call;
  };
  return { post, events, native, registry, authorize, releaseHold, enabled };
}
it('is disabled by default integration selection and rejects another session, unknown bodies, untrusted origins and missing operator', async () => {
  const f = fixture();
  f.enabled.mockReturnValue(false);
  await f.post('inspect').expect(404);
  f.enabled.mockReturnValue(true);
  await f.post('inspect', {}, true, 'other').expect(404);
  await f.post('inspect', { force: true }).expect(400);
  await f.post('inspect').set('Origin', 'https://untrusted.invalid').expect(403);
  await f.post('inspect', {}, false).expect(403);
  expect(f.native.inspectCallbackIncident).not.toHaveBeenCalled();
});
it('inspects under the real startup fence, then rechecks exact evidence and applies without dispatch or queue consumption', async () => {
  const f = fixture();
  mock.evidence.mockImplementation(() => {
    expect(() => reserveRepositoryStartup(incident.sessionId)).toThrow();
    return 'e'.repeat(64);
  });
  const inspected = await f.post('inspect').expect(200);
  expect(inspected.body).toMatchObject({
    status: 'inspection_only',
    providerCalls: 0,
    queuedMessages: 2,
  });
  expect(f.native.applyCallbackIncident).not.toHaveBeenCalled();
  await f
    .post('apply', { planHash: inspected.body.planHash })
    .expect(200)
    .expect(({ body }) => {
      expect(body).toMatchObject({ status: 'reconciled', dispatched: false, providerCalls: 0 });
    });
  expect(f.native.applyCallbackIncident).toHaveBeenCalledOnce();
  expect(f.releaseHold).toHaveBeenCalledTimes(2);
  const release = reserveRepositoryStartup(incident.sessionId);
  release();
});
it.each(['native', 'source', 'live owner', 'worker', 'route', 'new startup'])(
  'refuses changed %s and preserves original work',
  async (change) => {
    const f = fixture();
    const inspected = await f.post('inspect').expect(200);
    let release: (() => void) | undefined;
    if (change === 'native') f.native.inspectCallbackIncident.mockReturnValue('b'.repeat(64));
    if (change === 'source')
      mock.evidence.mockImplementation(() => {
        throw Error('changed');
      });
    if (change === 'live owner') f.registry.findBySessionId.mockReturnValue({} as never);
    if (change === 'worker') f.events.getLatestEvent.mockReturnValue({} as never);
    if (change === 'route')
      f.events.getSessionRuntimeBinding.mockReturnValue({
        harness: { implementation: 'codex' },
        execution: { location: 'local', targetId: 'other', targetRevision: 'other' },
      });
    if (change === 'new startup') release = reserveRepositoryStartup(incident.sessionId);
    try {
      const refused = await f.post('apply', { planHash: inspected.body.planHash }).expect(409);
      expect(refused.body.runtimeFailure).toMatchObject({
        runtimeFailureCode: 'repair_refused',
        diagnosticId: expect.any(String),
      });
      expect(refused.body.error).toContain('Reference:');
      expect(refused.body.repairReason).toBe(
        (
          {
            native: 'stale_plan',
            source: 'source_native_evidence',
            'live owner': 'owner',
            worker: 'owner',
            route: 'owner',
            'new startup': 'startup_busy',
          } as Record<string, string>
        )[change],
      );
      expect(f.native.applyCallbackIncident).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  },
);
it('does not apply when an owner appears during evidence inspection', async () => {
  const f = fixture();
  const inspected = await f.post('inspect').expect(200);
  mock.evidence.mockImplementation(() => {
    f.registry.findBySessionId.mockReturnValue({} as never);
    return 'e'.repeat(64);
  });
  await f.post('apply', { planHash: inspected.body.planHash }).expect(409);
  expect(f.native.applyCallbackIncident).not.toHaveBeenCalled();
});
