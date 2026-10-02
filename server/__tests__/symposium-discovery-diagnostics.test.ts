import { expect, it } from 'vitest';
import {
  classifyDiscoveryCommandFailure,
  classifyDiscoveryFailure,
  DiscoveryDiagnosticSchema,
  DiscoveryNativeMetadataFailure,
} from '../symposium-discovery-diagnostics.js';
import { CodexRequestError, CodexTransportError } from '../codex-app-server-client.js';
import { SubscriptionRoutingIdentityError } from '../symposium-subscription-identity.js';
it.each([
  [new CodexTransportError('timeout'), 'rpc_timeout'],
  [new CodexTransportError('connection'), 'rpc_connection'],
  [new CodexTransportError('protocol'), 'rpc_protocol'],
  [new SubscriptionRoutingIdentityError('routing_identity_missing'), 'routing_identity_missing'],
  [new SubscriptionRoutingIdentityError('routing_identity_mismatch'), 'routing_identity_mismatch'],
  [new DiscoveryNativeMetadataFailure('account_schema'), 'account_schema'],
  [new DiscoveryNativeMetadataFailure('account_authentication'), 'account_authentication'],
] as const)('projects typed failure %# without raw data', (error, nativeFailure) => {
  expect(classifyDiscoveryFailure(error)).toEqual({
    failureClass: 'operation-failed',
    commandDispatch: 'not-observed',
    nativeFailure,
  });
});
it('does not infer failure from generic Error text or retain an unbounded RPC code', () => {
  expect(
    classifyDiscoveryFailure(new Error('workspace routing discovery timed out SECRET')),
  ).toEqual({ failureClass: 'operation-failed', commandDispatch: 'not-observed' });
  expect(
    classifyDiscoveryFailure(new CodexRequestError('account/read', 'unknown', 2 ** 40)),
  ).not.toHaveProperty('rpcCode');
});
it('accepts legacy receipts and rejects arbitrary diagnostic fields or categories', () => {
  const old = {
    stage: 'account-read',
    createDispatch: 'possibly-dispatched',
    failureClass: 'operation-failed',
    commandDispatch: 'not-observed',
    recordedAt: '2026-09-30T14:04:45.250Z',
  };
  expect(DiscoveryDiagnosticSchema.parse(old)).toEqual(old);
  for (const unsafe of [{ nativeFailure: 'SECRET' }, { rpcCode: 2 ** 40 }, { accountId: 'SECRET' }])
    expect(DiscoveryDiagnosticSchema.safeParse({ ...old, ...unsafe }).success).toBe(false);
});
it.each([
  [{ code: 'ENOENT' }, undefined, 'spawn-failed', 'not-started'],
  [{ code: 'EACCES' }, undefined, 'spawn-failed', 'not-started'],
  [{ code: 'ENOENT' }, 123, 'transport-or-process-failure', 'possibly-started'],
  [{ code: 1 }, 123, 'nonzero-exit', 'possibly-started'],
  [{ code: 'ETIMEDOUT' }, 123, 'timeout', 'possibly-started'],
  [{ killed: true, signal: 'SIGTERM' }, 123, 'timeout', 'possibly-started'],
  [{ code: 'ECONNRESET' }, 123, 'transport-or-process-failure', 'possibly-started'],
] as const)(
  'classifies process outcome without exposing errors %#',
  (error, pid, failureClass, commandDispatch) => {
    const result = classifyDiscoveryCommandFailure(
      { ...error, message: 'SECRET', stderr: 'TOKEN', cmd: 'PRIVATE' },
      pid,
    );
    expect(result.detail).toMatchObject({ failureClass, commandDispatch });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|TOKEN|PRIVATE/);
  },
);
