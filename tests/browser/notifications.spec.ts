import { expect, test } from '@playwright/test';

test('notification requests and preferences stay reachable with native body scrolling locked', async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height: 100dvh; overflow: hidden';
    });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  let resolved = false;
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/respond')) {
      expect(route.request().postDataJSON()).toEqual({ sessionId: 'session1', decision: 'once' });
      resolved = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/notifications')
      return route.fulfill({
        json: {
          items: Array.from({ length: 12 }, (_, i) => ({
            id: `permission:p${i}`,
            kind: 'approval',
            title: `Review request ${i + 1}`,
            body: 'Notification improvements',
            sessionId: 'session1',
            permId: `p${i}`,
            createdAt: Date.now(),
            expiresAt: Date.now() + 600000,
            readAt: null,
            resolvedAt: resolved && i === 0 ? Date.now() : null,
            resolution: resolved && i === 0 ? 'allowed' : null,
            request: {
              permId: `p${i}`,
              toolName: 'Bash',
              toolInput: 'npm test',
              sessionId: 'session1',
            },
          })),
          needsYou: resolved ? 11 : 12,
          total: 12,
          preferences: {
            approvals: true,
            questions: true,
            completion: 'unattended',
            updates: true,
            sensitivePreviews: false,
            quietHours: false,
            quietStart: '22:00',
            quietEnd: '08:00',
            timezone: 'UTC',
          },
          delivery: { configured: false, registeredDevices: 0 },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/notifications');
  const main = page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  for (const height of isMobile ? [844, 430] : [720]) {
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height });
    await main.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByText(/The badge counts requests that need you/)).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  await main.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  await expect(page.getByText('npm test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('Decision recorded', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole('button', { name: 'Save preferences' })).toBeInViewport();
});
