import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/approved-chat.tsx')],
  bundle: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  write: false,
  outfile: '/tmp/mitzo-approved-chat.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`approved chat: accent, voice, commands, resources and compaction (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundled).outputFiles!;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') return route.abort();
      if (path === '/api/config')
        return route.fulfill({
          json: { contextBlocks: { 'Release plan': { path: 'plan.md', sizeBytes: 1200 } } },
        });
      if (path === '/api/skills')
        return route.fulfill({
          json: [{ name: 'simplify', description: 'Simplify the selected code', scope: 'bundled' }],
        });
      if (path === '/api/commands')
        return route.fulfill({
          json: [{ name: 'models', description: 'List models', scope: 'native' }],
        });
      if (
        [
          '/mitzo-wordmark.png',
          '/mitzo-icon.png',
          '/openshell-mark.svg',
          '/github-mark.svg',
        ].includes(path)
      )
        return route.fulfill({
          body: await readFile(resolve('frontend/public', path.slice(1))),
          contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body{margin:0;height:100%;overflow:hidden}.workspace-tabs{position:fixed;bottom:0;inset-inline:0;min-height:64px;display:flex;align-items:center;justify-content:center}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' }),
      settings = page.getByRole('button', { name: /^Workspace controls/ });
    const composer = await page.locator('.chat-input-row').boundingBox();
    expect(composer!.y + composer!.height).toBeGreaterThan(650);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveText('');
    await page.screenshot({ path: testInfo.outputPath(`approved-chat-${theme}-closed.png`) });
    for (const accent of ['mint', 'teal']) {
      await page.evaluate((accent) => (document.documentElement.dataset.accent = accent), accent);
      await settings.click();
      const heading = page.locator('.agent-settings-header strong');
      expect(
        await heading.evaluate((element) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--color-accent)';
          document.body.append(probe);
          const matches = getComputedStyle(probe).color === getComputedStyle(element).color;
          probe.remove();
          return matches;
        }),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`approved-chat-${theme}-${accent}-settings.png`),
      });
      await input.click();
    }
    await input.fill('Keep this draft');
    if (isMobile) await page.getByRole('button', { name: 'More composer actions' }).click();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    await page.getByText('/simplify', { exact: true }).click();
    await expect(input).toHaveValue('/simplify Keep this draft');
    await expect(page.getByTestId('sent-count')).toHaveText('0');
    await page.getByRole('button', { name: 'Record voice message' }).click();
    for (const text of ['Words', 'Words arrive', 'Words arrive one by one']) {
      await page.evaluate(
        (text) => window.dispatchEvent(new CustomEvent('fixture-transcript', { detail: text })),
        text,
      );
      await expect(page.locator('.voice-partial em')).toHaveText(text);
    }
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(input).toHaveValue('/simplify Keep this draft Words arrive one by one');
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'References' }).click();
    expect(await page.getByTestId('reference-domain').count()).toBeLessThanOrEqual(8);
    const search = page.getByRole('textbox', { name: 'Search references' });
    await search.fill('github');
    await page.getByTestId('reference-domain').click();
    await page.getByRole('button', { name: /pull\/12/ }).click();
    await expect(page.getByText('Checks not reported')).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(search).toHaveValue('github');
    await expect(page.getByRole('tab', { name: 'References' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('tab', { name: 'Context', exact: true }).click();
    await page.getByRole('button', { name: /Context compacted/ }).click();
    await expect(page.getByText(/condensed range is unavailable/)).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const boot = page.getByRole('button', { name: /4 sources/ });
    await boot.click();
    await page.getByRole('button', { name: 'View full markdown' }).click();
    await expect(page.getByRole('dialog', { name: 'Boot context full markdown' })).toBeVisible();
    await page.getByRole('button', { name: 'Close boot context' }).click();
    await expect(page.getByRole('dialog', { name: 'Resources', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`approved-chat-${theme}-context.png`) });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(input).toHaveValue('/simplify Keep this draft Words arrive one by one');
    if (theme === 'dark') {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const logo = page.getByRole('button', { name: 'Replay Mitzo waterfall' }),
        canvas = page.locator('.chat-welcome canvas');
      await logo.dblclick();
      await expect(canvas).toBeVisible();
      await expect(logo).toBeHidden();
      await expect(logo).toBeVisible({ timeout: 10000 });
      await expect(canvas).toBeHidden();
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByTestId('sent-count')).toHaveText('1');
      await expect(canvas).toBeVisible();
      await expect(canvas).toBeHidden({ timeout: 5000 });
      await expect(logo).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
