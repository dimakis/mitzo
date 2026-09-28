import { describe, expect, it } from 'vitest';
import {
  decodeCustodianRequest,
  selectCustodianOperation,
  custodianRoute,
} from '../symposium-custodian-protocol.js';

describe('finite custodian protocol', () => {
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
