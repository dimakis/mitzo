/** Only these fixed messages/codes may cross the credential verification boundary. */
const messages = {
  response_too_large:
    'The service response exceeded the connection size limit. Use a narrower API endpoint.',
  credential_rejected:
    'The service rejected this key. Check that you copied the complete key from this service, then retry.',
  access_denied: 'The service refused access. Check the key’s account permissions, then retry.',
  service_unreachable:
    'Mitzo could not reach the service. Check the service address and its network connection, then retry.',
  service_unavailable: 'The service is temporarily unavailable. Try again later.',
  destination_blocked:
    'This service address is blocked by the connection’s network permissions. Return to the chat to correct the setup.',
  tls_failed:
    'Mitzo could not establish a trusted secure connection. Check the service’s HTTPS certificate.',
  redirect:
    'The service redirected verification. Return to the chat and use the service’s direct API address.',
  timeout: 'Connection verification timed out. Check the service connection, then retry.',
  verification_endpoint:
    'This address did not require authentication. Return to the chat to select a protected API endpoint.',
  unexpected_response:
    'The service did not return the expected API response. Return to the chat to check the service address and setup.',
  keychain_locked:
    'The service accepted the key, but Apple Keychain is locked. Unlock Keychain on the Mac running Mitzo, then retry.',
  storage_unavailable:
    'The service accepted the key, but Mitzo could not save it in Apple Keychain. Check Keychain on the Mac running Mitzo, then retry.',
  save_failed:
    'Mitzo could not finish saving the connection. Refresh the setup status before retrying.',
  setup_unavailable:
    'Setup authorization expired or the originating chat is unavailable. Return to that chat and retry.',
  interrupted: 'Verification was interrupted when Mitzo restarted. Enter your key again to retry.',
} as const;
export type VerificationErrorCode = keyof typeof messages;
export class CredentialVerificationError extends Error {
  constructor(readonly code: VerificationErrorCode) {
    super(messages[code]);
    this.name = 'CredentialVerificationError';
  }
}
/** Raw errors may contain credentials, response bodies and private addresses. Never retain them. */
export function verificationTransportError(error: unknown, signal: AbortSignal) {
  if (error instanceof CredentialVerificationError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (signal.aborted || code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT')
    return new CredentialVerificationError('timeout');
  if (
    typeof code === 'string' &&
    /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(
      code,
    )
  )
    return new CredentialVerificationError('tls_failed');
  return new CredentialVerificationError('service_unreachable');
}
