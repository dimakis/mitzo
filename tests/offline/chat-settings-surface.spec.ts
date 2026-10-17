import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

// Bundle the changed controls with the real desktop shell. No backend, provider or model.
const output = build({
  entryPoints: [resolve('tests/fixtures/chat-settings-surface.tsx')],
  bundle: true,
  external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  write: false,
  outfile: '/tmp/mitzo-chat-settings.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
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
      if (path === '/api/accounts')
        return route.fulfill({
          json: ['Personal ChatGPT', 'Work'].map((id) => ({
            id,
            label: id,
            models: [{ id: 'luna', label: 'Luna', reasoningEfforts: ['High', 'Medium', 'Low'] }],
          })),
        });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (
        path === '/mitzo-wordmark.png' ||
        path === '/mitzo-icon.png' ||
        path === '/openshell-mark.svg'
      )
        return readFile(resolve('frontend/public', path.slice(1))).then((body) =>
          route.fulfill({
            body,
            contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          }),
        );
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${appearance}" data-accent="${appearance === 'dark' ? 'mint' : 'teal'}" data-font="${appearance === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body{margin:0;height:100%;overflow:hidden}.workspace-tabs{position:fixed;bottom:0;inset-inline:0;min-height:64px;display:flex;align-items:center;justify-content:center}.workspace-controls-heading>button{min-height:44px;padding:8px}.chat-messages{justify-content:center}.agent-settings-panel--embedded label{display:flex;flex-direction:column}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    const mobile = testInfo.project.name.startsWith('mobile');
    await page.addInitScript(() => {
      localStorage.setItem(
        'mitzo-default-account-model',
        JSON.stringify({
          accountId: 'Personal ChatGPT',
          model: 'luna',
          reasoningEffort: 'High',
        }),
      );
    });
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 844 : 900 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: /^Workspace controls/ });
    const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(trigger).toHaveAccessibleName(/Settings/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.chat-input .agent-settings-picker')).toHaveCount(0);
    if (mobile) await expect(input).not.toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`single-chat-settings-${appearance}-closed.png`),
    });
    const newWidth = (await page.locator('.chat-input-row').boundingBox())!.width;
    await input.fill('Keep my draft');
    await expect(input).toHaveCSS('outline-style', 'none');
    await expect(input).toHaveCSS('border-top-width', '0px');
    await expect(page.getByRole('button', { name: 'Open session tray' })).toHaveText('');
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('combobox')).toHaveCount(4);
    await expect(panel.getByRole('heading', { name: 'Account & model' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Agent & workspace' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Make default for new chats' })).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath(`restored-chat-settings-${appearance}.png`),
    });
    await panel.getByText('Account options', { exact: true }).click();
    await panel.getByRole('button', { name: 'Make default for new chats' }).click();
    await expect(panel.getByRole('button', { name: 'Clear new-chat default' })).toBeVisible();
    await panel.getByRole('button', { name: 'Refresh models' }).click();
    await expect(panel.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
    const options = panel.locator('details', {
      has: page.getByText('Account options', { exact: true }),
    });
    if ((await options.getAttribute('open')) !== null)
      await panel.getByText('Account options', { exact: true }).click();
    for (const control of await panel.getByRole('combobox').all())
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole('button', { name: 'Collaborate' })).toBeHidden();
    const model = panel.getByRole('combobox', { name: 'Thinking level' });
    await page.getByText('More settings', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Collaborate' })).toBeVisible();
    await panel.getByRole('combobox', { name: 'Account', exact: true }).selectOption('Work');
    await model.selectOption('Low');
    await panel.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Local Mac', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (!mobile) expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(384);
    expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    await panel.locator('.workspace-controls-content').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath(`single-chat-settings-${appearance}-open.png`),
    });
    await panel.getByRole('button', { name: 'Review findings', exact: true }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Review findings', exact: true });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await expect(panel).toBeHidden();
    await trigger.click();
    await expect(model).toHaveValue('Low');
    await expect(panel.getByRole('combobox', { name: 'Account', exact: true })).toBeInViewport();
    expect(await panel.locator('.workspace-controls-content').evaluate((el) => el.scrollTop)).toBe(
      0,
    );
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
      await expect(page.getByRole('navigation')).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', {
          value: innerHeight - 280,
          configurable: true,
        });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(page.getByRole('navigation')).toBeHidden();
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect(page.getByTestId('sent-count')).toHaveText('1');
      expect((await page.locator('.chat-input-row').boundingBox())!.width).toBe(newWidth);
      await input.fill('Keep my draft');
      await expect(page.getByRole('navigation')).toBeHidden();
      await page.evaluate(() => {
        Reflect.deleteProperty(window.visualViewport!, 'height');
        window.visualViewport!.dispatchEvent(new Event('resize'));
      });
      await expect(page.getByRole('navigation')).toBeVisible();
    }
    await page.setViewportSize({ width: mobile ? 320 : 1280, height: mobile ? 500 : 300 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    await input.evaluate((element) => {
      element.style.height = '210px';
    });
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect(input).toBeInViewport();
    const local = panel.getByRole('button', { name: 'Local Mac', exact: true });
    await local.scrollIntoViewIfNeeded();
    const localBox = (await local.boundingBox())!;
    const headerBox = (await panel.locator('.agent-settings-header').boundingBox())!;
    const footerBox = (await panel.locator('.workspace-controls-footer').boundingBox())!;
    expect(localBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
    expect(localBox.y + localBox.height).toBeLessThanOrEqual(footerBox.y + 1);
    await local.click();
    await expect(panel.getByRole('button', { name: 'Close agent settings' })).toBeInViewport();
    await expect(panel.getByText('Chat settings', { exact: true })).toBeInViewport();
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    if (!mobile) {
      const center = (await page.locator('.desktop-center').boundingBox())!;
      expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(center.y + center.height);
      await expect(page.locator('.desktop-status-row')).toBeInViewport();
    }
    await page.screenshot({ path: testInfo.outputPath(`short-chat-settings-${appearance}.png`) });
    await panel.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(input).toHaveValue('Keep my draft');
    await expect(input).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}

test('profile drafts: real dialog keeps edits and explains the empty state', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const files = (await output).outputFiles!;
  let populated = true,
    catalogReads = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') return route.abort();
    if (path === '/api/sessions/fixture/symposium/status')
      return route.fulfill({ json: { sessionId: 'fixture', config: null, seats: [] } });
    if (path === '/api/symposium/profiles') {
      catalogReads++;
      return route.fulfill({ json: [] });
    }
    if (path === '/api/symposium/profile-proposals')
      return route.fulfill({
        json: populated
          ? [
              {
                proposalId: 'draft',
                suggestedProfileId: null,
                state: 'pending',
                definition: {
                  name: 'Reviewer',
                  role: 'reviewer',
                  instructions: 'Review the changes',
                  expectedOutput: 'Findings',
                  acceptanceCriteria: ['Cite evidence'],
                  modelPolicyRole: 'reviewer',
                },
              },
            ]
          : [],
      });
    if (path.startsWith('/api/')) return route.fulfill({ json: [] });
    const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
    if (file)
      return route.fulfill({
        body: file.text,
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    if (path !== '/') return route.abort();
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html data-theme="dark" data-accent="mint" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body{margin:0;height:100%;overflow:hidden}.workspace-tabs{position:fixed;bottom:0;inset-inline:0;min-height:64px;display:flex;align-items:center;justify-content:center}</style><div id="root"></div><script src="/fixture.js"></script></html>',
    });
  });
  await page.setViewportSize({
    width: testInfo.project.name.startsWith('mobile') ? 320 : 1280,
    height: 900,
  });
  await page.goto('https://mitzo-ui.test/?recovery=profiles');
  const trigger = page.getByRole('button', { name: /^Workspace controls/ });
  async function openDrafts() {
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    const more = page.locator('.workspace-controls-options');
    if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
    await page.getByRole('button', { name: 'Reusable profile drafts', exact: true }).click();
  }
  await openDrafts();
  const dialog = page.getByRole('dialog', { name: 'Reusable profile drafts' });
  const input = dialog.getByRole('textbox', { name: 'Instructions', exact: true });
  await input.fill('Keep these edits between openings');
  await dialog.getByRole('button', { name: 'Close profile drafts' }).click();
  await expect(dialog).toBeHidden();
  await openDrafts();
  await expect(input).toHaveValue('Keep these edits between openings');
  expect(catalogReads).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('compact-profile-drafts.png') });
  await dialog.getByRole('button', { name: 'Close profile drafts' }).click();
  populated = false;
  await page.reload();
  await openDrafts();
  await expect(dialog.getByText('No profile drafts in this chat yet.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
