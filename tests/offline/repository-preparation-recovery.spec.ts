import { settingsHome, settingRow, openChatSetting, chooseSetting } from '../support/chat-settings';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
} from '../../packages/protocol/src/index';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
const output = build({
  entryPoints: [resolve('tests/fixtures/repository-preparation-recovery.tsx')],
  bundle: true,
  external: ['/*.svg', '/*.png'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-repository-recovery.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/harness': resolve('packages/harness/src/index.ts'),
  },
});
for (const theme of ['dark', 'light']) {
  test(`runtime change and lost preparation recover the original source (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const preview = {
      id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
      repository: 'example/repo',
      baseBranch: 'main',
      baseOid: 'a'.repeat(40),
      featureBranch: 'mitzo/task',
      state: 'preview',
    };
    const inventory = multiRuntimeInventoryFixture();
    inventory.agentProfiles.push({
      kind: 'builtin',
      profileId: DEFAULT_MITZO_PROFILE_ID,
      revision: DEFAULT_MITZO_PROFILE_REVISION,
      definition: defaultMitzoProfileDefinition,
      contentHash: sha256Hex(JSON.stringify(defaultMitzoProfileDefinition)),
    } as never);
    const previews: Array<{ ordinaryRuntime: unknown }> = [];
    let prepares = 0;
    let reads = 0;
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme as 'dark' | 'light' });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      const path = url.pathname;
      if (path.includes('/catalog'))
        return route.fulfill({
          json: {
            available: true,
            repositories: [{ connectionId: 'github', label: 'GitHub', repository: 'example/repo' }],
          },
        });
      if (path.endsWith('/preview')) {
        previews.push(route.request().postDataJSON());
        return route.fulfill({ json: preview });
      }
      if (path.endsWith('/prepare')) {
        prepares++;
        return route.abort('failed');
      }
      if (path === `/api/repository-workspaces/${preview.id}`) {
        reads++;
        return route.fulfill({
          json: {
            ...preview,
            state: 'ready',
            ordinaryRuntime: {
              version: 2,
              account: { accountId: 'api', provider: 'openai', profileRevision: 'api-r1' },
              harness: { implementation: 'responses' },
              execution: {
                location: 'local',
                targetId: 'responses',
                targetRevision: 'responses-r1',
              },
            },
          },
        });
      }
      if (path.startsWith('/api/')) {
        if (route.request().method() !== 'GET') {
          unexpected.push(path);
          return route.abort();
        }
        const fixtures: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], contextBlocks: {} },
          '/api/chat/runtime/capabilities': inventory,
          '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
          '/api/service-health': { services: [], checkedAt: 0 },
          '/api/version': {
            version: 'offline',
            branch: 'fixture',
            hash: 'a'.repeat(40),
            updateAvailable: false,
          },
          '/api/home/preferences': {
            revision: 1,
            names: { briefing: 'Jeeves', terminal: 'Minion' },
            pins: [],
          },
          '/api/tasks/loop': { state: 'idle' },
        };
        return route.fulfill({ json: fixtures[path] ?? [] });
      }
      if (/\.(png|svg)$/.test(path)) {
        try {
          return route.fulfill({
            body: await readFile(resolve('frontend/public', path.slice(1))),
            contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          });
        } catch {
          return route.fulfill({ status: 404, body: '' });
        }
      }
      const asset = files.find((file) =>
        path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (asset)
        return route.fulfill({
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: asset.text,
        });
      if (path !== '/chat') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        'mitzo-default-account-model',
        JSON.stringify({ accountId: 'api', model: 'shell-model', reasoningEffort: 'high' }),
      ),
    );
    await page.goto('/chat');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Keep this development request');
    await settingsHome(page);
    await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'api');
    await expect(settingRow(page, 'Account')).not.toContainText('Confirm');
    await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'shell-model');
    await expect(settingRow(page, 'Model')).not.toContainText('Unavailable');
    await expect(page.getByText(/account identity is unconfirmed/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`local-settings-default-${theme}.png`) });
    await openChatSetting(page, 'repository');
    await page.getByLabel('GitHub repository').selectOption('github:example/repo');
    await page.getByRole('button', { name: 'Preview repository', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Prepare repository', exact: true }),
    ).toBeVisible();
    await openChatSetting(page, 'execution');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Model', 'local-model');
    await chooseSetting(page, 'Thinking', 'low');
    await openChatSetting(page, 'repository');
    await expect(page.getByRole('button', { name: 'Prepare repository', exact: true })).toHaveCount(
      0,
    );
    await page.getByLabel('GitHub repository').selectOption('github:example/repo');
    await page.getByRole('button', { name: 'Preview repository', exact: true }).click();
    await page.getByRole('button', { name: 'Prepare repository', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Prepare repository', exact: true }),
    ).toBeDisabled();
    const refresh = page.getByRole('button', { name: 'Refresh preparation status' });
    await expect(refresh).toBeVisible();
    expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: info.outputPath(`local-repository-lost-${theme}.png`),
      fullPage: true,
    });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Ready for your first prompt/)).toBeVisible();
    await expect(input).toHaveValue('Keep this development request');
    await expect(refresh).toBeFocused();
    expect(previews).toHaveLength(2);
    expect(previews[1].ordinaryRuntime).toMatchObject({
      runOn: 'local',
      runtime: { targetId: 'responses', harness: 'responses' },
    });
    await settingsHome(page);
    await expect(page.getByText(/account identity is unconfirmed/)).toHaveCount(0);
    expect(prepares).toBe(1);
    expect(reads).toBe(1);
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath(`local-repository-ready-${theme}.png`),
      fullPage: true,
    });
  });
}
