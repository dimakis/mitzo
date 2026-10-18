import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-priority.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-priority.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

for (const theme of ['dark', 'light'] as const)
  test(`priority saves, failures and navigation preserve the current Telos layout (${theme})`, async ({
    page,
  }, info) => {
    const files = (await compiled).outputFiles;
    const errors: string[] = [],
      unexpected: string[] = [];
    const writes: unknown[] = [];
    let priority = 5;
    let release!: () => void;
    const saveBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const item = () => ({
      id: 'priority-item',
      summary: 'Keep the approved Telos interface',
      profile: 'work',
      intent: 'Edit only the numeric priority control and matching tree badge.',
      priority,
      urgency: 0.7,
      starred: false,
      status: 'active',
      ageDays: 1,
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
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: files.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
        });
      if (url.pathname === '/api/todos')
        return route.fulfill({ json: { profiles: ['work'], items: [item()] } });
      if (url.pathname === '/api/todos/priority-item/action') {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.priority === 9) return route.fulfill({ status: 503, json: { ok: false } });
        expect(body).toEqual({ action: 'priority', priority: 7 });
        await saveBarrier;
        priority = body.priority;
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Briefing', terminal: 'Terminal' }, pins: [] },
        });
      if (url.pathname.endsWith('/artifacts'))
        return route.fulfill({ json: { artifacts: [], limit: 100 } });
      if (url.pathname === '/api/telos/work/items/priority-item')
        return route.fulfill({
          json: {
            itemId: 'priority-item',
            kind: null,
            parentId: null,
            revision: 'a'.repeat(64),
            links: [],
            assignments: [],
            sources: [],
            attempts: [],
          },
        });
      if (url.pathname.startsWith('/api/telos/work/'))
        return route.fulfill({
          status: 404,
          json: { error: 'Not available in this isolated surface fixture' },
        });
      if (url.pathname.startsWith('/api/')) {
        unexpected.push(url.pathname);
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
        <html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/fixture.css"><style>html{font-size:${theme === 'light' ? '125%' : '100%'}}html,body,#root{height:100%;margin:0}</style>
        <div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/todos');
    await expect(page.getByLabel('Priority 5 of 10')).toHaveText('P5');
    await page.getByText('Keep the approved Telos interface', { exact: true }).click();
    const select = page.getByRole('combobox', { name: 'Priority', exact: true });
    await expect(select).toHaveValue('5');
    await expect(select.locator('option')).toHaveCount(10);
    await select.focus();
    await expect(select).toBeFocused();
    expect(await select.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      'solid',
    );
    const bounds = await select.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await select.selectOption('7');
    await expect(select).toBeDisabled();
    release();
    await expect(select).toHaveValue('7');
    await expect(select).toBeEnabled();
    if (!info.project.name.startsWith('mobile'))
      await expect(page.getByLabel('Priority 7 of 10')).toHaveText('P7');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`priority-detail-${theme}.png`) });
    await select.selectOption('9');
    await expect(page.getByRole('alert')).toContainText('Couldn’t confirm this priority');
    await expect(select).toHaveValue('7');
    await page.reload();
    await expect(select).toHaveValue('7');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByLabel('Priority 7 of 10')).toHaveText('P7');
    await expect(page.getByRole('button', { name: /Active/ })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`priority-tree-${theme}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(writes).toEqual([
      { action: 'priority', priority: 7 },
      { action: 'priority', priority: 9 },
    ]);
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
