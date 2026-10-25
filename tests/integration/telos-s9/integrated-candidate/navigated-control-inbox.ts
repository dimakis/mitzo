import type { Frame, Page, Request } from '@playwright/test';

/** Observe the first exact inbox read issued by the newly committed document. */
export async function observeNavigatedControlInbox(
  page: Page,
  itemId: string,
  navigate: () => Promise<unknown>,
) {
  let committed = false;
  const requests = new WeakSet<Request>();
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) committed = true;
  };
  const onRequest = (request: Request) => {
    if (committed && request.frame() === page.mainFrame()) requests.add(request);
  };
  page.on('framenavigated', onNavigation);
  page.on('request', onRequest);
  const pending = page
    .waitForResponse((response) => {
      const request = response.request();
      if (
        !requests.has(request) ||
        request.method() !== 'POST' ||
        new URL(response.url()).pathname !== '/api/telos/work/controls'
      )
        return false;
      const command = request.postDataJSON();
      return command?.operation === 'inbox' && command.itemId === itemId;
    })
    // Consume the first response immediately, before any later navigation can
    // discard its protocol body. Status/schema/receipt assertions stay at the caller.
    .then(async (response) => ({ status: response.status(), body: await response.json() }));
  void pending.catch(() => {});
  try {
    const [inbox] = await Promise.all([pending, navigate()]);
    return inbox;
  } finally {
    page.off('framenavigated', onNavigation);
    page.off('request', onRequest);
  }
}
