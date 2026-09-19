export function requireTlsForProduction(env: NodeJS.ProcessEnv): boolean {
  const configured = env.MITZO_REQUIRE_TLS;
  if (configured === undefined || configured === '' || configured === '0') return false;
  if (configured === '1') return true;
  throw new Error('MITZO_REQUIRE_TLS must be 0 or 1');
}

export function assertTlsAvailable(env: NodeJS.ProcessEnv, certificatesAvailable: boolean): void {
  if (requireTlsForProduction(env) && !certificatesAvailable) {
    throw new Error('MITZO_REQUIRE_TLS=1 requires both the TLS certificate and private key');
  }
}

/**
 * The watchOS compatibility endpoint intentionally remains available for local
 * development with self-signed certificates.  A production release that
 * requires TLS must never expose the same application over plaintext HTTP.
 */
export function shouldStartPlaintextWatchOsListener(
  env: NodeJS.ProcessEnv,
  certificatesAvailable: boolean,
): boolean {
  return certificatesAvailable && !requireTlsForProduction(env);
}
