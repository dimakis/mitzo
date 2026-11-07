/** User text is always data, never FTS syntax. Quotes group an exact phrase. */
export function sessionSearchTerms(query: string): string[] {
  if (query.length > 512) throw new RangeError('Search is limited to 512 characters');
  const terms = [
    ...new Set(
      [...query.trim().matchAll(/"([^"]+)"|(\S+)/g)].map((match) =>
        (match[1] ?? match[2]).toLowerCase(),
      ),
    ),
  ];
  if (terms.length > 32) throw new RangeError('Search is limited to 32 words or phrases');
  return terms;
}

export function searchLike(term: string): string {
  return '%' + term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%';
}

export function searchSnippet(text: string, query: string, context = 80): string {
  const lower = text.toLowerCase();
  const positions = sessionSearchTerms(query)
    .map((term) => lower.indexOf(term))
    .filter((i) => i >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - context);
  const end = Math.min(text.length, start + context * 2);
  return (start ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
