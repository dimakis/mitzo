/** Local composer ownership only; server receipt verification remains in SendOutbox. */
export interface ComposerDraftProof {
  storageKey: string;
  revisionToken: string;
}
export const acceptedComposerDraftKey = (key: string) =>
  `mitzo-draft-accepted:${encodeURIComponent(key)}`;
export const composerDraftRevisionKey = (key: string) =>
  `mitzo-draft-revision:${encodeURIComponent(key)}`;
const pendingRevocations = new Set<string>();

/** Never persist a newer edit beneath a revision whose authority could not be revoked. */
export function allowComposerDraftPersistence(key: string): boolean {
  if (!pendingRevocations.has(key)) return true;
  try {
    localStorage.removeItem(composerDraftRevisionKey(key));
  } catch {
    try {
      // Replacement can revoke authority even when removal is unavailable.
      localStorage.setItem(composerDraftRevisionKey(key), 'null');
    } catch {
      return false;
    }
  }
  pendingRevocations.delete(key);
  return true;
}
export function replaceComposerDraftRevision(key: string, value: string): boolean {
  pendingRevocations.add(key);
  const revoked = allowComposerDraftPersistence(key);
  try {
    localStorage.setItem(composerDraftRevisionKey(key), value);
    pendingRevocations.delete(key);
    return true;
  } catch {
    // A successful removal already invalidated the old proof. Otherwise every
    // text/rich-draft write remains fenced until a later retry can revoke it.
    if (!revoked) pendingRevocations.add(key);
    return false;
  }
}
export function composerDraftRevocationPending(key: string): boolean {
  return pendingRevocations.has(key);
}
export function composerDraftProof(value: unknown): ComposerDraftProof | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const proof = value as Partial<ComposerDraftProof>;
  return typeof proof.storageKey === 'string' &&
    proof.storageKey.length > 0 &&
    proof.storageKey.length <= 2048 &&
    typeof proof.revisionToken === 'string' &&
    /^\S{1,200}$/.test(proof.revisionToken) &&
    Object.keys(value).length === 2
    ? { storageKey: proof.storageKey, revisionToken: proof.revisionToken }
    : undefined;
}
