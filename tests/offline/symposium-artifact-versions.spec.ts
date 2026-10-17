import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import express from 'express';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createTelosArtifactRouter } from '../../server/telos-artifact-routes';
import { createCollaborationRetainedArtifactFixture } from '../../server/__tests__/fixtures/collaboration-retained-artifacts';
import { listenOnLoopback, closeTestServer } from '../../server/__tests__/loopback-test-server';
import { deployedSecurityHeaders } from '../support/response-security';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-artifact-versions.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/symposium-artifacts.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({}) },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(`saved artifact: exact older preview/export and current refusal (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    const fixture = createCollaborationRetainedArtifactFixture();
    const save = (revision: number) =>
      fixture.store.save({
        itemId: fixture.itemId,
        filename: 'chat-experience-plan.md',
        title: 'Chat experience plan',
        bytes: Buffer.from(
          `# Saved plan ${revision}\n\n${revision === 1 ? 'Older exact words, π and retained spacing.' : 'Latest saved words.'}`,
        ),
        sessionId: 'missing-original-chat',
      });
    const older = save(1);
    save(2);
    let authorized = true;
    const app = express();
    app.use((req, res, next) => {
      if (!authorized || req.headers['x-fixture-operator'] !== 'yes') {
        res.status(403).json({ error: 'Access revoked' });
        return;
      }
      next();
    });
    app.use(
      createTelosArtifactRouter({
        dbPath: () => fixture.path,
        operatorAuth: (_req, res, next) => {
          res.locals.authSession = { id: 'synthetic-operator' };
          next();
        },
        verifyInternal: () => false,
        sessionId: () => undefined,
        readFile: async () => {
          throw Error('No workspace access');
        },
      }),
    );
    const server = await listenOnLoopback(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Loopback missing');
    const origin = `http://127.0.0.1:${address.port}`;
    const unexpected: string[] = [];
    page.on('pageerror', (error) => console.error('Fixture page error:', error.message));
    const writes: string[] = [];
    try {
      const assets = (await bundle).outputFiles!;
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: async ({ files }: { files: File[] }) => {
            (window as unknown as { shared: string[] }).shared ??= [];
            (window as unknown as { shared: string[] }).shared.push(await files[0].text());
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
        if (url.pathname.startsWith('/api/telos/')) {
          if (route.request().method() !== 'GET') {
            writes.push(url.pathname);
            return route.fulfill({ status: 403, json: { error: 'Fixture is read-only' } });
          }
          const response = await route.fetch({
            url: origin + url.pathname + url.search,
            headers: { 'x-fixture-operator': 'yes' },
          });
          return route.fulfill({ response });
        }
        const asset = assets.find(
          (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
        );
        if (asset)
          return route.fulfill({
            body: asset.text,
            contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (url.pathname === '/api/git/info')
          return route.fulfill({ json: { branch: 'synthetic', worktrees: [] } });
        if (url.pathname === '/api/files/roots') return route.fulfill({ json: { roots: [] } });
        if (url.pathname === '/work' || url.pathname === '/files')
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
      await page.goto('https://mitzo-ui.test/work?item=' + fixture.itemId);
      const open = page.getByRole('link', { name: 'Chat experience plan', exact: true });
      await expect(open).toBeVisible();
      await open.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Saved plan 2' })).toBeVisible();
      await page.getByRole('combobox', { name: 'Version' }).selectOption('1');
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      save(3); // Later edits cannot retarget the already selected version.
      const dialog = page.getByRole('dialog', { name: 'Chat experience plan' });
      await dialog.getByText('Provenance', { exact: true }).click();
      await expect(dialog.getByText('missing-original-chat', { exact: true })).toBeVisible();
      await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const control of [
        page.getByRole('combobox', { name: 'Version' }),
        page.getByRole('button', { name: 'Done', exact: true }),
        page.getByRole('button', { name: 'Close', exact: true }),
      ]) {
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const bounds = await dialog.boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
      const footer = await page.getByRole('button', { name: 'Done', exact: true }).boundingBox();
      expect(footer!.y).toBeGreaterThanOrEqual(0);
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(901);
      expect(await dialog.getByRole('link', { name: 'Open Work item' }).getAttribute('href')).toBe(
        '/todos/' + fixture.itemId,
      );
      await dialog.getByText(older.sha256, { exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByText(older.sha256, { exact: true })).toBeInViewport();
      const path = testInfo.outputPath(`artifact-${theme}.png`);
      await page.screenshot({ path });
      if (testInfo.project.name === (theme === 'dark' ? 'mobile-webkit' : 'desktop-chromium')) {
        await mkdir('docs/design/assets', { recursive: true });
        await writeFile(
          `docs/design/assets/symposium-artifact-${theme === 'dark' ? 'mobile-dark' : 'desktop-light'}.png`,
          await page.screenshot(),
        );
      }
      await page.getByRole('button', { name: 'File options', exact: true }).click();
      await page.getByRole('button', { name: 'Share file', exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => (window as unknown as { shared?: string[] }).shared?.length ?? 0),
        )
        .toBe(1);
      expect(await page.evaluate(() => (window as unknown as { shared: string[] }).shared[0])).toBe(
        fixture.store.read(older.id, 1).bytes.toString(),
      );
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(open).toBeFocused();
      await page.keyboard.press('Enter');
      await page.getByRole('combobox', { name: 'Version' }).selectOption('1');
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      const selectedRoute = new URL(page.url()).pathname + new URL(page.url()).search;
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      await page.getByRole('button', { name: 'File options', exact: true }).click();
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      await expect(page).toHaveURL(/\/files\?/);
      expect(new URL(page.url()).searchParams.get('path')).toBe(older.url);
      expect(new URL(page.url()).searchParams.get('from')).toBe(selectedRoute);
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Chat experience plan' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Saved plan 1' })).toBeVisible();
      authorized = false;
      await page.getByRole('button', { name: 'File options', exact: true }).click();
      await page.getByRole('button', { name: 'Share file', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Access revoked');
      expect(
        await page.evaluate(() => (window as unknown as { shared?: string[] }).shared?.length ?? 0),
      ).toBe(0);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(unexpected).toEqual([]);
      expect(writes).toEqual([]);
    } finally {
      server.closeAllConnections();
      await closeTestServer(server);
      fixture.close();
    }
  });
