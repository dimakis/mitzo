/** Local composer ownership only; server receipt verification remains in SendOutbox. */
export interface ComposerDraftProof {
  storageKey: string;
  revisionToken: string;
}
export const acceptedComposerDraftKey = (key: string) =>
  `mitzo-draft-accepted:${encodeURIComponent(key)}`;
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
