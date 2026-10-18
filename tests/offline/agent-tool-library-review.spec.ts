import { editProfile, openToolLibrary } from '../support/agent-library';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const tools = JSON.parse(
  readFileSync(new URL('../fixtures/agent-tool-catalog.json', import.meta.url), 'utf8'),
);
import { deployedSecurityHeaders } from '../support/response-security';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-tool-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/agent-tool-library-review.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['dark', 'light'])
  test(`tool library review: creation ownership and usage loading, retry and results (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const compiled = await bundle;
    let releaseCatalog!: () => void;
    let catalogRequests = 0;
    const pending = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light', reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles!.find((file) =>
            file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/agent-library') {
        catalogRequests++;
        if (catalogRequests === 1) {
          await pending;
          return route.fulfill({ status: 503, json: { error: 'Profile catalog unavailable' } });
        }
        return route.fulfill({
          json: {
            drafts: [],
            versions: [
              {
                profileId: 'reader',
                revision: 1,
                contentHash: 'a'.repeat(64),
                definition: {
                  name: 'Evidence reader',
                  descriptor: 'Reviews sources',
                  role: 'agent',
                  instructions: 'Read evidence.',
                  expectedOutput: 'Brief',
                  acceptanceCriteria: ['Cite sources'],
                  modelPolicyRole: 'agent',
                  tools: [{ id: 'mitzo:Read', version: 1 }],
                },
              },
            ],
          },
        });
      }
      if (url.pathname === '/api/agent-library/tools')
        return route.fulfill({
          json: {
            tools,
          },
        });
      if (url.pathname === '/api/agent-tasks') return route.fulfill({ json: [] });
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({ json: { accounts: [], models: [], sessions: [] } });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'lavender' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await openToolLibrary(page);
    await expect(page.getByRole('button', { name: 'New agent', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Create with Agent Builder', exact: true }),
    ).toHaveCount(0);
    const library = page.getByRole('region', { name: 'Tool library', exact: true });
    await expect(library.getByRole('status')).toHaveText('Loading profile usage…');
    await expect(library.getByText(/No explicit references/)).toHaveCount(0);
    await expect(library.getByText('Profiles using this tool', { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`tool-library-loading-${theme}.png`),
      fullPage: true,
    });
    releaseCatalog();
    await expect(library.getByRole('alert')).toContainText('Profile catalog unavailable');
    await expect(library.getByText(/No explicit references/)).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`tool-library-error-${theme}.png`),
      fullPage: true,
    });
    await library.getByRole('button', { name: 'Retry profiles', exact: true }).click();
    await expect(library.getByRole('alert')).toHaveCount(0);
    const read = library
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Read', exact: true }) });
    await expect(library.getByRole('article')).toHaveCount(tools.length);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath(`tool-library-cards-${theme}.png`),
      fullPage: false,
    });
    const category = library.getByLabel('Category', { exact: true });
    const search = library.getByRole('searchbox', { name: 'Search tool library' });
    expect((await category.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await category.selectOption('Web');
    await search.fill('mitzo:Read');
    await expect(library.getByText('No matching tools', { exact: true })).toBeVisible();
    await library.getByRole('button', { name: 'Clear filters' }).click();
    await expect(library.getByRole('article')).toHaveCount(tools.length);
    await search.fill('mitzo:Read');
    await expect(library.getByRole('article')).toHaveCount(1);
    const toggle = read.locator('.tool-library-details > summary');
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(
      read.getByText('Existing session permissions, cancellation and runtime admission apply.'),
    ).toBeVisible();
    await read.getByText('Profiles using this tool', { exact: true }).click();
    await expect(read).toContainText('Evidence reader');
    await expect(read.getByText(/No explicit references/)).toHaveCount(0);
    await search.fill('mitzo:Write');
    const write = library
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Write', exact: true }) });
    await write.locator('.tool-library-details > summary').click();
    await write.getByText('Profiles using this tool', { exact: true }).click();
    await expect(write.getByText(/No explicit references/)).toBeVisible();
    await expect(library.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`tool-library-review-${theme}.png`),
      fullPage: true,
    });
    await search.fill('');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    const last = library.getByRole('article').last();
    await last.locator('.tool-library-details > summary').click();
    await last.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const captureGeometry = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      devicePixelRatio,
      fontSize: getComputedStyle(document.documentElement).fontSize,
      cards: Array.from(document.querySelectorAll('.tool-library-card'), (card) => ({
        name: card.querySelector('h2')?.textContent,
        height: card.getBoundingClientRect().height,
      })),
    }));
    await info.attach('large-text-catalog-geometry', {
      body: JSON.stringify(captureGeometry, null, 2),
      contentType: 'application/json',
    });
    console.log(
      'Large text catalog geometry',
      JSON.stringify({
        ...captureGeometry,
        cards: captureGeometry.cards.length,
        devicePixelHeight: captureGeometry.documentHeight * captureGeometry.devicePixelRatio,
      }),
    );
    expect(
      (await last.locator('.tool-library-details > summary').boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    await expect(last.locator('.tool-library-details > summary')).toBeInViewport();
    const largeTextCapture = await page.screenshot({
      path: info.outputPath(`tool-library-large-text-${theme}.png`),
      fullPage: true,
      // The catalog with 125% text exceeds WebKit's 32767 pixel image limit
      // on DPR 3 phones. Capture every CSS pixel without clipping content.
      scale: 'css',
    });
    // PNG IHDR dimensions prove that the complete document was captured at CSS
    // resolution, without changing the actual viewport, text or touch geometry.
    expect(largeTextCapture.readUInt32BE(16)).toBe(captureGeometry.documentWidth);
    expect(largeTextCapture.readUInt32BE(20)).toBe(captureGeometry.documentHeight);
    await search.fill('mitzo:Write');
    await page.getByRole('button', { name: 'Agent library', exact: true }).click();
    await editProfile(page);
    await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Evidence reader');
    await expect(page.getByRole('button', { name: 'New agent', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'New agent', exact: true }).click();
    await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('');
    await openToolLibrary(page);
    await expect(search).toHaveValue('mitzo:Write');
    await expect(library.getByRole('article')).toHaveCount(1);
  });
