import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/session-launch.tsx')],
  external: ['/*.png', '/*.svg'],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-session-launch-recovery.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
const handover =
  '# Coordinator handover\n\nKeep the exact priorities. Claude’s personal subscription. 🔧';
for (const theme of ['dark', 'light']) {
  for (const outcome of ['refusal', 'uncertain']) {
    test(`session launch handover download and ${outcome} (${theme})`, async ({
      page,
      isMobile,
    }, info) => {
      const files = (await bundled).outputFiles!;
      const errors: string[] = [];
      const sends: Array<Record<string, unknown>> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const file = files.find(
          (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
        );
        if (file)
          return route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (path === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
          });
        if (/^\/(openai|claude|openshell|github)-mark.svg$/.test(path))
          return route.fulfill({
            body: await readFile(resolve('frontend/public' + path)),
            contentType: 'image/svg+xml',
          });
        if (path === '/api/chat/runtime/capabilities')
          return route.fulfill({ json: localInventoryFixture() });
        if (path === '/api/accounts') return route.fulfill({ json: { accounts: [] } });
        if (path.endsWith('/handover.md'))
          return route.fulfill({
            body: handover,
            contentType: 'text/markdown; charset=utf-8',
            headers: { 'Content-Disposition': 'attachment; filename="handover.md"' },
          });
        if (path.endsWith('/approve')) {
          sends.push(route.request().postDataJSON());
          if (outcome === 'uncertain') return route.abort('failed');
          if (sends.length === 1)
            return route.fulfill({
              status: 409,
              json: {
                error: 'Additional tool Unknown is unavailable. Review the tool selection.',
                code: 'session_launch_preflight_refused',
                effectStatus: 'not_started',
              },
            });
          return route.fulfill({ json: { state: 'running', childSessionId: 'child' } });
        }
        if (path === '/fixture-receipt')
          return route.fulfill({
            json: { state: 'running', childSessionId: 'child', revision: 2 },
          });
        return route.fulfill({ json: [] });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      if (theme === 'light') await page.addStyleTag({ content: 'html {font-size:125%}' });
      await page
        .getByRole('group', { name: 'Handover' })
        .getByRole('button', { name: 'File options' })
        .click();
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download file' }).click();
      const download = await downloadEvent;
      expect(await download.failure()).toBeNull();
      expect(await readFile((await download.path())!, 'utf8')).toBe(handover);
      expect(sends).toHaveLength(0);
      const trigger = page.getByRole('button', { name: 'Review new session' });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Review new session' });
      await dialog.getByLabel('Handoff prompt').fill(handover);
      await dialog.getByText('Session settings', { exact: true }).click();
      await dialog
        .getByLabel('Additional tools')
        .fill('AgentCommunication, TaskExecution, StartSession, SessionTimers');
      const approve = dialog.getByRole('button', { name: 'Approve & start' });
      await expect(approve).toBeEnabled();
      await approve.click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByLabel('Handoff prompt')).toHaveValue(handover);
      await expect(page.getByLabel('Original chat draft')).toHaveValue(
        'Keep my original chat draft',
      );
      if (outcome === 'refusal') {
        await expect(approve).toBeEnabled();
        await expect(dialog.getByRole('button', { name: 'Check request' })).toHaveCount(0);
        await dialog.getByLabel('Title', { exact: true }).fill('Corrected coordinator handover');
      } else {
        await expect(dialog.getByRole('button', { name: 'Check request' })).toBeVisible();
        await expect(approve).toHaveCount(0);
        await expect(dialog.getByLabel('Title', { exact: true })).toBeDisabled();
      }
      expect(sends).toHaveLength(1);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`session-launch-${outcome}-${theme}.png`) });
      if (outcome === 'refusal') {
        await approve.click();
        await expect(dialog).toBeHidden();
        expect(sends).toHaveLength(2);
        expect(sends[1].prompt).toBe(handover);
        await expect(page.getByRole('link', { name: 'Open chat', exact: true })).toHaveAttribute(
          'href',
          '/chat/child',
        );
      } else {
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
      expect(errors).toEqual([]);
    });
  }
}
