import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { pdfFixture } from '../support/pdf-fixture';
import { createTelosWorkFixtures } from '../../server/__tests__/fixtures/telos-work-fixtures';

test.use({ baseURL: 'https://mitzo-ui.test' });
const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-outcomes-workspace.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  format: 'esm',
  write: false,
  outfile: '/tmp/telos-first-use.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"BASE_URL":"/"}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`Telos first use: ten reports, stable layout and readable saved PDFs (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    test.setTimeout(60000);
    const files = (await bundle).outputFiles;
    const base = createTelosWorkFixtures().homeStudio.items[0];
    const parent = {
      ...base,
      itemId: 'qc',
      summary: 'Quarterly Connections',
      kind: null,
      parentId: null,
      intent: 'Review each associate with the manager.',
    };
    const children = Array.from({ length: 10 }, (_, i) => ({
      ...base,
      itemId: `associate-${i}`,
      summary: `Associate ${i}`,
      kind: null,
      parentId: 'qc',
      intent:
        'Review accomplishments and agree priorities. ' +
        'Source details and evidence. '.repeat(100),
    }));
    const records = [parent, ...children];
    const pdf = {
      id: 'a'.repeat(32),
      itemId: children[0].itemId,
      filename: 'associate-qc.pdf',
      title: 'Associate 0 — original QC',
      revision: 1,
      sha256: 'b'.repeat(64),
      size: pdfFixture().length,
      url: `/api/telos/artifacts/${'a'.repeat(32)}?revision=1`,
      sourceKind: 'session_artifact',
    };
    const counts = new Map<string, number>();
    const unexpected: string[] = [],
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light', reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (path.startsWith('/todos'))
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
        });
      if (path === '/mitzo-wordmark.png')
        return route.fulfill({
          body: await readFile(resolve('frontend/public/mitzo-wordmark.png')),
          contentType: 'image/png',
        });
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (path === '/api/telos/work/collection')
        return route.fulfill({ json: { records, failures: [], profiles: ['manual', 'work'] } });
      const work = /^\/api\/telos\/work\/items\/([^/]+)(\/record|\/lifecycle)?$/.exec(path);
      if (work) {
        const record = records.find((record) => record.itemId === work[1]);
        if (!record) return route.fulfill({ status: 404, json: {} });
        if (work[2] === '/record') return route.fulfill({ json: record });
        if (work[2] === '/lifecycle')
          return route.fulfill({ status: 503, json: { error: 'Fixture controls unavailable' } });
        return route.fulfill({
          json: {
            itemId: record.itemId,
            parentId: record.parentId,
            kind: record.kind,
            revision: 'f'.repeat(64),
            links: [],
            assignments: [],
            sources: [],
            attempts: [],
          },
        });
      }
      if (path.match(/^\/api\/telos\/items\/[^/]+\/artifacts$/))
        return route.fulfill({
          json: { artifacts: path.includes('associate-0/') ? [pdf] : [], limit: 100 },
        });
      if (path.endsWith('/versions'))
        return route.fulfill({ json: { artifacts: [pdf], cursor: null, hasMore: false } });
      if (path === `/api/telos/artifacts/${pdf.id}`)
        return route.fulfill({ body: pdfFixture(), contentType: 'application/pdf' });
      if (path === '/pdfjs/pdf.worker.min.mjs')
        return route.fulfill({
          body: await readFile(resolve(pdfRoot, 'build/pdf.worker.min.mjs')),
          contentType: 'application/javascript',
        });
      if (path.startsWith('/pdfjs/'))
        return route.fulfill({
          body: await readFile(resolve(pdfRoot, path.slice(7))),
          contentType: path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream',
        });
      if (path === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] },
        });
      unexpected.push(path);
      return route.fulfill({ status: 503, json: { error: 'Unexpected fixture request' } });
    });
    await page.goto('/todos');
    await page.getByRole('button', { name: 'Expand Quarterly Connections', exact: true }).click();
    for (let i = 0; i < 10; i++)
      await expect(page.getByRole('button', { name: `Associate ${i}`, exact: true })).toBeVisible();
    await expect(page.getByText('10 children', { exact: true })).toBeVisible();
    expect(counts.get('/api/telos/work/collection')).toBe(1);
    expect(counts.get('/api/telos/work/records') ?? 0).toBe(0);
    expect([...counts.keys()].some((path) => /^\/api\/telos\/work\/items\/[^/]+$/.test(path))).toBe(
      false,
    );
    await page.getByRole('button', { name: 'Associate 0', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Associate 0', exact: true })).toBeVisible();
    await expect(page.locator('.todo-detail-page:not(.telos-canonical-page)')).toHaveCount(0);
    await expect(page.getByLabel('Brief summary')).toBeVisible();
    await expect(page.getByText('No dedicated conversation yet.', { exact: true })).toBeVisible();
    expect(counts.get('/api/telos/work/items/associate-0')).toBe(1);
    await expect(page.getByText('Details & context', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`telos-overview-${theme}.png`) });
    await page.getByRole('button', { name: 'Materials', exact: true }).click();
    await page.getByRole('link', { name: pdf.title, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: pdf.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Page 1 of 2', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('img', { name: `${pdf.title} — page 1`, exact: true }),
    ).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeGreaterThan(isMobile ? 270 : 1000);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(isMobile ? 320 : 1440);
    await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(
      dialog.getByRole('img', { name: `${pdf.title} — page 2`, exact: true }),
    ).toBeVisible();
    expect(counts.get(`/api/telos/artifacts/${pdf.id}`)).toBe(1);
    expect(counts.get(`/api/telos/artifacts/${pdf.id}/document`) ?? 0).toBe(0);
    await expect(dialog.getByText('Rendering page…', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`telos-pdf-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
