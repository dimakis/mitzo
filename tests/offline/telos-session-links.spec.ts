import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-session-links.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-telos-session-links.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
const context = {
  version: 1,
  itemId: 'slice',
  role: 'worker',
  leadConversationId: 'former-lead',
  brief: { revision: 'original', sha256: 'a'.repeat(64), text: 'Reviewed task' },
  parentCriteria: [],
  overallGoal: { itemId: 'feature', revision: 'original', text: 'Feature' },
  sources: [],
  artifacts: [],
};
for (const theme of ['dark', 'light'])
  for (const state of ['current', 'stopped', 'unknown']) {
    test(`current Telos reporting link preserves the composer (${theme}, ${state})`, async ({
      page,
      isMobile,
    }, info) => {
      const files = (await bundle).outputFiles;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/sessions/worker/meta')
          return route.fulfill({
            json: {
              sessionId: 'worker',
              telosWorkRoleContext: context,
              telosSessionCoordination:
                state === 'unknown'
                  ? { diagnostic: 'coordination_unavailable' }
                  : {
                      itemId: 'slice',
                      role: 'worker',
                      assignment: 'current',
                      reportingTo: {
                        conversationId: 'current-lead',
                        availability: 'available',
                        executionPhase: state === 'stopped' ? 'TERMINAL' : 'RUNNING',
                      },
                      diagnostic: state === 'stopped' ? 'assigned_coordinator_unavailable' : null,
                    },
            },
          });
        const file = files.find(
          (value) =>
            url.pathname === (value.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
        );
        if (file)
          return route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (url.pathname !== '/') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.goto('/');
      const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
      await composer.fill('Preserve the current draft.');
      const link = page.getByRole('link', { name: 'Return to lead chat' });
      if (state === 'current') {
        await expect(link).toHaveAttribute('href', '/chat/current-lead');
        await link.focus();
        await expect(link).toBeFocused();
        await link.press('Enter');
      } else {
        await expect(page.getByRole('status')).toHaveText(
          'Current lead unavailable. Review the assignment in linked work.',
        );
        await expect(link).toHaveCount(0);
      }
      await expect(composer).toHaveValue('Preserve the current draft.');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({ path: info.outputPath(`telos-session-links-${theme}-${state}.png`) });
    });
  }
