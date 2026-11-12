import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';

const output = build({
  entryPoints: [resolve('tests/fixtures/chat-model-settings.tsx')],
  external: [
    '/openai-mark.svg',
    '/claude-mark.svg',
    '/mitzo-wordmark.png',
    '/openshell-mark.svg',
    '/github-mark.svg',
  ],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-model-settings.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['dark', 'light']) {
  test(`model settings explain failure, recover and edit next message (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 850,
    });
    const files = (await output).outputFiles!;
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) {
        const inventory = localInventoryFixture();
        inventory.accounts[0].models.push({
          id: 'sol-fixture',
          label: 'Sol fixture',
          reasoningEfforts: ['high'],
        });
        return route.fulfill({
          json: path.endsWith('/meta')
            ? {
                sessionId: 'bound-session',
                repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
                runtimeBinding: {
                  version: 2,
                  account: inventory.accounts[0].account,
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
                },
                runtimeCommandScope: 'conversation',
                mode: 'agent',
                agentProfile: inventory.agentProfiles[0],
                modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
              }
            : inventory,
        });
      }
      if (path === '/')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (
        [
          '/openai-mark.svg',
          '/claude-mark.svg',
          '/openshell-mark.svg',
          '/github-mark.svg',
          '/mitzo-wordmark.png',
        ].includes(path)
      )
        return readFile(resolve('frontend/public', path.slice(1))).then((body) =>
          route.fulfill({
            body,
            contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          }),
        );
      const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
      return file
        ? route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          })
        : route.abort();
    });
    await page.goto('/');
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: /^Thinking,/ }).click();
    await expect(page.locator('.quick-settings-note:visible')).toContainText('could not be loaded');
    await expect(page.getByRole('button', { name: 'high', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`model-settings-error-${theme}.png`) });
    await page.getByRole('button', { name: 'Retry settings' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.quick-settings-note:visible')).toContainText('next message');
    await page.getByRole('button', { name: 'high', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat settings' }).click();
    await page.getByRole('button', { name: /^Model,/ }).click();
    await page.getByRole('button', { name: 'Luna next', exact: true }).click();
    await expect(page.locator('.quick-settings-note:visible')).toContainText('already queued');
    await page.screenshot({ path: info.outputPath(`model-settings-ready-${theme}.png`) });
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((e) => e.clientWidth),
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep my draft');
    await expect(page.getByLabel('Next message settings')).toContainText('luna-next / high');
    await page.goto('/?legacy');
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: /^Model,/ }).click();
    await expect(page.locator('.quick-settings-note:visible')).toHaveText(
      'The running response keeps its settings. Queued messages use your current choices when sent.',
    );
    await page.getByRole('button', { name: 'Luna next', exact: true }).click();
    await expect(page.getByLabel('Next message settings')).toContainText('luna-next / low');
    await page.screenshot({ path: info.outputPath(`model-settings-legacy-queue-${theme}.png`) });
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((e) => e.clientWidth),
    );
    await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep my draft');
    // Reuse this intercepted settings journey for cross-provider choices and refreshed capabilities.
    await page.goto('/?accounts');
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: /^Account,/ }).click();
    await expect(page.getByRole('link', { name: 'Connect Claude subscription' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`quick-sheet-claude-account-${theme}.png`) });
    await page.getByRole('button', { name: 'Personal Claude', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat settings' }).click();
    await expect(page.getByRole('button', { name: /^Model,/ })).toContainText('Claude Sonnet 4.6');
    await page.getByRole('button', { name: /^Model,/ }).click();
    await expect(page.getByRole('button', { name: 'Luna', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('status').filter({ hasText: 'Check sign-in in Connections' }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath(`claude-sign-in-failure-${theme}.png`) });
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await expect(page.getByText(/Check sign-in in Connections/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Claude Opus 4.8', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat settings' }).click();
    await page.getByRole('button', { name: /^Thinking,/ }).click();
    await page.getByRole('button', { name: 'max', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chat settings' }).click();
    await page.getByRole('button', { name: /^Account,/ }).click();
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await expect(page.getByLabel('Next message settings')).toContainText('luna / low');
    await page.getByRole('button', { name: 'Personal Claude', exact: true }).click();
    await expect(page.getByLabel('Next message settings')).toContainText('opus / max');
    await page.getByRole('button', { name: 'Back to chat settings' }).click();
    await page.screenshot({ path: info.outputPath(`account-model-settings-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'Message draft' })).toHaveValue('Keep my draft');
    await page.goto('/?retained');
    await expect(page.getByRole('button', { name: 'Prepare next message' })).toBeEnabled();
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: /^Model,/ }).click();
    await page.getByRole('button', { name: 'Sol fixture', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Thinking,/ }).click();
    await page.getByRole('button', { name: 'high', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Recreate chat screen' })).toBeInViewport();
    await page.getByRole('button', { name: 'Recreate chat screen' }).click();
    await expect(page.getByRole('button', { name: 'Prepare next message' })).toBeEnabled();
    await expect(page.getByRole('button', { name: /^Workspace controls/ })).toHaveAccessibleName(
      /Sol fixture/,
    );
    await expect(page.locator('.workspace-controls-context')).toContainText('Sol fixture');
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: /^Model,/ }).click();
    await expect(page.getByRole('button', { name: 'Sol fixture', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ path: info.outputPath(`retained-chat-model-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Prepare next message' }).click();
    await expect(page.getByLabel('Frozen command settings')).toContainText('"model":"sol-fixture"');
    await expect(page.getByLabel('Frozen command settings')).toContainText('"thinking":"high"');
    expect(errors).toEqual([]);
  });
}
