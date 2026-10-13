import type { Route } from '@playwright/test';
/** Other UI fixtures explicitly leave the independently enrolled Local route off. */
export async function disabledLocalCapabilities(route: Route, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/chat/local-codex/capabilities') return false;
  await route.fulfill({
    status: 503,
    json: { ok: false, code: 'entry_disabled', error: 'Local entry unavailable' },
  });
  return true;
}
