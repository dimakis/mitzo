import { expect, test } from '@playwright/test';

test('Inbox requests and notification preferences stay reachable with native body scrolling locked', async ({
  page,
  isMobile,
}) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height:100dvh;overflow:hidden';
    });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  let resolved = false;
  const items = () =>
    Array.from({ length: 12 }, (_, i) => ({
      id: `permission:p${i}`,
      kind: 'approval',
      title: `Review request ${i + 1}`,
      body: 'Inbox improvements',
      sessionId: 'session1',
      permId: `p${i}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      readAt: null,
      archivedAt: null,
      resolvedAt: resolved && i === 0 ? Date.now() : null,
      resolution: resolved && i === 0 ? 'allowed' : null,
      request: { permId: `p${i}`, toolName: 'Bash', toolInput: 'npm test', sessionId: 'session1' },
    }));
  const preferences = {
    approvals: true,
    questions: true,
    completion: 'unattended',
    updates: true,
    sensitivePreviews: false,
    quietHours: false,
    quietStart: '22:00',
    quietEnd: '08:00',
    timezone: 'UTC',
  };
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (path.endsWith('/respond')) {
      expect(route.request().postDataJSON()).toEqual({ sessionId: 'session1', decision: 'once' });
      resolved = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/auth/check') return route.fulfill({ json: { authenticated: true } });
    if (path === '/api/notifications')
      return route.fulfill({
        json: {
          items: items(),
          needsYou: resolved ? 11 : 12,
          total: 12,
          preferences,
          delivery: { configured: false, registeredDevices: 0 },
        },
      });
    if (path === '/api/inbox/feed') {
      const records = items().filter(
        (item) => url.searchParams.get('view') !== 'needs' || item.resolvedAt === null,
      );
      return route.fulfill({
        json: { items: records, needsYou: resolved ? 11 : 12, total: records.length, sources: [] },
      });
    }
    if (path.startsWith('/api/inbox/records/')) {
      const item = items().find(
        (item) => item.id === decodeURIComponent(path.slice('/api/inbox/records/'.length)),
      );
      return route.fulfill({ status: item ? 200 : 404, json: item || {} });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/notifications');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { name: /^Inbox/ })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  const badge = navigation.getByLabel('12 requests need attention');
  await expect(badge).toBeVisible();
  const badgeBox = (await badge.boundingBox())!,
    linkBox = (await navigation.getByRole('link', { name: 'Inbox', exact: true }).boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(linkBox.x + linkBox.width);
  for (const height of isMobile ? [844, 430] : [720]) {
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height });
    await page
      .getByRole('button', { name: 'Review request 12', exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole('button', { name: 'Review request 12', exact: true }),
    ).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  await page.locator('.inbox-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
  const first = page.getByRole('button', { name: 'Review request 1', exact: true });
  await first.scrollIntoViewIfNeeded();
  const position = await page.locator('.unified-inbox').evaluate((el) => el.scrollTop);
  await first.click();
  if (isMobile) {
    await page.getByRole('button', { name: 'Back to Inbox' }).click();
    await expect
      .poll(() => page.locator('.unified-inbox').evaluate((el) => el.scrollTop))
      .toBe(position);
    await first.click();
  }
  await expect(page.getByText('npm test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Preferences', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Notification preferences', exact: true }),
  ).toBeVisible();
  await page.locator('.notifications-page').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('button', { name: 'Save preferences' })).toBeInViewport();
});
