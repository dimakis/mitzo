import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';
import { settingsHome, settingRow, openChatSetting, chooseSetting } from '../support/chat-settings';
const output = build({
  entryPoints: [resolve('tests/fixtures/repository-preparation-recovery.tsx')],
  bundle: true,
  external: ['/*.svg', '/*.png'],
  format: 'esm',
  write: false,
  outfile: '/tmp/mitzo-chat-continuity.js',
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
for (const theme of ['dark', 'light'] as const) {
  test(`upgraded saved chat refreshes and sends with editable future model (${theme})`, async ({
    page,
  }, info) => {
    const files = (await output).outputFiles!;
    const inventory = multiRuntimeInventoryFixture({ nativeLocalApi: true });
    const next = { id: 'next-model', label: 'Next model', reasoningEfforts: ['low'] };
    inventory.accounts.find((entry) => entry.account.accountId === 'api')!.models.push(next);
    inventory.routes.find((entry) => entry.targetId === 'shell')!.models!.push(next);
    const account = inventory.accounts.find((entry) => entry.account.accountId === 'api')!.account;
    const meta = {
      sessionId: 'retained-chat',
      sessionType: 'chat',
      mode: 'agent',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      runtimeBinding: {
        version: 2,
        account,
        harness: { implementation: 'codex' },
        execution: {
          location: 'openshell',
          targetId: 'shell',
          targetRevision: 'original-deployment-fingerprint',
        },
      },
      runtimeCommandScope: 'conversation',
      agentProfile: inventory.agentProfiles[0],
      modelSelection: { model: 'shell-model', reasoningEffort: 'low' },
    };
    const requests: Record<string, unknown>[] = [],
      errors: string[] = [],
      unexpected: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 844,
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.hostname !== 'mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      if (path === '/api/chat/runtime/continue') {
        requests.push(route.request().postDataJSON());
        return route.fulfill({
          status: 409,
          json: { ok: false, code: 'rejected', error: 'Offline command captured' },
        });
      }
      if (path === '/api/telos/work/links') {
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: 'retained-chat',
        });
        return route.fulfill({ json: [] });
      }
      if (path === '/api/sessions/retained-chat/meta') return route.fulfill({ json: meta });
      if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
      if (path.startsWith('/api/')) {
        if (route.request().method() !== 'GET') {
          unexpected.push(path);
          return route.abort();
        }
        const fixtures: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], contextBlocks: {} },
          '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
          '/api/service-health': { services: [], checkedAt: 0 },
          '/api/tasks/loop': { state: 'idle' },
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
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/chat/retained-chat');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(composer).toBeVisible();
    await composer.fill('Continue the same work after upgrading');
    await settingsHome(page);
    await expect(settingRow(page, 'Account')).toHaveAttribute('data-value', 'api');
    await chooseSetting(page, 'Model', 'next-model');
    await openChatSetting(page, 'model');
    inventory.capabilityRevision = 'upgraded-capabilities';
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await settingsHome(page);
    await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'next-model');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(composer).toHaveValue('Continue the same work after upgrading');
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath(`upgraded-chat-${theme}.png`), fullPage: true });
    await send.click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      sessionId: 'retained-chat',
      capabilityRevision: 'upgraded-capabilities',
      runtime: { account, targetId: 'shell', harness: 'codex' },
      selection: { model: 'next-model', thinking: 'low' },
      payload: { text: 'Continue the same work after upgrading' },
    });
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
