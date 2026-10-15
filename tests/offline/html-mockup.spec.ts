import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { deployedSecurityHeaders } from '../support/response-security';
import { HTML_PREVIEW_BOOTSTRAP, htmlPreviewPolicy } from '../../server/html-preview-shell';

const hostHeaders = deployedSecurityHeaders();
const previewHeaders: Record<string, string> = {
  ...hostHeaders,
  'content-security-policy': htmlPreviewPolicy(),
  'cache-control': 'no-store',
};
delete previewHeaders['x-frame-options'];

// Actual transcript renderer, request interception only; no app or model process.
function bundle(apiBaseUrl = '') {
  return build({
    entryPoints: [resolve('tests/fixtures/html-mockup.tsx')],
    bundle: true,
    write: false,
    outfile: '/tmp/mitzo-html-mockup.js',
    jsx: 'automatic',
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({ VITE_API_BASE_URL: apiBaseUrl }),
    },
    alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
  });
}
const bundled = bundle();
const nativeBundled = bundle('http://mitzo-ui.test');

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
<button type="button" onclick="document.getElementById('inline-result').textContent='Inline handler works'">Inline action</button><p id="inline-result"></p>
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

for (const native of [false, true])
  for (const theme of ['dark', 'light']) {
    test(`HTML mockup: ${native ? 'cross-origin ' : ''}inline clicks, retained state, retry and isolation (${theme})`, async ({
      page,
      isMobile,
    }, testInfo) => {
      const files = (await (native ? nativeBundled : bundled)).outputFiles!;
      const parentOrigin = native ? 'http://native-ui.test' : 'http://mitzo-ui.test';
      // A native webview loads its bundle locally and uses the configured remote
      // API. Retain a strict parent policy while allowing only that API/frame host.
      const parentHeaders = native
        ? {
            ...hostHeaders,
            'content-security-policy':
              hostHeaders['content-security-policy'].replace(
                "connect-src 'self' ws: wss:",
                "connect-src 'self' ws: wss: http://mitzo-ui.test",
              ) + '; frame-src *',
          }
        : hostHeaders;
      const cors = {
        'Access-Control-Allow-Origin': parentOrigin,
        'Access-Control-Allow-Credentials': 'true',
      };
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
        if (
          ![parentOrigin, 'http://mitzo-ui.test'].includes(url.origin) ||
          route.request().method() !== 'GET'
        ) {
          unexpected.push(route.request().url());
          return route.abort();
        }
        if (url.pathname === '/api/html-preview') {
          expect(url.search).toBe('');
          return route.fulfill({
            body: HTML_PREVIEW_BOOTSTRAP,
            contentType: 'text/html',
            headers: {
              ...previewHeaders,
              'content-security-policy': htmlPreviewPolicy(native ? [parentOrigin] : []),
            },
          });
        }
        if (url.pathname === '/api/files/read') {
          const path = url.searchParams.get('path');
          reads.push(path!);
          expect(url.searchParams.get('sessionId')).toBe('mockup');
          if (path === '/workspace/task-board.html') {
            await pending;
            return route.fulfill({ json: { content: mockup }, headers: cors });
          }
          if (path === '/workspace/retry.html' && retry++ === 0)
            return route.fulfill({ status: 503, body: 'Unavailable', headers: cors });
          if (path === '/workspace/retry.html')
            return route.fulfill({ json: { content: '<h1>Recovered</h1>' }, headers: cors });
          if (path === '/workspace/empty.html')
            return route.fulfill({ json: { content: '' }, headers: cors });
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
            headers: parentHeaders,
            body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
          });
        unexpected.push(url.pathname);
        return route.abort();
      });
      await page.goto(parentOrigin + '/');
      await expect(page.locator('.html-preview-card').first().getByRole('status')).toContainText(
        'Loading preview',
      );
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
      await frame.getByRole('button', { name: 'Inline action' }).click();
      await expect(frame.getByText('Inline handler works')).toBeVisible();
      expect(
        await page.evaluate(() => {
          const button = document.createElement('button');
          button.setAttribute('onclick', 'window.hostCspBypassed=true');
          document.body.append(button);
          button.click();
          button.remove();
          return Reflect.has(window, 'hostCspBypassed');
        }),
      ).toBe(false);
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
      // A preview script must not exfiltrate via its own frame navigation,
      // including in a native parent which has no restrictive frame policy yet.
      const navigationBlocked = page.waitForEvent('console', {
        predicate: (message) =>
          /blocked\.invalid/.test(message.text()) &&
          /[Cc]ontent [Ss]ecurity|frame-src/.test(message.text()),
        timeout: 5000,
      });
      await frame.locator('body').evaluate(() => {
        window.location.href = 'https://blocked.invalid/leak';
      });
      await navigationBlocked;
      expect(unexpected).toEqual([]);
    });
  }
