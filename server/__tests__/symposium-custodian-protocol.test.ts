import { describe, expect, it } from 'vitest';
import {
  decodeCustodianRequest,
  selectCustodianOperation,
  custodianRoute,
} from '../symposium-custodian-protocol.js';

describe('finite custodian protocol', () => {
  it('round-trips only the exact read-only configuration receipt and bounded stage key', () => {
    const sessionId = 'session-1';
    const resourceId = 'original-key:revise';
    const path = `/api/sessions/${sessionId}/symposium/configuration-operations/${resourceId}`;
    const selected = selectCustodianOperation('GET', path);
    expect(selected).toEqual({
      operation: 'director.configurationOperation',
      sessionId,
      resourceId,
    });
    expect(custodianRoute(selected!)).toEqual({ method: 'GET', path });
    const decoded = decodeCustodianRequest({
      ...selected,
      requestId: 'lookup-1',
      epoch: 1,
      body: {},
      query: {},
      authorization: { id: 'verified-operator', expiresAt: 1000 },
    });
    expect(decoded.resourceId).toBe(resourceId);
    const browserKey = 'original-operation-revise';
    expect(
      selectCustodianOperation('GET', path.replace(resourceId, encodeURIComponent(browserKey))),
    ).toEqual({ operation: 'director.configurationOperation', sessionId, resourceId: browserKey });
    expect(
      selectCustodianOperation('GET', path.replace(resourceId, 'k'.repeat(200))),
    ).not.toBeNull();
    for (const invalid of ['a/b', 'a%2Fb', 'a b', '_leading', 'é-key', 'k'.repeat(201)]) {
      expect(selectCustodianOperation('GET', path.replace(resourceId, invalid))).toBeNull();
      expect(() => decodeCustodianRequest({ ...decoded, resourceId: invalid })).toThrow();
    }
    expect(selectCustodianOperation('POST', path)).toBeNull();
    expect(selectCustodianOperation('GET', `${path}/extra`)).toBeNull();
    expect(() => decodeCustodianRequest({ ...decoded, revision: '1' })).toThrow();
    expect(() =>
      decodeCustodianRequest({ ...decoded, body: { actor: 'operator:forged' } }),
    ).toThrow();
  });

  it('routes the durable director projection through one exact read-only operation', () => {
    const path = '/api/sessions/s-1/symposium/status';
    expect(selectCustodianOperation('GET', path)).toEqual({
      operation: 'director.durableStatus',
      sessionId: 's-1',
    });
    expect(custodianRoute({ operation: 'director.durableStatus', sessionId: 's-1' })).toEqual({
      method: 'GET',
      path,
    });
    expect(selectCustodianOperation('POST', path)).toBeNull();
    expect(selectCustodianOperation('GET', `${path}/extra`)).toBeNull();
  });
  it('maps supported routes to semantic operations without accepting arbitrary paths', () => {
    expect(
      selectCustodianOperation('POST', '/api/sessions/s-1/symposium/deliveries/d-1/dispatch'),
    ).toEqual({ operation: 'delivery.dispatch', sessionId: 's-1', resourceId: 'd-1' });
    expect(
      custodianRoute({ operation: 'delivery.dispatch', sessionId: 's-1', resourceId: 'd-1' }),
    ).toEqual({ method: 'POST', path: '/api/sessions/s-1/symposium/deliveries/d-1/dispatch' });
    for (const path of [
      '/api/exec',
      '/api/sessions/../symposium',
      '/api/sessions/s/symposium/deliveries/d/dispatch/extra',
    ])
      expect(selectCustodianOperation('POST', path)).toBeNull();
    expect(selectCustodianOperation('GET', '/api/symposium/custody')).toEqual({
      operation: 'custody.status',
    });
    expect(
      selectCustodianOperation('POST', '/api/sessions/s-1/symposium/source/seal/recover'),
    ).toEqual({ operation: 'source.sealRecover', sessionId: 's-1' });
    expect(custodianRoute({ operation: 'source.sealRecover', sessionId: 's-1' })).toEqual({
      method: 'POST',
      path: '/api/sessions/s-1/symposium/source/seal/recover',
    });
  });
  it('maps only the bounded interactive review routes and their exact identities', () => {
    const base = '/api/sessions/s-1/symposium/reviews';
    const cases = [
      ['GET', base, 'review.list', undefined],
      ['POST', `${base}/application-runs`, 'review.startApplication', undefined],
      ['GET', `${base}/flow-1`, 'review.workflow', 'flow-1'],
      ['POST', `${base}/flow-1/actions`, 'review.action', 'flow-1'],
      ['GET', `${base}/records/record-1`, 'review.record', 'record-1'],
      [
        'POST',
        `${base}/records/record-1/publication-preflight`,
        'review.publicationPreflight',
        'record-1',
      ],
    ] as const;
    for (const [method, path, operation, resourceId] of cases) {
      const selected = selectCustodianOperation(method, path);
      expect(selected).toEqual({
        operation,
        sessionId: 's-1',
        ...(resourceId ? { resourceId } : {}),
      });
      expect(custodianRoute(selected!)).toEqual({ method, path });
    }
    for (const [method, path] of [
      ['POST', base],
      ['GET', `${base}/flow-1/actions`],
      ['POST', `${base}/records/record-1`],
      ['POST', `${base}/flow-1/export`],
      ['GET', `${base}/records/record-1/publication-preflight`],
      ['POST', `${base}/flow-1/actions/extra`],
    ])
      expect(selectCustodianOperation(method, path)).toBeNull();
  });
  it('rejects reflection, host paths, caller authentication and unbounded envelopes', () => {
    const valid = {
      requestId: 'r1',
      epoch: 1,
      operation: 'director.status',
      sessionId: 's1',
      body: {},
      query: {},
      authorization: { id: 'verified-jti', expiresAt: 1000 },
    };
    expect(decodeCustodianRequest(valid).authorization.id).toBe('verified-jti');
    for (const extra of [
      { path: '/private' },
      { method: 'exec' },
      { callback: 'assert' },
      { body: { actor: 'operator:other' } },
      { body: { authSession: {} } },
      { body: { prompt: 'x'.repeat(1_048_577) } },
    ])
      expect(() => decodeCustodianRequest({ ...valid, ...extra })).toThrow();
    expect(() => decodeCustodianRequest({ ...valid, operation: 'constructor' })).toThrow();
    expect(() => decodeCustodianRequest({ ...valid, sessionId: '../../secret' })).toThrow();
  });
});

it('transports only the seat access listing, exact decisions and dismissals', () => {
  expect(selectCustodianOperation('GET', '/api/sessions/s/symposium/access-requests')).toEqual({
    operation: 'access.list',
    sessionId: 's',
  });
  expect(
    selectCustodianOperation('POST', '/api/sessions/s/symposium/access-requests/r/decision'),
  ).toEqual({ operation: 'access.decide', sessionId: 's', resourceId: 'r' });
  expect(
    selectCustodianOperation('POST', '/api/sessions/s/symposium/access-requests/r/fetch'),
  ).toBeNull();
});
