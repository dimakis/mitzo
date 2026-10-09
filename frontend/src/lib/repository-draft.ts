export function repositoryDraftKey(accountId: string, model: string) {
  return `mitzo-repository-draft:${accountId}:${model}`;
}

export function savedRepositoryDraft(accountId: string, model: string): string | null {
  try {
    return sessionStorage.getItem(repositoryDraftKey(accountId, model));
  } catch {
    return null;
  }
}

/** Consume only the receipt sent by this draft, after the server assigns its chat. */
export function consumeRepositoryDraft(key: string, id: string): void {
  try {
    if (sessionStorage.getItem(key) === id) sessionStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}
