import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';

const bundled = build({
  entryPoints: [resolve('tests/fixtures/session-launch-defaults.tsx')],
  external: ['/*.png', '/*.svg'],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-session-launch-defaults.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

for (const theme of ['dark', 'light'])
  test(`complete defaults retain Local Mac across new chats and reload (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    let configuration: SessionLaunchConfig | null = null;
    let revision = 0;
    const files = (await bundled).outputFiles!;
    const errors: string[] = [];
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
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}.fixture-main{max-width:42rem;margin:auto;padding:var(--space-4)}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      if (/^\/(openai|claude|openshell|github)-mark.svg$/.test(path))
        return route.fulfill({
          body: await readFile(resolve('frontend/public' + path)),
          contentType: 'image/svg+xml',
        });
      if (path === '/api/session-launch/defaults') {
        if (route.request().method() === 'PUT') {
          const body = route.request().postDataJSON();
          if (body.expectedRevision !== revision)
            return route.fulfill({ status: 409, json: { error: 'Defaults changed. Refresh.' } });
          configuration = body.configuration;
          revision++;
        }
        return route.fulfill({ json: { revision, configuration } });
      }
      if (path === '/api/chat/runtime/capabilities')
        return route.fulfill({ json: localInventoryFixture() });
      return route.fulfill({ json: [] });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await page.getByLabel('Permission mode').selectOption('ask');
    await page.getByLabel('Isolated checkout').uncheck();
    await page
      .getByRole('textbox', { name: 'Context', exact: true })
      .fill('Persistent project context\nwith handoff notes');
    await page.getByLabel('Additional tools').fill('Read, Glob');
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await page.getByRole('button', { name: 'New-chat defaults, Not set' }).click();
    await page.getByRole('button', { name: 'Make default for new chats' }).click();
    await expect
      .poll(() => configuration?.runtime.execution)
      .toEqual({ location: 'local', targetId: 'mac' });
    expect(configuration).toMatchObject({
      mode: 'ask',
      isolation: false,
      contextBlocks: ['Persistent project context\nwith handoff notes'],
      extraTools: ['Read', 'Glob'],
      runtime: {
        agentProfile: { profileId: 'agent', revision: 1 },
        account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
      },
    });
    for (const action of ['new', 'reload']) {
      if (action === 'new')
        await page.getByRole('button', { name: 'New chat', exact: true }).click();
      else await page.reload();
      await expect(page.getByLabel('Permission mode')).toHaveValue('ask');
      await expect(page.getByLabel('Isolated checkout')).not.toBeChecked();
      await expect(page.getByRole('textbox', { name: 'Context', exact: true })).toHaveValue(
        'Persistent project context\nwith handoff notes',
      );
      const restored = JSON.parse((await page.getByTestId('configuration').textContent())!);
      expect(restored).toEqual(configuration);
      expect(
        JSON.parse((await page.getByTestId('draft').textContent())!).settings.runtimeSelection
          .execution,
      ).toEqual({ location: 'local', targetId: 'mac' });
      await expect(page.getByLabel('Message Mitzo')).toBeVisible();
      await page.getByLabel('Message Mitzo').fill('Run the requested task');
      await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
      await expect(
        page.getByText(
          'Additional tools are unsupported on the selected runtime. Review session defaults or clear these tools before sending.',
          { exact: true },
        ),
      ).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`session-defaults-${theme}.png`) });
    expect(errors).toEqual([]);
  });
