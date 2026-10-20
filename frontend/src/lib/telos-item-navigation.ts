export function parseItemHistory(value: unknown): string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : [];
}

/** S7's explicit route trail takes precedence over a previous device visit. */
export function readTelosItemHistory(itemId: string, navigationHistory: unknown): string[] {
  if (navigationHistory !== undefined) return parseItemHistory(navigationHistory);
  try {
    return parseItemHistory(
      JSON.parse(sessionStorage.getItem('telos.item.history.' + itemId) ?? '[]'),
    );
  } catch {
    return [];
  }
}
