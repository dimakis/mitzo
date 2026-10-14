import type { Route } from '@playwright/test';
/** Legacy UI fixtures explicitly leave independently enrolled runtime routes off. */
export async function disabledLocalCapabilities(route: Route, url: URL): Promise<boolean> {
  if (
    !['/api/chat/local-codex/capabilities', '/api/chat/runtime/capabilities'].includes(url.pathname)
  )
    return false;
  await route.fulfill({
    status: 503,
    json: { ok: false, code: 'entry_disabled', error: 'Local entry unavailable' },
  });
  return true;
}
