import express from 'express';
vi.mock('../internal-token.js', () => ({
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
}));
import { operatorAuthMiddleware, registerAuthSession, revokeAuthSession } from '../auth.js';
import { createCustodianProxy } from '../symposium-custodian-proxy.js';
import { expect, it, vi } from 'vitest';
import * as evidence from '../symposium-owned-evidence.js';
import { dispatchCustodianHttp } from '../symposium-custodian-http.js';
import type { CustodianRequest } from '../symposium-custodian-protocol.js';
import { selectCustodianOperation } from '../symposium-custodian-protocol.js';
const path = '/api/symposium/sessions/original/admission-evidence';
function harness(
  collect = vi.fn(async (_input: unknown, current: () => void) => {
    current();
    return { candidate: Object.freeze({ original: true }), assertCurrent: async () => current() };
  }),
) {
  const app = express();
  app.use(express.json());
  app.use(operatorAuthMiddleware);
  app.post(
    '/api/symposium/sessions/:sessionId/admission-evidence',
    evidence.sessionOwnedEvidenceHandler(
      () => collect as never,
      (req, res) =>
        evidence.sessionEvidenceRequestAuthority(req, res, {
          session: res.locals.authSession,
          hasSession: (id) => id === 'original',
          register: registerAuthSession,
        }),
    ),
  );
  let current = true;
  const command: CustodianRequest = {
    operation: 'session.admissionEvidence',
    sessionId: 'original',
    epoch: 1,
    requestId: 'exact',
    authorization: { id: `original-auth-${Math.random()}`, expiresAt: Date.now() + 30000 },
    body: { configRevision: 1 },
    query: {},
  };
  return {
    app,
    collect,
    command,
    revoke: () => {
      current = false;
    },
    run: () =>
      dispatchCustodianHttp(app, command, () => {
        if (!current) throw Error('revoked');
      }),
  };
}
it('adds the exact closed canonical operation', () => {
  expect(selectCustodianOperation('POST', path)).toEqual({
    operation: 'session.admissionEvidence',
    sessionId: 'original',
  });
});
it('actual retained dispatcher invokes only original session binding and returns candidate without activation', async () => {
  const f = harness();
  expect(await f.run()).toEqual({
    status: 200,
    body: { candidate: { original: true }, activated: false },
  });
  expect(f.collect.mock.calls[0][0]).toEqual({ sessionId: 'original', configRevision: 1 });
});
it.each([
  'artifactVolume',
  'providerInstances',
  'allowedRoles',
  'allowedAccountProviders',
  'buildSelection',
  'sessionId',
])('refuses caller %s before collection', async (key) => {
  const f = harness();
  f.command.body[key] = 'caller';
  expect((await f.run()).status).toBe(400);
  expect(f.collect).not.toHaveBeenCalled();
});
it('refuses query fields', async () => {
  const f = harness();
  f.command.query.override = 'yes';
  expect((await f.run()).status).toBe(400);
  expect(f.collect).not.toHaveBeenCalled();
});
it('does not return candidate after original request revocation during collection', async () => {
  const f = harness();
  f.collect.mockImplementationOnce(async (_input, current) => {
    f.revoke();
    current();
    return {} as never;
  });
  await expect(f.run()).rejects.toThrow('revoked');
});
it('does not return candidate after expiry during collection', async () => {
  const f = harness();
  const originalDeadline = f.command.authorization.expiresAt;
  const clock = vi.spyOn(Date, 'now');
  f.collect.mockImplementationOnce(async (_input, current) => {
    clock.mockReturnValue(originalDeadline + 1);
    return {
      candidate: Object.freeze({ original: true as const }),
      assertCurrent: async () => current(),
    };
  });
  try {
    expect((await f.run()).status).toBe(409);
  } finally {
    clock.mockRestore();
  }
});
it('preserves owner failure as finite denied candidate response', async () => {
  const f = harness();
  f.collect.mockRejectedValueOnce(Error('private-owner-detail'));
  const r = await f.run();
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).not.toContain('private-owner-detail');
});

it('actual canonical proxy forwards only retained interactive authority to the original route', async () => {
  const f = harness();
  const proxy = express();
  proxy.use(express.json());
  const invoke = vi.fn(async (input: Omit<CustodianRequest, 'epoch'>) =>
    dispatchCustodianHttp(f.app, { ...input, epoch: 1 }, () => {}),
  );
  proxy.use(createCustodianProxy({ request: invoke, invalidate: vi.fn() }));
  const result = await dispatchCustodianHttp(proxy, f.command, () => {});
  expect(result).toEqual({
    status: 200,
    body: { candidate: { original: true }, activated: false },
  });
  expect(invoke.mock.calls[0][0]).toMatchObject({
    operation: 'session.admissionEvidence',
    sessionId: 'original',
    body: { configRevision: 1 },
    authorization: { id: f.command.authorization.id },
  });
});
it('real interactive revocation hook refuses an awaited candidate without epoch-fake revocation', async () => {
  const f = harness();
  f.collect.mockImplementationOnce(async () => {
    revokeAuthSession(f.command.authorization);
    return { candidate: { original: true as const }, assertCurrent: async () => {} };
  });
  expect((await f.run()).status).toBe(409);
});
it('foreign original session refuses before owner collection', async () => {
  const f = harness();
  f.command.sessionId = 'foreign';
  expect((await f.run()).status).toBe(409);
  expect(f.collect).not.toHaveBeenCalled();
});

it('the captured original request callback is revoked by semantic response completion', async () => {
  const f = harness();
  let held: (() => void) | undefined;
  f.collect.mockImplementationOnce(async (_input, current) => {
    held = current;
    return {
      candidate: Object.freeze({ original: true as const }),
      assertCurrent: async () => current(),
    };
  });
  expect((await f.run()).status).toBe(200);
  expect(() => held!()).toThrow('authorization expired');
});
