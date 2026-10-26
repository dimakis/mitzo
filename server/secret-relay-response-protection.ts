import { redactCredentialResponse } from './credential-redaction.js';
import type { CredentialConnectionStore } from './credential-connections.js';
import type { SecretVaultReference } from './openshell-secret-vault.js';

/** Retained privacy obligations survive execution flags, cancellation and restart. */
export async function protectSecretRelayResponse(
  store: CredentialConnectionStore,
  connectionId: string,
  endpoint: string,
  body: string,
  signal: AbortSignal,
  resolve?: (ref: SecretVaultReference, signal: AbortSignal) => Promise<string>,
) {
  const relays = store
    .listRelays()
    .filter(
      (r) =>
        r.targets.some(
          (t) =>
            ('connectionId' in t && t.connectionId === connectionId) || t.endpoint === endpoint,
        ) &&
        (r.vaultRef ||
          ['verifying', 'unconfirmed'].includes(r.status) ||
          r.outcomes.some((o) => o.outcome !== 'not_sent')),
    );
  // Browser cookies/codes are never exported for redaction. Withhold the origin's
  // general API/WS responses even after the private browser has been revoked.
  if (
    relays.some((r) =>
      r.targets.some(
        (t, index) =>
          'adapter' in t &&
          t.adapter === 'browser' &&
          t.endpoint === endpoint &&
          r.outcomes[index]?.outcome !== 'not_sent',
      ),
    )
  )
    throw new Error(
      'Response withheld for an origin used by a private browser session; use reviewed browser verification',
    );
  try {
    for (const relay of relays) {
      if (!resolve || !relay.vaultRef) throw new Error();
      body = redactCredentialResponse(body, await resolve(relay.vaultRef, signal), {});
    }
    signal.throwIfAborted();
    return body;
  } catch {
    throw new Error('Response withheld because private relay redaction is unavailable');
  }
}
