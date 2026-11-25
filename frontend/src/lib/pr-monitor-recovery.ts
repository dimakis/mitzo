import type { PrMonitorAuthority, PrMonitorProjection } from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';

export type PrRegistrationRequest = {
  requestId: string;
  connectionId: string;
  connectionRevision: number;
  owner: string;
  name: string;
  pr: number;
  expectedExecutionDigest: string;
};
export type PrWatchRequest = {
  requestId: string;
  expectedRevision: number;
  expectedAuthorityRevision: number;
  durationMinutes: number;
  reviewedScope: PrMonitorAuthority['scope'];
};
type Recovery = {
  registration?: PrRegistrationRequest;
  watch: Map<string, PrWatchRequest>;
  revoke: Map<string, NonNullable<PrMonitorProjection['revocationPending']>>;
};
// Unresolved browser requests survive closing a details sheet. This is not an
// authority cache: every retry is explicit and goes to the existing owner. No
// passphrase/CSRF/login credential is retained, and identity changes discard it.
// Full page reloads rely on the server's durable revocation checkpoint/status.
const pending = new Map<string, Recovery>();
export function prMonitorRecovery(sessionId: string): Recovery {
  let entry = pending.get(sessionId);
  if (!entry) {
    entry = { watch: new Map(), revoke: new Map() };
    pending.set(sessionId, entry);
  }
  return entry;
}
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => pending.clear());
  window.addEventListener(AUTH_RESTORED_EVENT, () => pending.clear());
}
