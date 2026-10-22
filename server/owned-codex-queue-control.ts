import { isDeepStrictEqual } from 'node:util';
import { ordinaryOperatorOwnsConversation } from './ordinary-operator-identity.js';
import type { AccountBinding, SessionRuntimeBinding } from '@mitzo/protocol';
import { hasPersistentRevocationAuthority, registerAuthSession, type AuthSession } from './auth.js';
interface Custody {
  authSessionId: string;
  binding?: SessionRuntimeBinding;
}
interface Owners {
  runtimeBinding(id: string): SessionRuntimeBinding | null | undefined;
  accountBinding(id: string): AccountBinding | null | undefined;
  custody(
    id: string,
    account: AccountBinding,
    binding: SessionRuntimeBinding,
  ): Custody | null | undefined;
}
/** Queue mutations require the native conversation's original operator, including cold controls. */
export function assertOwnedCodexQueueControl(owners: Owners, id: string, auth?: AuthSession): void {
  const binding = owners.runtimeBinding(id);
  if (!binding) return;
  if (!auth || auth.expiresAt <= Date.now() || !hasPersistentRevocationAuthority())
    throw Error('Original signed operator required');
  let revoked = false;
  const release = registerAuthSession(auth, () => {
    revoked = true;
  });
  try {
    const account = owners.accountBinding(id);
    if (
      revoked ||
      !account ||
      !isDeepStrictEqual(binding.account, {
        accountId: account.accountId,
        provider: account.provider,
        profileRevision: account.profileRevision,
      })
    )
      throw Error('Original signed operator required');
    const custody = owners.custody(id, account, binding);
    if (
      !custody ||
      !(binding.execution.location === 'local' && binding.harness.implementation === 'codex'
        ? ordinaryOperatorOwnsConversation(custody.authSessionId, auth.id)
        : custody.authSessionId === auth.id) ||
      (custody.binding && !isDeepStrictEqual(custody.binding, binding))
    )
      throw Error('Original signed operator required');
  } finally {
    release();
  }
}
