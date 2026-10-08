import { expect, test } from '@playwright/test';

for (const state of ['loaded', 'loading', 'error'] as const) {
  test(`Connection management stays reachable with native document scrolling disabled: ${state}`, async ({
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
        if (state === 'loading') return;
        if (state === 'error')
          return route.fulfill({ status: 503, json: { error: 'Personal accounts unavailable' } });
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
    await page.goto('/connections?manage=personal');
    if (state === 'loaded')
      await expect(page.getByRole('heading', { name: 'Personal account 8' })).toBeVisible();
    else if (state === 'loading')
      await expect(page.getByText('Loading personal accounts…', { exact: true })).toBeVisible();
    else await expect(page.getByText(/Could not load personal accounts/)).toBeVisible();
    const main = page.getByRole('main');
    const bottom = page.getByRole('button', { name: 'Refresh personal accounts', exact: true });

    for (const height of isMobile ? [844, 430] : [720]) {
      // A shorter viewport models KeyboardResize.Native and landscape/small phones.
      await page.setViewportSize({ width: isMobile ? 390 : 1280, height });
      await expect.poll(() => main.evaluate((element) => element.clientHeight)).toBeGreaterThan(0);
      if (state === 'loaded')
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
        page.getByRole('heading', { name: 'Manage ChatGPT account', exact: true }),
      ).toBeInViewport();
    }
  });
}

test('Add connection opens a focused chooser and authorizes only after access review', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/connections')
      return route.fulfill({
        json: {
          connections: [],
          legacy: [],
          eligibleAccounts: ['work'],
          appliesTo: 'new conversations',
        },
      });
    if (path === '/api/connections/templates')
      return route.fulfill({
        json: {
          capabilities: [],
          templates: [
            {
              id: 'jira-readonly',
              version: 1,
              label: 'Jira',
              category: 'data',
              description: 'Read issues.',
              risk: 'read-only',
              available: true,
              capabilityTemplates: [],
              credentialFields: [
                {
                  key: 'token',
                  label: 'API token',
                  description: 'Use a scoped token.',
                  style: 'api-token',
                  secret: true,
                  required: true,
                },
              ],
              connectionFields: [
                {
                  key: 'email',
                  label: 'Atlassian account email',
                  description: 'Account identity.',
                  kind: 'email',
                  required: true,
                },
              ],
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Add connection', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose ChatGPT', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose Jira', exact: true })).toBeVisible();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Account label', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose Jira', exact: true }).click();
  await page.getByLabel('API token', { exact: true }).fill('fixture-token');
  await page.getByLabel('Atlassian account email', { exact: true }).fill('person@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
  await page.getByLabel('work', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify and connect Jira', exact: true }).click();
  await expect(page.getByLabel('Passphrase', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('API token', { exact: true })).toHaveValue('fixture-token');
});
