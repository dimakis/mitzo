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
