import { expect, type Frame, type Page, type Request } from '@playwright/test';

/** Observe each fixture document's real startup read before its next hard navigation.
 * WebKit misreports new requests from a departing document as access-control errors.
 * Keep pageerror guards strict; do not replace the read, suppress it or sleep.
 */
export async function navigateWithServiceHealth(page: Page, navigate: () => Promise<unknown>) {
  let committed = false;
  let started = new WeakSet<Request>();
  const commit = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    committed = true;
    started = new WeakSet<Request>();
  };
  const record = (request: Request) => {
    const url = new URL(request.url());
    if (committed && url.pathname === '/api/service-health' && request.frame() === page.mainFrame())
      started.add(request);
  };
  page.on('framenavigated', commit);
  page.on('request', record);
  const read = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return started.has(response.request()) && url.origin === new URL(page.url()).origin;
  });
  // Navigation failure stays the original failure; closing its observer must not
  // create an unrelated unhandled rejection. The normal path still awaits read.
  void read.catch(() => {});
  try {
    await navigate();
    const response = await read;
    expect(response.request().method()).toBe('GET');
    expect(response.status()).toBe(200);
    expect(await response.finished()).toBeNull();
  } finally {
    page.off('request', record);
    page.off('framenavigated', commit);
  }
}
