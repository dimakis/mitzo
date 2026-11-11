import { join } from 'node:path';
import { homedir } from 'node:os';
import { createAppleSignIn } from './apple-sign-in.js';
import { AppleOwnerStore } from './apple-owner-store.js';
import { createAppleVerifier, loadAppleSignInConfig } from './apple-sign-in-provider.js';
import { createAppleSignInRouter } from './apple-sign-in-router.js';
import { issueOperatorSession, verifyPassphrase, COOKIE_NAME, MAX_AGE_HOURS } from './auth.js';
import { createLogger } from './logger.js';

/** Mounted before ordinary API auth and body parsing. Disabled deployments never
 * open a store, read a signing key or contact Apple. Tailscale is unchanged. */
export function configuredAppleSignInRouter() {
  const config = loadAppleSignInConfig(process.env);
  const log = createLogger('apple-sign-in');
  const service = config
    ? createAppleSignIn({
        config,
        // Host-private identity state must not live in an agent-writable repository.
        store: new AppleOwnerStore(join(homedir(), '.mitzo', 'apple-sign-in', 'owner.json')),
        verify: createAppleVerifier(config),
        issueSession: issueOperatorSession,
        verifyPassphrase,
      })
    : null;
  return createAppleSignInRouter({
    service,
    config,
    cookieName: COOKIE_NAME,
    maxAgeHours: MAX_AGE_HOURS,
    warn: (message, fields) => log.warn(message, fields),
  });
}
