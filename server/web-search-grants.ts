import { isDeepStrictEqual } from 'node:util';
import type { ManagedSession } from '@mitzo/harness';

const grants = new WeakMap<
  ManagedSession,
  { account: ManagedSession['accountBinding']; model: ManagedSession['model'] }
>();
const revisions = new WeakMap<ManagedSession, number>();
export const webSearchGrantRevision = (session: ManagedSession) => revisions.get(session) ?? 0;
export function clearWebSearchGrant(session: ManagedSession) {
  grants.delete(session);
  revisions.set(session, webSearchGrantRevision(session) + 1);
}
export function hasWebSearchGrant(session: ManagedSession): boolean {
  const grant = grants.get(session);
  if (!grant) return false;
  if (!isDeepStrictEqual(grant.account, session.accountBinding) || grant.model !== session.model) {
    clearWebSearchGrant(session);
    return false;
  }
  return true;
}
export function saveWebSearchGrant(session: ManagedSession) {
  grants.set(session, { account: structuredClone(session.accountBinding), model: session.model });
}
