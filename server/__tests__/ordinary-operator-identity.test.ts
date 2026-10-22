import { afterEach, expect, it } from 'vitest';
import { login, authenticateToken, revokeAuthSession } from '../auth.js';
import { ordinaryOperatorOwnsConversation } from '../ordinary-operator-identity.js';
import type { AuthSession } from '../auth.js';
const sessions: AuthSession[] = [];
afterEach(() => sessions.splice(0).forEach(revokeAuthSession));
async function signedIn() {
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const session = await authenticateToken(token!);
  if (!session) throw Error('Fixture authentication failed');
  sessions.push(session);
  return session;
}
it('recognizes separate verified logins as the same single Mitzo operator', async () => {
  const phone = await signedIn(),
    web = await signedIn();
  expect(phone.id).not.toBe(web.id);
  expect(ordinaryOperatorOwnsConversation(phone.id, web.id)).toBe(true);
  // The creating token is provenance; reauthentication does not rewrite history.
  expect(ordinaryOperatorOwnsConversation('retained-creating-login', web.id)).toBe(true);
});
it('does not accept a forged, internal or revoked login as the interactive operator', async () => {
  const actor = await signedIn();
  expect(ordinaryOperatorOwnsConversation('original', 'forged-client-id')).toBe(false);
  revokeAuthSession(actor);
  expect(ordinaryOperatorOwnsConversation('original', actor.id)).toBe(false);
});
