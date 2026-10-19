import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Component adoption fixture: actual ordinary renderer/composer, entirely intercepted.
// Full ResponsiveChatView adoption and current S5b integration remain separate gates.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-chat-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-s8-chat-selection.js',
  jsx: 'automatic',
  minify: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
const fixtureDocument = (theme: string) =>
  `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}main{padding:var(--page-gutter)}.fixture-header{display:flex;gap:var(--space-2);align-items:center;padding:var(--space-3)}.fixture-header button{min-height:var(--control-height);min-width:var(--control-height);font:inherit;background:transparent;color:var(--color-accent);border:0}.fixture-header h1{font-size:var(--text-lg);margin:0;overflow-wrap:anywhere}.fixture-header output{font-size:var(--text-xs)}.fixture-conversation{padding:var(--page-gutter);min-width:0}.fixture-conversation .chat-area{position:static} ${theme === 'light' ? 'html{font-size:125%}' : ''}</style><div id="root"></div><script src="/fixture.js"></script></html>`;

for (const theme of ['dark', 'light']) {
  test(`S8 tree exit stays outside transcript flow with normal motion (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [],
      writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) {
        if (route.request().method() !== 'GET') writes.push(path);
        return route.fulfill({ json: [] });
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({ contentType: 'text/html', body: fixtureDocument(theme) });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 520 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Retain this draft through the animated exit.');
    await input.evaluate((element) => {
      element.dataset.s8Draft = 'original';
    });
    const before = await page.locator('.telos-chat-body').evaluate((body) => ({
      height: body.getBoundingClientRect().height,
      transcriptWidth: body.querySelector('.telos-chat-transcript')!.getBoundingClientRect().width,
      documentHeight: document.documentElement.scrollHeight,
    }));
    const trigger = page.getByRole('button', { name: 'Toggle work tree' });
    await trigger.click();
    const presence = page.locator('.telos-chat-tree-presence');
    await expect(presence).toBeVisible();
    await expect(presence).not.toHaveAttribute('data-motion-active', 'true');
    await page.getByRole('button', { name: 'Close work tree' }).focus();
    // Pause the real shared WAAPI exit to inspect several in-flight frames.
    // No replacement motion implementation, timing token or reduced-motion bypass.
    const exit = await page.evaluate(async () => {
      (document.querySelector('.telos-chat-tree-close') as HTMLButtonElement).click();
      await new Promise(requestAnimationFrame);
      const root = document.querySelector('.telos-chat-tree-presence') as HTMLElement;
      if (!root) throw Error('Normal-motion exit must retain the panel');
      const animations = root.getAnimations();
      if (!animations.length) throw Error('Expected the real shared exit animation');
      animations.forEach((animation) => animation.pause());
      const frames = [];
      for (const fraction of [0, 0.5, 0.9]) {
        for (const animation of animations) {
          animation.currentTime = Number(animation.effect!.getTiming().duration) * fraction;
        }
        await new Promise(requestAnimationFrame);
        const body = document.querySelector('.telos-chat-body')!;
        const transcript = document.querySelector('.telos-chat-transcript')!;
        frames.push({
          bodyTop: body.getBoundingClientRect().top,
          panelTop: root.getBoundingClientRect().top,
          bodyHeight: body.getBoundingClientRect().height,
          transcriptWidth: transcript.getBoundingClientRect().width,
          documentHeight: document.documentElement.scrollHeight,
        });
      }
      return {
        inert: root.inert,
        hidden: root.getAttribute('aria-hidden'),
        active: root.dataset.motionActive,
        frames,
      };
    });
    expect(exit.inert).toBe(true);
    expect(exit.hidden).toBe('true');
    expect(exit.active).toBe('true');
    for (const frame of exit.frames) {
      expect(frame.panelTop).toBeCloseTo(frame.bodyTop, 0);
      expect(frame.bodyHeight).toBeCloseTo(before.height, 0);
      expect(frame.transcriptWidth).toBeCloseTo(before.transcriptWidth, 0);
      expect(frame.documentHeight).toBeLessThanOrEqual(before.documentHeight + 1);
    }
    await expect(trigger).toBeFocused();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Retain this draft through the animated exit.');
    await expect(input).toHaveAttribute('data-s8-draft', 'original');
    await page.screenshot({
      path: info.outputPath(`tree-exiting-normal-${theme}.png`),
      fullPage: true,
    });
    await presence.evaluate((root) =>
      root.getAnimations().forEach((animation) => animation.finish()),
    );
    await expect(presence).toHaveCount(0);
    await expect(input).toHaveValue('Retain this draft through the animated exit.');
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
  test(`S8 chooser and collapsed tree retain ordinary chat state (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) {
        if (route.request().method() !== 'GET') writes.push(path);
        return route.fulfill({ json: [] });
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: fixtureDocument(theme),
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveCount(0);
    await expect(page.locator('[aria-current], [aria-selected="true"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`chooser-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await input.fill('Keep this unsent worker draft.');
    await expect(page.getByText('Worker transcript')).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Toggle work tree' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const transcript = page.locator('.telos-chat-transcript');
    const fullWidth = (await transcript.boundingBox())!.width;
    await trigger.click();
    await expect(page.getByRole('region', { name: 'Work tree' })).toBeVisible();
    await expect(page.getByText('Awaiting review')).toBeVisible();
    await expect(page.getByText('P7', { exact: true })).toBeVisible();
    if (isMobile) await expect(input).toBeHidden();
    else expect((await transcript.boundingBox())!.width).toBeLessThan(fullWidth);
    await page.screenshot({ path: info.outputPath(`tree-open-${theme}.png`), fullPage: true });
    const close = page.getByRole('button', { name: 'Close work tree' });
    await close.focus();
    await close.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    expect((await transcript.boundingBox())!.width).toBeCloseTo(fullWidth, 0);
    await page.screenshot({ path: info.outputPath(`chat-closed-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Reviewer', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('Independent reviewer draft.');
    await expect(page.getByText('Reviewer transcript')).toBeVisible();
    await expect(page.getByLabel('Fixture account')).toHaveText('Review account');
    await page.getByRole('button', { name: 'Chats for this item: 3' }).click();
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    await expect(page.getByLabel('Fixture account')).toHaveText('Work account');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Chats · 3' })).toBeVisible();
    await page.getByRole('button', { name: 'Open Assigned worker', exact: true }).click();
    await expect(input).toHaveValue('Keep this unsent worker draft.');
    for (const button of await page.locator('.telos-chat-context-row button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
