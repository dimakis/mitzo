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

function stateObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A Home pin starts a fresh item trail and retains its exact entry context. */
export function telosHomeItemState(location: {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
}) {
  return {
    telosHistory: [],
    telosItemReturn: {
      path: location.pathname + location.search + location.hash,
      state: stateObject(location.state),
    },
  };
}

/** Home-only navigation intent; never work data, assignment or access. */
export function readTelosHomeReturn(state: unknown) {
  const retained = stateObject(stateObject(state)?.telosItemReturn);
  if (
    !retained ||
    typeof retained.path !== 'string' ||
    !retained.path.startsWith('/') ||
    retained.path.startsWith('//')
  )
    return null;
  try {
    const target = new URL(retained.path, 'https://mitzo.invalid');
    if (
      target.origin !== 'https://mitzo.invalid' ||
      target.pathname !== '/' ||
      target.pathname + target.search + target.hash !== retained.path
    )
      return null;
    return { path: retained.path, state: stateObject(retained.state) };
  } catch {
    return null;
  }
}
