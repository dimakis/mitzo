import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { deployedSecurityHeaders } from '../support/response-security';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/session-documents.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/session-documents.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['dark', 'light'])
  test(`Resources keeps a file without a task and restores saved versions (${theme})`, async ({
    page,
  }, info) => {
    const compiled = await bundle;
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light', reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let kept = false,
      failed = false;
    const requests: string[] = [];
    const saved = {
      id: 'a'.repeat(32),
      sessionId: 'one',
      title: 'Report with a long descriptive filename for the cleanup proposal',
      filename: 'report.md',
      revision: 1,
      sha256: 'b'.repeat(64),
      size: 8,
      sourceKey: 'file:/task/report.md',
      sourcePath: '/task/report.md',
      createdAt: 1,
    };
    const workspace = Array.from({ length: 17 }, (_, i) => ({
      path: `/task/report-${i}.md`,
      title: i === 0 ? saved.title : `Report ${i}`,
      evidence: i === 0 ? 'created' : 'linked',
    }));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.origin !== 'http://mitzo-ui.test') return route.abort();
      if (path === '/fixture.js' || path === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles.find((file) =>
            file.path.endsWith(path.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (path.startsWith('/api/')) requests.push(path);
      if (path.endsWith('/outputs'))
        return route.fulfill({ json: { outputs: [], candidates: [] } });
      if (path.endsWith('/documents'))
        return route.fulfill({
          json: {
            saved: kept && path.includes('/one/') ? [saved] : [],
            savedHasMore: kept && path.includes('/one/'),
            savedCursor: kept && path.includes('/one/') ? { createdAt: 1, id: saved.id } : null,
            workspace: path.includes('/one/') ? workspace : [],
            telos: [],
            discoveryLimit: 100,
          },
        });
      if (path.endsWith('/preview'))
        return route.fulfill({
          json: {
            path: '/task/report.md',
            filename: 'report.md',
            sha256: saved.sha256,
            size: 8,
            content: '# Report',
          },
        });
      if (path.endsWith('/keep')) {
        const input = route.request().postDataJSON();
        expect(input.source.sha256).toBe(saved.sha256);
        kept = true;
        if (!failed) {
          failed = true;
          return route.abort();
        }
        return route.fulfill({ json: { document: saved } });
      }
      if (path.endsWith('/saved'))
        return route.fulfill({
          json: {
            documents: [{ ...saved, id: 'c'.repeat(32), title: 'Earlier saved report' }],
            cursor: null,
            hasMore: false,
          },
        });
      if (path.endsWith('/versions'))
        return route.fulfill({
          json: {
            versions: url.searchParams.has('before')
              ? [{ ...saved, revision: 2 }, saved]
              : Array.from({ length: 50 }, (_, i) => ({ ...saved, revision: 52 - i })),
          },
        });
      if (path.endsWith(`/saved/${saved.id}`))
        return route.fulfill({ json: { document: saved, content: '# Report' } });
      if (path.startsWith('/api/')) return route.fulfill({ json: {} });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    const documents = page.getByRole('region', { name: 'Documents' });
    await expect(documents.getByRole('button', { name: /^Preview / })).toHaveCount(8);
    await documents.getByRole('button', { name: 'Next documents' }).click();
    await expect(
      documents.getByRole('button', { name: 'Preview Report 8', exact: true }),
    ).toBeVisible();
    await documents.getByRole('button', { name: 'Previous documents' }).click();
    const trigger = documents.getByRole('button', { name: `Preview ${saved.title}`, exact: true });
    await trigger.click();
    await expect(documents.getByText('In workspace · not kept', { exact: true })).toBeVisible();
    const keep = documents.getByRole('button', { name: 'Keep a copy' });
    expect((await keep.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`document-preview-${theme}.png`) });
    await keep.click();
    await expect(documents.getByRole('alert')).toBeVisible();
    await keep.click();
    await expect(documents.getByText('Saved · version 1', { exact: true })).toBeVisible();
    await expect(documents.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    expect(await documents.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`document-saved-${theme}.png`) });
    await page.reload();
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    await documents.getByRole('button', { name: 'Load older saved documents' }).click();
    await expect(
      documents.getByRole('button', { name: 'Preview Earlier saved report' }),
    ).toBeVisible();
    await documents
      .getByRole('button', { name: `Preview ${saved.title}`, exact: true })
      .first()
      .click();
    await expect(documents.getByText('# Report', { exact: true })).toBeVisible();
    await expect(documents.getByRole('combobox', { name: 'Saved version' })).toHaveValue('1');
    await documents.getByRole('button', { name: 'Load earlier versions' }).click();
    await expect(documents.getByRole('option', { name: 'Version 2', exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Switch chat' }).click();
    await page.getByRole('button', { name: 'Open session tray' }).click();
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    await expect(documents.getByText('No documents found yet.')).toBeVisible();
    expect(requests.some((path) => /\/chat\/.*send|\/internal\//.test(path))).toBe(false);
    expect(errors).toEqual([]);
  });
