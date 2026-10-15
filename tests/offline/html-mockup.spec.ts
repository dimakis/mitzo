import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Actual transcript renderer, request interception only; no app or model process.
const bundled = build({
  entryPoints: [resolve('tests/fixtures/html-mockup.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-html-mockup.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

const mockup = `
<style>
  body { font: 16px system-ui; margin: 16px; color: #17202a; background: #fff; }
  button, select, input { font: inherit; min-height: 44px; max-width: 100%; box-sizing: border-box; }
  label { display: block; margin-block: 8px; } input { width: 100%; }
  body[data-variant="compact"] h1 { font-size: 20px; }
</style>
<h1>Task board</h1>
<label>Design <select id="variant"><option value="roomy">Roomy</option><option value="compact">Compact</option></select></label>
<form><label>Task name <input required></label><button type="button">Add task</button></form>
<ul aria-label="Tasks"></ul><p role="status" id="result">No tasks yet</p>
<p id="isolation"></p>
<script>
  document.getElementById('variant').onchange = (event) => { document.body.dataset.variant = event.target.value; };
  document.querySelector('button').onclick = () => {
    if (!document.querySelector('form').reportValidity()) return;
    const row = document.createElement('li'); row.textContent = document.querySelector('input').value;
    document.querySelector('ul').append(row);
    document.getElementById('result').textContent = document.querySelectorAll('li').length + ' tasks';
  };
  try { parent.document.body.dataset.previewAccess = 'unsafe'; }
  catch { document.getElementById('isolation').textContent = 'Parent isolated'; }
  fetch('https://blocked.invalid/mockup-data').catch(() => {
    document.getElementById('isolation').textContent += '; network blocked';
  });
</script>`;

for (const theme of ['dark', 'light']) {
  test(`HTML mockup: inline clicks, retained state, retry and isolation (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const files = (await bundled).outputFiles!;
    const unexpected: string[] = [];
    const reads: string[] = [];
    let retry = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test' || route.request().method() !== 'GET') {
        unexpected.push(route.request().url());
        return route.abort();
      }
      if (url.pathname === '/api/files/read') {
        const path = url.searchParams.get('path');
        reads.push(path!);
        expect(url.searchParams.get('sessionId')).toBe('mockup');
        if (path === '/workspace/task-board.html') {
          await pending;
          return route.fulfill({ json: { content: mockup } });
        }
        if (path === '/workspace/retry.html' && retry++ === 0)
          return route.fulfill({ status: 503, body: 'Unavailable' });
        if (path === '/workspace/retry.html')
          return route.fulfill({ json: { content: '<h1>Recovered</h1>' } });
        if (path === '/workspace/empty.html') return route.fulfill({ json: { content: '' } });
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      unexpected.push(url.pathname);
      return route.abort();
    });
    await page.goto('/');
    await expect(page.getByRole('status')).toContainText('Loading preview');
    release();
    const frame = page.frameLocator('iframe[title="task-board.html preview"]');
    await expect(frame.getByRole('heading', { name: 'Task board' })).toBeVisible();
    // A prose truncation overlay must never clip an interactive artifact.
    await expect(page.locator('.msg-bubble--collapsed:has(.html-preview-card)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    await frame.getByRole('combobox', { name: 'Design' }).selectOption('compact');
    await frame.getByRole('textbox', { name: 'Task name' }).fill('Review mockup');
    await frame.getByRole('button', { name: 'Add task' }).press('Enter');
    await expect(frame.getByRole('status')).toHaveText('1 tasks');
    await expect(frame.getByText('Parent isolated; network blocked')).toBeVisible();
    expect(await page.evaluate(() => document.body.dataset.previewAccess)).toBeUndefined();
    const toggle = page.getByRole('button', { name: /HTML task-board.html/ });
    await toggle.press('Enter');
    await expect(page.locator('iframe[title="task-board.html preview"]')).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.press('Enter');
    await expect(frame.getByRole('status')).toHaveText('1 tasks');
    await expect(frame.getByRole('combobox', { name: 'Design' })).toHaveValue('compact');
    expect(reads.filter((path) => path === '/workspace/task-board.html')).toHaveLength(1);
    await expect(page.getByRole('alert')).toContainText('503');
    const retryButton = page.getByRole('button', { name: 'Retry preview' });
    await retryButton.press('Enter');
    await expect(
      page
        .frameLocator('iframe[title="retry.html preview"]')
        .getByRole('heading', { name: 'Recovered' }),
    ).toBeVisible();
    await expect(page.locator('iframe[title="empty.html preview"]')).toBeVisible();
    for (const button of await page.locator('.html-preview-card button').all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`html-mockup-${theme}.png`),
      fullPage: true,
    });
    expect(unexpected).toEqual([]);
  });
}
