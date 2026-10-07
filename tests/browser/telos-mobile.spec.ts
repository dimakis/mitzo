import { expect, test } from '@playwright/test';

const summary =
  'Symposium — canonical recovery, conversation testing and staging cleanup. ' +
  'Current direction and acceptance checkpoint. '.repeat(60);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mitzo-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height: 100dvh; overflow: hidden';
    });
  });
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `item-${index}`,
    summary: index === 0 ? summary : `Outcome ${index + 1}`,
    intent: 'A usable conversation with clear recovery.',
    profile: 'work',
    urgency: 0.8,
    starred: true,
    status: 'active',
    ageDays: index,
    parentId: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    sources: [],
    links: [],
    goalId: null,
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: '',
    },
  }));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === '/api/todos'
          ? { profiles: ['centaur', 'manual', 'personal', 'work'], items }
          : { artifacts: [], limit: 100 },
    }),
  );
  await page.goto('/todos');
});

test('Telos keeps long handovers compact and actions reachable on iOS', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile collection layout');
  await expect(page.getByRole('heading', { name: 'Telos', exact: true })).toBeVisible();
  const card = page.locator('.todo-card').first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.height).toBeLessThan(250);
  await expect(card.getByRole('button', { name: 'Start Session' })).toBeInViewport();
  expect(
    await page
      .locator('.todo-list')
      .first()
      .evaluate((node) => getComputedStyle(node).borderRadius),
  ).toBe('12px');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const filter of await page.locator('.todo-filter-pill').all()) {
      expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.locator('.todo-page').evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.locator('.todo-scroll').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Outcome 12', exact: true })).toBeInViewport();
    const lastBox = await page.locator('.todo-card').last().boundingBox();
    const tabsBox = await page.locator('.workspace-tabs').boundingBox();
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(tabsBox!.y);
    await page.locator('.todo-scroll').evaluate((node) => {
      node.scrollTop = 0;
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/telos-mobile.png' });
  await card.getByRole('button', { name: summary, exact: true }).tap();
  await expect(page).toHaveURL(/\/todos\/item-0$/);
  await expect(page.locator('.todo-detail-summary')).toHaveText(summary);
});

test('desktop and tablet Work lists retain a compact action bar without a second heading', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop collection layout');
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('heading', { name: 'Work with purpose' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Telos', exact: true })).toBeHidden();
    const list = page.getByRole('region', { name: 'Work items', exact: true });
    await expect(list.getByRole('button', { name: 'Add outcome' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Refresh Telos' })).toBeVisible();
    expect(
      (await list.locator('.todo-collection-heading').boundingBox())!.height,
    ).toBeLessThanOrEqual(80);
  }
});
