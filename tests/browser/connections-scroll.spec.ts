import { expect, test } from '@playwright/test';

for (const state of ['loaded', 'loading', 'error'] as const) {
  test(`Connections can scroll with native document scrolling disabled: ${state}`, async ({
    page,
    isMobile,
  }) => {
    // Capacitor's Keyboard.setScroll({ isDisabled: true }) disables the native
    // document scroller. Lock it here so a body scroll cannot mask the regression.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.overflow = 'hidden';
        document.body.style.cssText = 'height: 100dvh; overflow: hidden';
      });
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/connections') {
        if (state === 'loading') return; // Keep the catalog pending.
        if (state === 'error') {
          return route.fulfill({ status: 503, json: { error: 'Catalog unavailable' } });
        }
        return route.fulfill({
          json: {
            connections: [],
            legacy: [],
            eligibleAccounts: ['work'],
            appliesTo: 'new conversations only',
          },
        });
      }
      if (path === '/api/symposium/personal/connections') {
        return route.fulfill({
          json: {
            connections: Array.from({ length: 8 }, (_, index) => ({
              id: `personal-${index}`,
              label: `Personal account ${index + 1}`,
              revision: 1,
              state: 'disconnected',
            })),
          },
        });
      }
      if (path === '/api/connections/templates') {
        return route.fulfill({ json: { templates: [] } });
      }
      // All backend traffic is mocked: no credentials or model calls.
      return route.fulfill({ json: {} });
    });
    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: 'Personal account 8' })).toBeVisible();
    const main = page.getByRole('main');
    const bottom =
      state === 'loaded'
        ? page.getByRole('heading', { name: 'Operator-managed legacy services' })
        : state === 'error'
          ? page.getByRole('button', { name: 'Retry', exact: true })
          : page.getByText('Loading connections…', { exact: true });

    for (const height of isMobile ? [844, 430] : [720]) {
      // A shorter viewport models KeyboardResize.Native and landscape/small phones.
      await page.setViewportSize({ width: isMobile ? 390 : 1280, height });
      await expect
        .poll(() => main.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(0);
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(bottom).toBeInViewport();
      if (isMobile) {
        const bottomBox = await bottom.boundingBox();
        const tabsBox = await page.locator('.workspace-tabs').boundingBox();
        expect(bottomBox!.y + bottomBox!.height).toBeLessThanOrEqual(tabsBox!.y);
      }
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        page.getByRole('heading', { name: 'Connections', exact: true }),
      ).toBeInViewport();
    }
  });
}
