import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { TelosWorkItemSchema, TelosWorkViewSchema } from '../../../packages/protocol/src/index';
import { createUiData } from './ui-data';
const uiOwners: ReturnType<typeof createUiData>[] = [];
test.afterEach(() => {
  for (const owner of uiOwners.splice(0).reverse()) owner.close();
});

test('S9 accepted MGMT owner persists every priority and rejects invalid values without mutation', () => {
  const data = createUiData();
  uiOwners.push(data);
  for (let value = 1; value <= 10; value++) {
    data.setPriority(value);
    expect(data.priority()).toBe(value);
  }
  for (const invalid of [0, 11, 1.5]) {
    expect(() => data.setPriority(invalid)).toThrow();
    expect(data.priority()).toBe(10);
  }
  expect(data.readMaterial(1).bytes.toString()).toBe('OLDER REVIEWED REVISION');
  expect(data.readMaterial(2).bytes.toString()).toBe('LATER UNSELECTED REVISION');
});

const compiled = build({
  entryPoints: [resolve('tests/integration/telos-s9/ui-fixture.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/s9-ui.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

async function surface(page: Page, theme: 'dark' | 'light') {
  const data = createUiData();
  uiOwners.push(data);
  let collectionReads = 0,
    canonicalReads = 0,
    refusePriority = false;
  const materialReads: number[] = [];
  const writes: unknown[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  const files = (await compiled).outputFiles;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (url.origin !== 'https://mitzo-ui.test') {
      unexpected.push(url.href);
      return route.abort();
    }
    if (path === '/fixture.js' || path === '/fixture.css')
      return route.fulfill({
        body: files.find((file) => file.path.endsWith(path.endsWith('.js') ? '.js' : '.css'))!.text,
        contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css',
      });
    if (path.startsWith('/todos'))
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    if (path === '/api/telos/work/collection') {
      collectionReads++;
      canonicalReads++;
      return route.fulfill({ json: data.canonicalCollection() });
    }
    if (path === '/api/todos') {
      collectionReads++;
      return route.fulfill({ json: data.collection() });
    }
    const canonical = path.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
    if (canonical) {
      if (canonical[2]) {
        canonicalReads++;
        return route.fulfill({ json: TelosWorkItemSchema.parse(data.record(canonical[1])) });
      }
      return route.fulfill({ json: TelosWorkViewSchema.parse(data.work(canonical[1])) });
    }
    if (path === '/api/todos/outcome/action') {
      const input = route.request().postDataJSON();
      writes.push(input);
      if (refusePriority) {
        refusePriority = false;
        return route.fulfill({ status: 503, json: { error: 'Synthetic pre-write refusal' } });
      }
      if (
        input.action !== 'priority' ||
        !Number.isInteger(input.priority) ||
        input.priority < 1 ||
        input.priority > 10
      )
        return route.fulfill({ status: 400, json: { error: 'Invalid priority' } });
      data.setPriority(input.priority);
      return route.fulfill({ json: { ok: true } });
    }
    if (/\/api\/telos\/items\/[^/]+\/artifacts/.test(path))
      return route.fulfill({
        json: { limit: 100, artifacts: path.includes('/outcome/') ? [data.old] : [] },
      });
    if (path === '/api/telos/artifacts/' + data.old.id) {
      const revision = Number(url.searchParams.get('revision'));
      if (!Number.isInteger(revision) || revision < 1) {
        unexpected.push('Unpinned material request');
        return route.abort();
      }
      materialReads.push(revision);
      const selected = data.readMaterial(revision);
      return route.fulfill({ body: selected.bytes, contentType: 'text/markdown' });
    }
    if (path === '/api/home/preferences')
      return route.fulfill({
        json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
      });
    if (path === '/api/service-health')
      return route.fulfill({ json: { services: [], checkedAt: 1 } });
    if (['/mitzo-icon.png', '/mitzo-wordmark.png'].includes(path))
      return route.fulfill({
        body: await readFile('frontend/public' + path),
        contentType: 'image/png',
      });
    unexpected.push(path);
    return route.abort();
  });
  return {
    writes,
    materialReads,
    unexpected,
    errors,
    canonicalPriority: () => data.priority(),
    refuseNextPriority() {
      refusePriority = true;
    },
    get collectionReads() {
      return collectionReads;
    },
    get canonicalReads() {
      return canonicalReads;
    },
    async update() {
      data.update();
      await page.evaluate(() => window.dispatchEvent(new Event('s9-canonical-update')));
    },
  };
}

for (const theme of ['dark', 'light'] as const) {
  for (const view of ['tree', 'detail'] as const)
    test(`S9 same-ID canonical ${view} updates without manual refresh (${theme})`, async ({
      page,
      isMobile,
    }, info) => {
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
      const host = await surface(page, theme);
      await page.goto(view === 'tree' ? '/todos' : '/todos/outcome');
      await expect(
        page.getByRole(view === 'tree' ? 'button' : 'heading', {
          name: 'Original outcome',
          exact: true,
        }),
      ).toBeVisible();
      const before = host.canonicalReads;
      await host.update();
      await expect
        .soft(
          page.getByRole(view === 'tree' ? 'button' : 'heading', {
            name: 'Updated outcome',
            exact: true,
          }),
        )
        .toBeVisible();
      expect.soft(host.canonicalReads).toBeGreaterThan(before);
      if (view === 'tree') {
        await expect
          .soft(
            page
              .locator('.telos-tree-row')
              .filter({ has: page.getByRole('button', { name: /^(Original|Updated) outcome$/ }) })
              .locator('.telos-node-status'),
          )
          .toHaveText('acknowledged');
        await page.getByRole('button', { name: 'Browse categories' }).click();
        await expect
          .soft(page.getByRole('button', { name: 'Updated category', exact: true }))
          .toBeVisible();
      } else await expect.soft(page.locator('.telos-item-heading')).toContainText('acknowledged');
      await page.screenshot({ path: info.outputPath(`${view}-${theme}.png`), fullPage: true });
      expect(host.unexpected).toEqual([]);
      expect(host.errors).toEqual([]);
    });

  test(`S9 shared action foreground preserves semantic contrast (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const host = await surface(page, theme);
    await page.goto('/todos/outcome');
    const button = page.getByRole('button', { name: 'Choose lead collaborator', exact: true });
    await expect(button).toBeVisible();
    const colors = await button.evaluate((element) => {
      const computed = getComputedStyle(element);
      // Compare the real shared component outside the Telos cascade, and
      // measure readability. Shared tokens may legitimately vary by theme.
      const reference = document.createElement('button');
      reference.className = 'todo-detail-chat-btn';
      document.body.append(reference);
      const expected = getComputedStyle(reference).color;
      reference.remove();
      const luminance = (color: string) => {
        const channels = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((n) => {
            const linear = n / 255;
            return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
          });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      const foreground = luminance(computed.color),
        background = luminance(computed.backgroundColor);
      const contrast =
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      return {
        foreground: computed.color,
        background: computed.backgroundColor,
        expected,
        contrast,
      };
    });
    await test
      .info()
      .attach('computed-colors', { body: JSON.stringify(colors), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`action-${theme}.png`), fullPage: true });
    expect.soft(colors.foreground).toBe(colors.expected);
    expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  test(`S9 Context is collapsed and readable as originally approved (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const host = await surface(page, theme);
    await page.goto('/todos/outcome');
    await expect(
      page.getByRole('heading', { name: 'Original outcome', exact: true }),
    ).toBeVisible();
    const aside = page.getByRole('complementary', { name: 'Original brief' });
    await aside.getByText('Details & context', { exact: true }).click();
    const trigger = aside.getByText('Context', { exact: true });
    await page.screenshot({ path: info.outputPath(`context-${theme}.png`), fullPage: true });
    const state = await trigger.evaluate((element) => {
      const details = element.closest('details');
      return {
        accessible:
          element.tagName === 'SUMMARY' ||
          (element.tagName === 'BUTTON' && element.hasAttribute('aria-expanded')),
        open: details
          ? details.hasAttribute('open')
          : element.getAttribute('aria-expanded') !== 'false',
      };
    });
    expect(state).toEqual({ accessible: true, open: false });
    await trigger.click();
    const disclosure = trigger.locator('..');
    await expect(disclosure).toContainText('Repositories');
    await expect(disclosure).toContainText('synthetic/repository');
    await expect(disclosure).toContainText('People');
    await expect(disclosure).toContainText('Offline collaborator');
    await expect(disclosure).not.toContainText('docIds');
    await expect(disclosure).not.toContainText('Not recorded');
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  test(`S9 New item enters ordinary advisor planning before mandatory capture (${theme})`, async ({
    page,
  }) => {
    const host = await surface(page, theme);
    await page.goto('/todos');
    await page.getByRole('button', { name: 'New item', exact: true }).click();
    await expect(page).toHaveURL(/\/chat(?:\/|\?)/);
    await expect(page.getByPlaceholder('Short outcome title')).toHaveCount(0);
    expect(host.writes).toEqual([]);
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  test(`S9 selected retained material opens in-app at the pinned older revision (${theme})`, async ({
    page,
  }, info) => {
    const host = await surface(page, theme);
    const popups: string[] = [],
      downloads: string[] = [];
    page.on('popup', (popup) => popups.push(popup.url()));
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    await page.goto('/todos/outcome');
    await page.getByRole('button', { name: 'Materials', exact: true }).click();
    const title = page.getByText('Selected retained plan', { exact: true }).first();
    await expect(title).toBeVisible();
    await title.click();
    await expect.soft(page.getByText('OLDER REVIEWED REVISION', { exact: false })).toBeVisible();
    expect.soft(host.materialReads).toContain(1);
    expect.soft(host.materialReads).not.toContain(2);
    expect(popups).toEqual([]);
    expect(downloads).toEqual([]);
    await page.screenshot({
      path: info.outputPath(`selected-material-${theme}.png`),
      fullPage: true,
    });
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  test(`S9 unclassified legacy parent retains actual child navigation (${theme})`, async ({
    page,
  }) => {
    const host = await surface(page, theme);
    await page.goto('/todos/legacy');
    await expect(page.getByRole('heading', { name: 'Legacy parent', exact: true })).toBeVisible();
    const child = page.getByRole('button', { name: 'Real legacy child', exact: true });
    await expect(child).toBeVisible();
    await child.click();
    await expect(page).toHaveURL(/\/todos\/legacy-child$/);
    await expect(
      page.getByRole('heading', { name: 'Real legacy child', exact: true }),
    ).toBeVisible();
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  test(`S9 priority is editable and persisted in the replacement workspace and tree (${theme})`, async ({
    page,
    isMobile,
  }) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const host = await surface(page, theme);
    await page.goto('/todos/outcome');
    await expect(
      page.getByRole('heading', { name: 'Original outcome', exact: true }),
    ).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Priority', exact: true });
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('5');
    for (let value = 1; value <= 10; value++) {
      await select.selectOption(String(value));
      await expect(select).toHaveValue(String(value));
      expect(host.canonicalPriority()).toBe(value);
      await page.reload();
      await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue(
        String(value),
      );
    }
    host.refuseNextPriority();
    await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('3');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Couldn’t confirm this priority' }),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue('10');
    expect(host.canonicalPriority()).toBe(10);
    await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('7');
    await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue('7');
    expect(host.canonicalPriority()).toBe(7);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue('7');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(
      page.locator('.telos-tree-row').filter({ hasText: 'Original outcome' }),
    ).toContainText('P7');
    expect(host.unexpected).toEqual([]);
    expect(host.errors).toEqual([]);
  });
}
