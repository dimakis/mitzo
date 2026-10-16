import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { deployedSecurityHeaders } from '../support/response-security';

const artifact = '/api/telos/artifacts/' + 'a'.repeat(32);
const bundled = build({
  entryPoints: [resolve('tests/fixtures/telos-document-editing.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-telos-document.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({}) },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});

for (const theme of ['dark', 'light']) {
  test(`Telos document: edit, retry, resolve conflict and share new revision (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const files = (await bundled).outputFiles!;
    const revisions = ['# Quarterly review\n\nOriginal document.'];
    const requests: { expectedRevision: number; requestId: string; content: string }[] = [];
    let fail = true;
    const unexpected: string[] = [];
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async ({ files }: { files: File[] }) => {
          (window as unknown as { shared: string }).shared = await files[0].text();
        },
      });
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      if (url.pathname === artifact + '/document') {
        if (route.request().method() === 'PUT') {
          const input = route.request().postDataJSON();
          requests.push(input);
          if (fail) {
            fail = false;
            return route.fulfill({
              status: 503,
              json: { error: 'Save unavailable; your draft is preserved' },
            });
          }
          if (input.expectedRevision !== revisions.length)
            return route.fulfill({
              status: 409,
              json: {
                error:
                  'A newer revision is available. Review the latest version before saving; your draft is preserved.',
              },
            });
          revisions.push(input.content);
          return route.fulfill({
            json: {
              artifact: {
                id: 'a'.repeat(32),
                revision: revisions.length,
                url: `${artifact}?revision=${revisions.length}`,
              },
            },
          });
        }
        const revision = Number(url.searchParams.get('revision') || revisions.length);
        return route.fulfill({
          json: {
            path: `${artifact}?revision=${revision}`,
            name: 'dimitri-workday-self-evaluation-2026-q3.md',
            content: revisions[revision - 1],
            ext: '.md',
            revision,
            editable: true,
            previewUnavailable: false,
          },
        });
      }
      if (url.pathname === artifact)
        return route.fulfill({
          body: revisions[Number(url.searchParams.get('revision')) - 1],
          headers: {
            'Content-Type': 'text/markdown',
            'Content-Disposition': "attachment; filename*=UTF-8''review.md",
          },
        });
      if (url.pathname === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 1 } });
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname === '/files')
        return route.fulfill({
          contentType: 'text/html',
          headers: deployedSecurityHeaders(),
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (url.pathname === '/mitzo-icon.png')
        return route.fulfill({
          body: await readFile('frontend/public/mitzo-icon.png'),
          contentType: 'image/png',
        });
      unexpected.push(url.pathname);
      return route.abort();
    });
    await page.goto(
      '/files?' + new URLSearchParams({ path: artifact + '?revision=1', from: '/work/example' }),
    );
    await expect(page.getByRole('heading', { name: 'Quarterly review' })).toBeVisible();
    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    await edit.focus();
    await expect(edit).toBeFocused();
    expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await edit.click();
    const source = page.getByRole('textbox', { name: 'Document source' });
    await source.fill('# My updated review\n\nRetained draft.');
    const save = page.locator('.viewer-header').getByRole('button', { name: 'Save new revision' });
    await expect(save).toBeInViewport();
    await save.click();
    await expect(page.getByRole('status').filter({ hasText: 'Save unavailable' })).toBeVisible();
    if (isMobile) await expect(source).toHaveValue('# My updated review\n\nRetained draft.');
    else await expect(source).toContainText('Retained draft.');
    await page.reload();
    await edit.click();
    if (isMobile) await expect(source).toHaveValue('# My updated review\n\nRetained draft.');
    else await expect(source).toContainText('Retained draft.');
    // A concurrent save requires an explicit review before keeping this draft.
    revisions.push('# Another writer\n\nUpdated elsewhere.');
    await save.click();
    expect(requests[1].requestId).toBe(requests[0].requestId);
    await expect(page.getByRole('status').filter({ hasText: 'newer revision' })).toBeVisible();
    await page.getByRole('button', { name: 'Review latest version' }).click();
    await expect(page.getByRole('region', { name: 'Latest saved version' })).toContainText(
      '# Another writer',
    );
    await page.getByRole('button', { name: 'Keep my draft for next save' }).click();
    if (isMobile) await expect(source).toHaveValue('# My updated review\n\nRetained draft.');
    else await expect(source).toContainText('Retained draft.');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    await expect(save).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('telos-editing.png') });
    await save.click();
    await expect(page.getByRole('heading', { name: 'My updated review' })).toBeVisible();
    await expect(page).toHaveURL(/revision%3D3/);
    expect(new URL(page.url()).searchParams.get('from')).toBe('/work/example');
    expect(requests[2].expectedRevision).toBe(2);
    expect(requests[2].requestId).not.toBe(requests[1].requestId);
    expect(revisions[0]).toContain('Original document.');
    await page.getByRole('button', { name: 'File options', exact: true }).click();
    await page.getByRole('button', { name: 'Share file' }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: string }).shared))
      .toBe(revisions[2]);
    await page.screenshot({ path: testInfo.outputPath('telos-saved.png') });
    await edit.click();
    await source.fill('# Superseded draft');
    revisions.push('# Latest accepted\n\nAccepted elsewhere.');
    await save.click();
    await page.getByRole('button', { name: 'Review latest version' }).click();
    await page.getByRole('button', { name: 'Use latest version' }).click();
    await expect(page.getByRole('heading', { name: 'Latest accepted' })).toBeVisible();
    await expect(page).toHaveURL(/revision%3D4/);
    expect(revisions).toHaveLength(4);
    expect(unexpected).toEqual([]);
  });
}
