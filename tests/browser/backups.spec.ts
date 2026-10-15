import { expect, test } from '@playwright/test';
const overview = {
  ready: true,
  busy: false,
  setup: [],
  lastCapture: '2026-10-06T12:00:00Z',
  lastCloudUpload: null,
  runs: [
    {
      id: '1',
      startedAt: '2026-10-06T12:00:00Z',
      status: 'pending',
      bytes: 1048576,
      generation: 'generation',
    },
  ],
  coverage: [
    {
      name: 'Mitzo and Telos databases',
      supported: true,
      detail: 'Messages, tasks, Telos relationships, session links and stored artifacts.',
    },
    ...['Workspace files', 'LifeOps', 'OpenShell and Podman', 'Centaur and ContexGin'].map(
      (name) => ({ name, supported: false, detail: 'Not captured by this group yet.' }),
    ),
  ],
};
test('backup dashboard preserves scope and upload distinction on desktop and mobile', async ({
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
  let actions = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backups') return route.fulfill({ json: overview });
    if (path === '/api/backups/refresh') {
      actions++;
      return route.fulfill({ status: 202, json: { accepted: true } });
    }
    if (path === '/api/notifications')
      return route.fulfill({ json: { items: [], needsYou: 0, unread: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/settings');
  await page.getByRole('link', { name: /Backups/ }).click();
  await expect(page).toHaveURL(/\/settings\/backups$/);
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Backups', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
  if (!isMobile)
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Settings', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  await page.goto('/backups');
  await expect(page).toHaveURL(/\/settings\/backups$/);
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
  await expect(page.getByText('No confirmed upload', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check iCloud upload' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check iCloud upload' }).click();
  await expect.poll(() => actions).toBe(1);
  await page.screenshot({ path: test.info().outputPath('backups.png') });
  const main = page.locator('main.backups-page');
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByText('Waiting for iCloud', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (isMobile) {
    await expect(page.getByRole('link', { name: 'More', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const run = await page.getByText('Waiting for iCloud', { exact: true }).boundingBox();
    const tabs = await page.locator('.workspace-tabs').boundingBox();
    expect(run!.y + run!.height).toBeLessThanOrEqual(tabs!.y);
  }
});

test('backup onboarding prepares storage and saves a recovery-confirmed password on desktop and mobile', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  let configured = false;
  let prepared = false;
  let saved = 0;
  const setup = () => ({
    supported: true,
    prepared,
    configured,
    busy: false,
    localFolder: '/private/local-backups',
    cloudFolder: '/iCloud/Mitzo Backups',
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backups/setup/prepare') prepared = true;
    if (path === '/api/backups/setup' && route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({
        password: 'synthetic-recovery-password',
        recoveryConfirmed: true,
      });
      configured = true;
      saved++;
    }
    return route.fulfill({
      json: path.startsWith('/api/backups/setup')
        ? setup()
        : path === '/api/backups'
          ? {
              ...overview,
              ready: configured,
              setup: configured ? [] : ['Complete backup setup in Mitzo.'],
              runs: [],
              lastCapture: null,
            }
          : {},
    });
  });
  await page.goto('/settings/backups');
  await page.getByRole('button', { name: 'Set up backups', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Backup setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare storage' }).click();
  await page.getByLabel('Backup password', { exact: true }).fill('synthetic-recovery-password');
  await expect(page.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Backup setup complete', { exact: true })).toBeVisible();
  expect(saved).toBe(1);
  await expect(page.getByLabel('Backup password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
