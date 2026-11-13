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
  outfile: '/tmp/mitzo-session-launch.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});
function hostInventory() {
  const inventory = localInventoryFixture();
  inventory.targets.push({ ...inventory.targets[0], targetId: 'build-mac', label: 'Build Mac' });
  inventory.routes.push({ ...inventory.routes[0], targetId: 'build-mac' });
  return inventory;
}
for (const mode of ['start', 'create', 'adopt', 'release']) {
  const workBound = mode !== 'start',
    adoption = mode === 'adopt';
  for (const theme of ['dark', 'light']) {
    test(`agent ${mode} review, receipt and retained draft (${theme})`, async ({
      page,
      isMobile,
    }, info) => {
      const files = (await bundled).outputFiles!;
      const errors: string[] = [],
        mutations: { path: string; body: Record<string, unknown> }[] = [];
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
            body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}.fixture-main{max-width:42rem;margin:auto;padding:var(--space-4)}.fixture-main>label{display:grid;gap:var(--space-2);margin-block:var(--space-4)}.fixture-main textarea{box-sizing:border-box;width:100%;min-height:var(--control-height);font:inherit}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
          });
        if (/^\/(openai|claude|openshell|github)-mark.svg$/.test(path))
          return route.fulfill({
            body: await readFile(resolve('frontend/public' + path)),
            contentType: 'image/svg+xml',
          });
        if (path === '/api/chat/runtime/capabilities')
          return route.fulfill({ json: hostInventory() });
        if (path === '/api/accounts') return route.fulfill({ json: { accounts: [] } });
        if (path === '/api/repository-workspaces/catalog')
          return route.fulfill({ json: { repositories: [] } });
        if (path.endsWith('/release')) {
          mutations.push({ path, body: route.request().postDataJSON() });
          return route.fulfill({
            status: 409,
            json: { error: 'Release is unconfirmed. Recover the original allocation.' },
          });
        }
        if (path === '/api/session-launch/requests/b391d65c-33c8-4ea4-a38e-84385256bb8d/approve') {
          mutations.push({ path, body: route.request().postDataJSON() });
          return route.fulfill({
            json: { state: workBound ? 'assigned' : 'running', childSessionId: 'child' },
          });
        }
        if (path === '/fixture-receipt')
          return route.fulfill({
            json: {
              state: workBound ? 'assigned' : 'running',
              childSessionId: 'child',
              revision: 2,
            },
          });
        return route.fulfill({ json: [] });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(workBound ? `/?telos=1&${mode}=1` : '/');
      if (theme === 'light') await page.addStyleTag({ content: 'html {font-size:125%}' });
      if (mode === 'release') {
        await page.getByRole('button', { name: 'Review release' }).click();
        const release = page.getByRole('dialog', { name: 'Release unfinished reservation' });
        await expect(release).toBeVisible();
        expect(mutations).toHaveLength(0);
        await release.getByRole('button', { name: 'Approve release' }).click();
        await expect(release.getByRole('alert')).toContainText('Release is unconfirmed');
        await expect(page.getByLabel('Original chat draft')).toHaveValue(
          'Keep my original chat draft',
        );
        expect(mutations).toHaveLength(1);
        expect(mutations[0].body).toEqual({ expectedRevision: 1 });
        await page.screenshot({
          path: info.outputPath(`session-launch-release-${theme}-refusal.png`),
        });
        expect(errors).toEqual([]);
        return;
      }
      const reviewLabel = adoption ? 'Review existing chat' : 'Review new session';
      const trigger = page.getByRole('button', { name: reviewLabel });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: reviewLabel });
      await expect(dialog).toBeVisible();
      const approvalLabel = adoption
        ? 'Approve & adopt'
        : workBound
          ? 'Approve & create'
          : 'Approve & start';
      if (adoption)
        await expect(
          dialog.getByRole('link', { name: 'Retained design discussion' }),
        ).toHaveAttribute('href', '/chat/child');
      if (workBound) {
        await expect(dialog.getByRole('link', { name: 'Capability baseline' })).toBeVisible();
        await expect(dialog.getByText('Feature lead', { exact: true })).toBeVisible();
        await dialog.getByText('Review work context', { exact: true }).click();
        await expect(
          dialog.getByText('Make supported runtime capabilities visible to the user.'),
        ).toBeVisible();
        await expect(dialog.getByRole('button', { name: approvalLabel })).toBeInViewport();
        await dialog.getByText('Review work context', { exact: true }).click();
      }
      await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(
        /Approval notifications/,
      );
      expect(mutations).toHaveLength(0);
      await dialog.getByLabel('Title', { exact: true }).fill('Approval notifications');
      await expect(dialog.locator('.session-launch-settings')).not.toHaveAttribute('open', '');
      await expect(dialog.getByRole('button', { name: approvalLabel })).toBeInViewport();
      await dialog.getByText('Session settings', { exact: true }).click();
      await expect(dialog.getByRole('button', { name: approvalLabel })).toBeInViewport({
        ratio: 1,
      });
      await expect(dialog.getByRole('button', { name: 'Cancel request' })).toBeInViewport({
        ratio: 1,
      });
      await expect(dialog.getByLabel('Execution host')).toHaveValue('mac');
      if (adoption) {
        await expect(dialog.getByLabel('Execution host')).toBeDisabled();
        await expect(dialog.getByLabel('Save configuration as default')).toHaveCount(0);
      } else {
        await dialog.getByLabel('Execution host').selectOption('build-mac');
        await expect(dialog.getByLabel('Execution host')).toHaveValue('build-mac');
        await dialog.getByLabel('Save configuration as default').check();
      }
      await expect(dialog.getByRole('button', { name: approvalLabel })).toBeInViewport({
        ratio: 1,
      });
      await expect(dialog.getByRole('button', { name: 'Cancel request' })).toBeInViewport({
        ratio: 1,
      });
      await page.screenshot({ path: info.outputPath(`session-launch-${theme}-review.png`) });
      const bounds = await dialog.boundingBox();
      expect(bounds!.width).toBeLessThanOrEqual(isMobile ? 320 : 1280);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const close = dialog.getByRole('button', { name: 'Close', exact: true });
      const closeBounds = await close.boundingBox();
      expect(closeBounds!.width).toBeGreaterThanOrEqual(44);
      expect(closeBounds!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await trigger.click();
      await dialog.getByText('Session settings', { exact: true }).click();
      if (!adoption) {
        await dialog.getByLabel('Execution host').selectOption('build-mac');
        await expect(dialog.getByLabel('Execution host')).toHaveValue('build-mac');
        await dialog
          .getByRole('combobox', { name: 'Thinking level', exact: true })
          .selectOption('low');
        await dialog.getByLabel('Permission mode').selectOption('ask');
        await dialog.getByLabel('Save configuration as default').check();
      }
      await dialog.getByRole('button', { name: approvalLabel }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('link', { name: 'Open chat', exact: true })).toHaveAttribute(
        'href',
        '/chat/child',
      );
      await expect(page.getByRole('status')).toHaveText(
        adoption ? 'Adopted & assigned' : workBound ? 'Created & assigned' : 'Started',
      );
      await expect(page.getByLabel('Original chat draft')).toHaveValue(
        'Keep my original chat draft',
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0].body.saveAsDefault).toBe(!adoption);
      expect(mutations[0].body.configuration).toMatchObject({
        runtime: {
          account: {
            accountId: 'personal',
            model: 'luna-fixture',
            reasoningEffort: adoption ? 'high' : 'low',
          },
          accountReference: hostInventory().accounts[0].account,
          agentProfile: { profileId: 'agent', revision: 1 },
          execution: { location: 'local', targetId: adoption ? 'mac' : 'build-mac' },
        },
        mode: adoption ? 'agent' : 'ask',
        isolation: true,
        repositoryWorkspaceId: null,
        contextBlocks: [],
      });
      await page.screenshot({ path: info.outputPath(`session-launch-${theme}-receipt.png`) });
      expect(errors).toEqual([]);
    });
  }
}
