/** Catalog compatibility is display/selection data; runtime admission still owns access. */
export function agentToolRouteLabel(routes: readonly string[]): string | undefined {
  const api = routes.includes('local-api');
  const codex = routes.includes('codex') || routes.includes('codex-owned-local');
  if (api && codex) return 'Local API and Codex chats';
  if (api) return 'Local API chats';
  if (codex) return 'Local Codex chats';
  return undefined;
}
