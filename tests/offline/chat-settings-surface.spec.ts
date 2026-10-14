import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Bundle only the real changed controls. No backend, provider, full app build or model.
const output = build({
  entryPoints: [resolve('tests/fixtures/chat-settings-surface.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-chat-settings.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
for (const appearance of ['dark', 'light'] as const) {
  test(`single top chat settings: outside dismissal and compact composer (${appearance})`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await output).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${appearance}" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body{margin:0;height:100%;overflow:hidden}.workspace-tabs{position:fixed;bottom:0;inset-inline:0;min-height:64px;display:flex;align-items:center;justify-content:center}.workspace-controls-heading>button{min-height:44px;padding:8px}.chat-messages{justify-content:center}.agent-settings-panel--embedded label{display:flex;flex-direction:column}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    const mobile = testInfo.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: /^Workspace controls/ });
    const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.chat-input .agent-settings-picker')).toHaveCount(0);
    await expect(input).not.toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`single-chat-settings-${appearance}-closed.png`),
    });
    await input.fill('Keep my draft');
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('combobox')).toHaveCount(4);
    for (const control of await panel.getByRole('combobox').all())
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Collaborate' })).toBeHidden();
    const model = panel.getByRole('combobox', { name: 'Thinking level' });
    await model.selectOption('Low');
    await page.getByText('More options', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collaborate' })).toBeVisible();
    await panel.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath(`single-chat-settings-${appearance}-open.png`),
    });
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await expect(panel).toBeHidden();
    await trigger.click();
    await expect(model).toHaveValue('Low');
    await model.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await input.click();
    await expect(panel).toBeHidden();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Keep my draft');
    if (mobile) {
      await expect(page.getByRole('navigation')).toBeHidden();
      await page.setViewportSize({ width: 320, height: 500 });
      await trigger.click();
      await expect(panel).toBeVisible();
      await expect(input).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}
