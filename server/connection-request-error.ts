import { CredentialVerificationError } from './credential-verification-error.js';

const errors = {
  response_too_large: [
    'Response exceeded the connection size limit. Use a narrower endpoint or the published inventory; do not repeat the same request.',
    'after_change',
  ],
  authentication_failed: [
    'The service rejected authentication. Update the credential securely before retrying.',
    'after_change',
  ],
  access_denied: [
    'The service denied access. Check account permissions before retrying.',
    'after_change',
  ],
  destination_blocked: [
    'The destination is outside approved network access. Correct the connection scope before retrying.',
    'after_change',
  ],
  redirect: [
    'The service redirected the request. Use its direct API address; credentials were not forwarded.',
    'after_change',
  ],
  tls_failed: [
    'A trusted HTTPS connection could not be established. Check the service certificate.',
    'after_change',
  ],
  timeout: ['The connection request timed out.', 'later'],
  network_failed: ['The service could not be reached or the connection was interrupted.', 'later'],
  service_unavailable: ['The service is temporarily unavailable or rate limited.', 'later'],
  cancelled: ['Connection request cancelled', 'after_change'],
  request_failed: ['Connection request failed', 'after_change'],
} as const;
export type ConnectionRequestErrorCode = keyof typeof errors;

/** Public diagnostics use fixed messages only; never retain upstream errors or bodies. */
export class ConnectionRequestError extends Error {
  constructor(
    readonly code: ConnectionRequestErrorCode,
    readonly mayHaveApplied = false,
  ) {
    super(errors[code][0]);
    this.name = 'ConnectionRequestError';
  }
  toResult() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retry: this.mayHaveApplied ? 'verify_state' : errors[this.code][1],
        mayHaveApplied: this.mayHaveApplied,
      },
    };
  }
}

export function connectionRequestError(error: unknown, signal: AbortSignal, method: string) {
  const write = !['GET', 'HEAD'].includes(method);
  if (error instanceof ConnectionRequestError)
    return new ConnectionRequestError(error.code, write || error.mayHaveApplied);
  if (signal.aborted)
    return new ConnectionRequestError(
      signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
      write,
    );
  if (error instanceof CredentialVerificationError) {
    const mapped = {
      credential_rejected: 'authentication_failed',
      access_denied: 'access_denied',
      destination_blocked: 'destination_blocked',
      redirect: 'redirect',
      tls_failed: 'tls_failed',
      timeout: 'timeout',
      service_unavailable: 'service_unavailable',
      response_too_large: 'response_too_large',
    } as const;
    if (Object.hasOwn(mapped, error.code))
      return new ConnectionRequestError(mapped[error.code as keyof typeof mapped], write);
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string') {
    if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT')
      return new ConnectionRequestError('timeout', write);
    if (
      /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(
        code,
      )
    )
      return new ConnectionRequestError('tls_failed', write);
    if (
      [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ECONNRESET',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'EPIPE',
      ].includes(code)
    )
      return new ConnectionRequestError('network_failed', write);
  }
  return new ConnectionRequestError('request_failed', write);
}
