type NavigationState = Record<string, unknown> | null;
function stateObject(value: unknown): NavigationState {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function telosChatReturnState(
  state: unknown,
  itemId: string,
  conversationId: string,
  path: string,
) {
  return {
    ...stateObject(state),
    telosChatReturn: { itemId, conversationId, path, state: stateObject(state) },
  };
}
/** Navigation intent only. This never supplies work data, assignment or access. */
export function readTelosChatReturn(state: unknown, itemId: string | null, pathname: string) {
  const retained = stateObject(stateObject(state)?.telosChatReturn);
  if (
    !retained ||
    !itemId ||
    retained.itemId !== itemId ||
    typeof retained.conversationId !== 'string' ||
    typeof retained.path !== 'string' ||
    !retained.path.startsWith('/') ||
    retained.path.startsWith('//')
  )
    return null;
  try {
    if (
      !retained.conversationId ||
      pathname !== `/chat/${encodeURIComponent(retained.conversationId)}`
    )
      return null;
    const target = new URL(retained.path, 'https://mitzo.invalid');
    if (
      target.origin !== 'https://mitzo.invalid' ||
      target.hash ||
      !/^\/(todos|chat)\/[^/]+$/.test(target.pathname) ||
      target.pathname + target.search !== retained.path
    )
      return null;
    return { path: retained.path, state: stateObject(retained.state) };
  } catch {
    return null;
  }
}
