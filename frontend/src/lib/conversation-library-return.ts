/** Retain only a bounded library query and scroll position, never a destination. */
export function conversationLibraryReturn(state: unknown): {
  path: string;
  state: { conversationSearchScroll: number } | undefined;
} {
  const saved = (
    state as { conversationLibraryReturn?: { query?: unknown; scrollTop?: unknown } } | null
  )?.conversationLibraryReturn;
  if (typeof saved?.query !== 'string' || !saved.query.trim() || saved.query.length > 512)
    return { path: '/sessions', state: undefined };
  const scrollTop =
    typeof saved.scrollTop === 'number' && Number.isFinite(saved.scrollTop) && saved.scrollTop >= 0
      ? saved.scrollTop
      : 0;
  return {
    path: '/sessions?' + new URLSearchParams({ q: saved.query }),
    state: { conversationSearchScroll: scrollTop },
  };
}
