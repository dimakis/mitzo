import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The actual responsive chat, existing simulated transport and ordinary shared
// components. Every network request is intercepted; no server or provider starts.
const bundle = build({
  entryPoints: [resolve('frontend/src/preview/main.tsx')],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/mitzo-symposium-design.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`Symposium approved design: real chat, Agents and fresh setup (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      const path = url.pathname;
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
      const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const agents = page.getByRole('button', { name: 'Agents, Architect, Reviewer' });
      await expect(agents).toBeVisible();
      if (isMobile) {
        await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
        const participantName = await agents
          .locator('.conversation-participant-names')
          .boundingBox();
        expect(participantName!.width).toBeGreaterThanOrEqual(64);
      }
      await expect(page.getByRole('tablist', { name: 'Symposium conversations' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Message recipient' })).toHaveCount(0);
      const provenance = page.getByLabel('Message details for Reviewer', { exact: true }).first();
      await expect(provenance).toBeVisible();
      const provenanceRecord = provenance.locator('..');
      await expect(provenanceRecord.getByText('OpenAI API', { exact: true })).toBeHidden();
      await provenance.click();
      await expect(provenanceRecord.getByText('OpenAI API', { exact: true })).toBeVisible();
      await provenance.click();
      const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
      await expect(input).toBeInViewport();
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      expect(
        await page
          .getByRole('group', { name: 'Who replies to this prompt' })
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const responderBounds = await page
        .getByRole('group', { name: 'Who replies to this prompt' })
        .boundingBox();
      expect(responderBounds!.width).toBeGreaterThanOrEqual(Math.min(240, width - 64));
      expect(responderBounds!.x + responderBounds!.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        style: '[data-ui-preview-banner] {visibility:hidden}',
        path: info.outputPath(`responders-${width}-${theme}.png`),
      });
      await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toContainText(
        'Reviewer',
      );
      expect(
        await page
          .getByRole('button', { name: 'Choose who replies' })
          .locator('span')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await input.fill('Keep this reviewer draft.');
      await page.getByLabel('Message actions', { exact: true }).first().click();
      await page.getByRole('button', { name: 'Share excerpt', exact: true }).click();
      const sharing = page.getByRole('dialog', { name: 'Share excerpt', exact: true });
      await expect(sharing.getByRole('textbox', { name: 'Excerpt to share' })).toBeVisible();
      await sharing.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(input).toHaveValue('Keep this reviewer draft.');
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toContainText(
        'Reviewer',
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await agents.click();
      await page.getByRole('button', { name: 'Close Agents', exact: true }).click();
      expect(await page.getByRole('dialog', { name: 'Agents', exact: true }).count()).toBe(0);
      await expect(agents).toBeFocused();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await agents.click();
      const dialog = page.getByRole('dialog', { name: 'Agents', exact: true });
      await expect(
        dialog.getByRole('checkbox', { name: 'Reads future discussion' }).first(),
      ).toBeDisabled();
      await expect(
        dialog.getByRole('checkbox', { name: 'Replies by default' }).first(),
      ).toBeDisabled();
      expect(
        await dialog
          .locator('.conversation-agents-body')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      expect(await agents.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(100);
      await page.screenshot({
        style: '[data-ui-preview-banner] { visibility: hidden; }',
        path: info.outputPath(`agents-${width}-${theme}.png`),
      });
      await dialog.getByRole('button', { name: 'Details for Architect' }).click();
      const details = page.getByRole('dialog', { name: 'Architect', exact: true });
      await expect(details.getByText('Vertex work', { exact: true })).toBeVisible();
      await expect(
        details.getByRole('button', { name: 'Draft reusable profile from this agent' }),
      ).toBeVisible();
      await details.getByRole('button', { name: 'Back to Agents' }).click();
      await dialog.getByRole('button', { name: 'Preview Architect conversation' }).click();
      await expect(page.getByRole('dialog', { name: 'Architect conversation' })).toBeVisible();
      await page.getByRole('button', { name: 'Back to Agents' }).click();
      await page.getByRole('button', { name: 'Add agent', exact: true }).click();
      const add = page.getByRole('dialog', { name: 'Add agent', exact: true });
      await expect(add.getByRole('alert')).toHaveCount(0);
      await add.getByRole('textbox', { name: 'Name in this chat' }).fill('Design reviewer');
      await add.getByRole('textbox', { name: 'Purpose' }).fill('Check the approved design.');
      await add.getByRole('combobox', { name: 'Context', exact: true }).selectOption('selected');
      await expect(add.getByText('Joining brief only.', { exact: true })).toBeVisible();
      await expect(add.getByRole('button', { name: 'Review joining brief' })).toBeDisabled();
      await add.locator('.conversation-agents-body').evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        style: '[data-ui-preview-banner] { visibility: hidden; }',
        path: info.outputPath(`fresh-setup-top-${width}-${theme}.png`),
      });
      await add
        .locator('.conversation-agents-body')
        .evaluate((el) => (el.scrollTop = el.scrollHeight));
      await expect(add.getByRole('button', { name: 'Back to Agents' })).toBeInViewport();
      await expect(add.getByRole('button', { name: 'Review joining brief' })).toBeInViewport();
      expect(await add.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(
        await add
          .locator('.conversation-agents-body')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        style: '[data-ui-preview-banner] { visibility: hidden; }',
        path: info.outputPath(`fresh-setup-${width}-${theme}.png`),
      });
      await add.getByRole('button', { name: 'Back to Agents' }).click();
      await page.getByRole('button', { name: 'Close Agents' }).click();
      await expect(input).toHaveValue('Keep this reviewer draft.');
      expect(
        await page
          .locator('.symposium-perspective-panel')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        style: '[data-ui-preview-banner] { visibility: hidden; }',
        path: info.outputPath(`conversation-${width}-${theme}.png`),
      });
      if (width === 320 || !isMobile) {
        await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
        await agents.click();
        const large = page.getByRole('dialog', { name: 'Agents', exact: true });
        expect(
          await large
            .locator('.conversation-agents-body')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await large.getByRole('button', { name: 'Add agent', exact: true }).click();
        const largeAdd = page.getByRole('dialog', { name: 'Add agent', exact: true });
        await expect(
          largeAdd.getByRole('button', { name: 'Review joining brief' }),
        ).toBeInViewport();
        expect(
          await largeAdd
            .locator('.conversation-agents-body')
            .evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await page.screenshot({
          style: '[data-ui-preview-banner] {visibility:hidden}',
          path: info.outputPath(`large-text-${width}-${theme}.png`),
        });
        await largeAdd.getByRole('button', { name: 'Close Agents' }).click();
        await page.evaluate(() => (document.documentElement.style.fontSize = ''));
      }
    }
    expect(errors).toEqual([]);
  });
