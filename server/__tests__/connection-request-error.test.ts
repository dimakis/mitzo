import { expect, it } from 'vitest';
import { connectionRequestError, ConnectionRequestError } from '../connection-request-error.js';
import { CredentialVerificationError } from '../credential-verification-error.js';

it('keeps transport diagnostics useful without retaining raw upstream details', () => {
  const signal = new AbortController().signal;
  for (const [code, expected] of [
    ['ENOTFOUND', 'network_failed'],
    ['ETIMEDOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
  ]) {
    const error = connectionRequestError(
      Object.assign(new Error('Bearer private-token https://private/'), { code }),
      signal,
      'GET',
    );
    expect(error.code).toBe(expected);
    expect(JSON.stringify(error.toResult())).not.toContain('private');
    expect(error.cause).toBeUndefined();
  }
  expect(
    connectionRequestError(new CredentialVerificationError('destination_blocked'), signal, 'GET')
      .code,
  ).toBe('destination_blocked');
});

it('marks deterministic failures as requiring a change and interrupted writes as unconfirmed', () => {
  const signal = new AbortController().signal;
  expect(new ConnectionRequestError('response_too_large').toResult()).toMatchObject({
    error: { code: 'response_too_large', retry: 'after_change', mayHaveApplied: false },
  });
  const error = connectionRequestError(
    Object.assign(new Error('secret'), { code: 'ECONNRESET' }),
    signal,
    'POST',
  );
  expect(error.toResult()).toMatchObject({
    error: { code: 'network_failed', retry: 'verify_state', mayHaveApplied: true },
  });
  expect(connectionRequestError(new Error('secret'), signal, 'GET').toResult()).toMatchObject({
    error: { code: 'request_failed', retry: 'after_change' },
  });
});

it('distinguishes a deadline from user cancellation', () => {
  const deadline = new AbortController();
  deadline.abort(new DOMException('private upstream details', 'TimeoutError'));
  expect(connectionRequestError(new Error('secret'), deadline.signal, 'GET').code).toBe('timeout');
  const cancelled = new AbortController();
  cancelled.abort();
  expect(connectionRequestError(new Error('secret'), cancelled.signal, 'GET').code).toBe(
    'cancelled',
  );
});
