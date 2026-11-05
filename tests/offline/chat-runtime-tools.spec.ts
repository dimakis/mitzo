import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const output = build({
  entryPoints: [resolve('tests/fixtures/chat-runtime-tools.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  format: 'esm',
  outfile: '/tmp/mitzo-runtime-tools.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['dark', 'light'])
  test(`host chat runtime tools preserve drafts (${theme})`, async ({ page }, info) => {
    const files = (await output).outputFiles!;
    let legacyCommandReads = 0;
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/commands') {
        legacyCommandReads++;
        return route.fulfill({ json: [] });
      }
      if (url.pathname === '/api/skills') {
        expect(url.searchParams.get('runtime')).toBe('ordinary');
        return route.fulfill({
          json: [
            { name: 'mockup', scope: 'bundled', description: 'Create a mockup' },
            {
              name: 'restricted',
              scope: 'bundled',
              description: 'Restricted',
              unavailableReason:
                'This skill requires tool restrictions that this runtime cannot enforce.',
            },
          ],
        });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) =>
        url.pathname.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    for (const path of ['/chat?draft=runtime-tools', '/chat/host-chat']) {
      await page.goto(path);
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      await input.fill('Retained host draft');
      const toggle = page.getByRole('button', { name: 'More composer actions' });
      if (await toggle.isVisible()) await toggle.click();
      await expect(page.getByRole('button', { name: 'Commands' })).toBeEnabled();
      const terminal = page.getByRole('link', { name: 'Terminal', exact: true });
      await expect(terminal).toHaveAttribute(
        'href',
        path.includes('host-chat')
          ? /sessionId=host-chat/
          : /returnTo=%2Fchat%3Fdraft%3Druntime-tools/,
      );
      await page.getByRole('button', { name: 'Commands' }).click();
      await expect(page.getByRole('button', { name: /\/restricted/ })).toBeDisabled();
      await page.getByRole('button', { name: /\/mockup/ }).click();
      await expect(input).toHaveValue('/mockup Retained host draft');
      if (await toggle.isVisible()) await toggle.click();
      await terminal.click();
      await page.getByRole('link', { name: 'Back to chat' }).click();
      await expect(input).toHaveValue('/mockup Retained host draft');
      await page.screenshot({ path: info.outputPath(`runtime-tools-${theme}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(legacyCommandReads).toBe(0);
  });
