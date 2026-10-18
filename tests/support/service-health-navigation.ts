import type { Page, Request } from '@playwright/test';

/** Observe the fixture's actual health response before a hard navigation can
 * overlap the old document's fallback poll. This does not request health or
 * suppress errors; callers still require HTTP 200 and successful completion. */
export function observeMockedServiceHealth(page: Page, origin: string) {
  let generation = 0;
  const admissions = new WeakMap<Request, number>();
  let completion: { status: number; failure: string | null } | undefined;
  // Only a real main-document request changes the generation. SPA navigation
  // retains the same mounted health owner and its already completed response.
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      ++generation;
      completion = undefined;
    }
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/api/service-health')
      admissions.set(request, generation);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || url.pathname !== '/api/service-health') return;
    const admitted = admissions.get(response.request());
    if (admitted === undefined) return;
    const finish = (failure: string | null) => {
      if (admitted === generation) completion = { status: response.status(), failure };
    };
    void response.finished().then(
      (error) => finish(error?.message ?? null),
      (error: unknown) => finish(String(error)),
    );
  });
  return { completion: () => completion };
}
