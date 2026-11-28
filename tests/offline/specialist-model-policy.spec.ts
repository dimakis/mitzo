import { expect, test } from '@playwright/test';
import { build, type OutputFile } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

let files: OutputFile[];
test.beforeAll(async () => {
  files = (
    await build({
      entryPoints: [resolve('tests/fixtures/specialist-model-policy.tsx')],
      plugins: [chatStorageBootstrap()],
      bundle: true,
      write: false,
      outfile: '/tmp/specialist-model-policy.js',
      jsx: 'automatic',
      minify: true,
      external: ['/*.png', '/*.svg'],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      alias: {
        '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
        '@mitzo/client': resolve('packages/client/src/index.ts'),
        '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
      },
    })
  ).outputFiles!;
});

test('edits and restores model policy through the Agents dialog', async ({
  page,
  isMobile,
}, info) => {
  const errors: string[] = [];
  const saves: Record<string, unknown>[] = [];
  let policy: unknown = null;
  let revision = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/check')
      return route.fulfill({ json: { ok: true, authSessionId: 'offline-policy-login' } });
    if (path === '/api/specialist-model-policy/policy-fixture') {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON();
        saves.push(input);
        policy = input.policy;
        revision++;
        return route.fulfill({ json: { revision, policy } });
      }
      return route.fulfill({
        json: {
          workspace: {
            revision: 1,
            policy: {
              models: [
                { accountId: 'personal', model: 'chosen-model', admission: 'ask', allowance: 4 },
              ],
            },
          },
          conversation: { revision, policy },
          allowances: [],
          accounts: [
            {
              id: 'personal',
              label: 'Personal subscription',
              models: [{ id: 'chosen-model', label: 'Chosen model' }],
            },
          ],
        },
      });
    }
    const file = files.find((file) => path.endsWith(file.path.split('/').at(-1)!));
    if (file)
      return route.fulfill({
        contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: file.text,
      });
    if (path === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/specialist-model-policy.css"></head><body><div id="root"></div><script src="/specialist-model-policy.js"></script></body></html>',
      });
    return route.fulfill({ status: 404, body: 'Unexpected offline request' });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /^Agents, / }).click();
  await page.getByText('Model policy', { exact: true }).click();
  await page.getByLabel('Admission for chosen-model').selectOption('auto');
  await page.getByLabel('Allowance for chosen-model').fill('');
  await page.getByRole('button', { name: 'Save model policy', exact: true }).click();
  await expect(
    page.getByText('Model policy saved. Changes apply to future admissions.'),
  ).toBeVisible();
  expect(saves[0]).toMatchObject({
    scope: 'conversation',
    expectedRevision: 0,
    policy: {
      models: [
        { accountId: 'personal', model: 'chosen-model', admission: 'auto', allowance: null },
      ],
    },
  });
  const body = page.locator('.conversation-agents-body');
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByLabel('Admission for chosen-model').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('model-policy.png') });
  await page.reload();
  await page.getByRole('button', { name: /^Agents, / }).click();
  await page.getByText('Model policy', { exact: true }).click();
  await expect(page.getByLabel('Admission for chosen-model')).toHaveValue('auto');
  await page.getByRole('button', { name: 'Use workspace defaults', exact: true }).click();
  await expect(page.getByLabel('Admission for chosen-model')).toHaveValue('ask');
  expect(saves[1]).toMatchObject({ expectedRevision: 1, policy: null });
  expect(errors).toEqual([]);
});
