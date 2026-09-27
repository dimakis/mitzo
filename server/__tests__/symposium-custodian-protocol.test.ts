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
