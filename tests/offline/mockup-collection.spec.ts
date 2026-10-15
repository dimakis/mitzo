import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { HTML_PREVIEW_BOOTSTRAP, htmlPreviewPolicy } from '../../server/html-preview-shell';
import { deployedSecurityHeaders } from '../support/response-security';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/mockup-collection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mockup-collection.js',
  jsx: 'automatic',
  external: ['/*.png', '/*.svg'],
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['light', 'dark'])
  test(`many mockups: search, revisions, return and session isolation (${theme})`, async ({
    page,
  }, info) => {
    const compiled = await bundle;
    const reads: string[] = [];
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark', reducedMotion: 'reduce' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/html-preview')
        return route.fulfill({
          body: HTML_PREVIEW_BOOTSTRAP,
          contentType: 'text/html',
          headers: { 'content-security-policy': htmlPreviewPolicy() },
        });
      if (url.pathname === '/api/files/read') {
        expect(url.searchParams.get('sessionId')).toBe('one');
        const path = url.searchParams.get('path')!;
        reads.push(path);
        if (path.endsWith('v001.html'))
          return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
        return route.fulfill({
          json: {
            path,
            content: `<h1>Revision ${path.endsWith('v010.html') ? 10 : 2}</h1><button onclick="this.textContent='Selected'">Select</button>`,
          },
        });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="mint" data-font="georgia"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Mockups' }).click();
    await expect(page.getByRole('button', { name: /^Open (Design|Release)/ })).toHaveCount(8);
    for (const tab of await page.getByRole('tab').all()) {
      const box = (await tab.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }
    await page.getByRole('button', { name: 'Next mockups' }).click();
    await expect(page.getByRole('button', { name: 'Open Design 31', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous mockups' }).click();
    expect(reads).toEqual([]); // Merely listing forty designs does not execute previews.
    await page.screenshot({ path: info.outputPath(`mockups-${theme}.png`) });
    const search = page.getByRole('searchbox', { name: 'Search mockups' });
    await search.fill('Release');
    await page
      .getByRole('button', { name: 'Open Release checklist with a longer descriptive name' })
      .click();
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Revision 10' }),
    ).toBeVisible();
    await page.frameLocator('iframe').getByRole('button', { name: 'Select' }).click();
    await expect(
      page.frameLocator('iframe').getByRole('button', { name: 'Selected' }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Revision', exact: true })
      .selectOption('/task/mockups/design-39/v002.html');
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Revision 2' }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Revision', exact: true })
      .selectOption('/task/mockups/design-39/v001.html');
    await expect(page.getByRole('alert')).toContainText('404');
    await page.getByRole('button', { name: 'Back to mockups' }).click();
    await expect(search).toHaveValue('Release');
    await expect(
      page.getByRole('button', { name: 'Open Release checklist with a longer descriptive name' }),
    ).toBeFocused();
    await expect(page.locator('iframe')).toHaveCount(0);
    await search.fill('missing');
    await expect(page.getByText('No matching mockups.')).toBeVisible();
    await page.getByRole('tab', { name: 'Mockups' }).focus();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Switch chat' }).click();
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Mockups' }).click();
    await expect(page.getByText(/No mockups linked/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  });
