import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { deployedSecurityHeaders } from '../support/response-security';
const builtins = JSON.parse(
  readFileSync(new URL('../fixtures/agent-tool-catalog.json', import.meta.url), 'utf8'),
);
const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-tool-selection.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/api-tool-template.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
test.use({ baseURL: 'https://mitzo-ui.test' });
for (const theme of ['dark', 'light'])
  test(`API templates: configure, verify, publish and retain draft (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const compiled = await bundle;
    let draft: Record<string, unknown> | undefined;
    let published = false;
    let attempts = 0;
    let saveAttempts = 0;
    const entry = {
      id: 'api:11111111-1111-4111-8111-111111111111',
      version: 1,
      revision: '22222222-2222-4222-8222-222222222222',
      name: 'Office temperature',
      description: 'Read the current state of one configured Home Assistant entity.',
      source: 'Reviewed API template',
      implementation: {
        template: 'home-assistant.state@1',
        source: 'server/api-tool-template.ts',
        fingerprint: 'a'.repeat(64),
      },
      required: false,
      behavior: 'read',
      routes: ['local-api'],
      requirement: 'Select RequestConnectionAccess too; connection approval required.',
    };
    const template = {
      id: 'home-assistant.state@1',
      label: 'Home Assistant entity state',
      description: entry.description,
      method: 'GET',
      path: '/api/states/{entityId}',
      source: 'server/api-tool-template.ts',
      implementation: 'home-assistant-state-v1',
      documentation: 'https://developers.home-assistant.io/docs/api/rest/#get-apistatesentity_id',
      output: ['entity_id', 'state', 'last_changed'],
    };
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme as 'dark' | 'light', reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (s) => s.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
        return route.fulfill({
          body: compiled.outputFiles!.find((f) =>
            f.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
          )!.text,
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        });
      if (url.pathname === '/api/agent-library')
        return route.fulfill({ json: { drafts: [], versions: [] } });
      if (url.pathname === '/api/agent-library/tools')
        return route.fulfill({ json: { tools: [...builtins, ...(published ? [entry] : [])] } });
      if (url.pathname === '/api/agent-library/api-tools')
        return route.fulfill({
          json: {
            templates: [template],
            drafts: draft ? [draft] : [],
            connections: [
              {
                id: 'fixture',
                label: 'Home Assistant fixture',
                endpoint: 'https://ha.example.com',
              },
            ],
          },
        });
      if (url.pathname === '/api/agent-library/api-tools/drafts') {
        saveAttempts++;
        if (saveAttempts === 1)
          return route.fulfill({
            status: 409,
            json: { error: 'Fixture save failed; retry preserves input' },
          });
        const body = route.request().postDataJSON();
        draft = {
          id: body.id,
          version: body.expectedVersion + 1,
          configuration: body.configuration,
          verified: false,
        };
        return route.fulfill({ json: { draft } });
      }
      if (url.pathname === '/api/credential-connections/reauthorize')
        return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
      if (url.pathname === '/api/agent-library/api-tools/verify') {
        expect(route.request().headers()['x-csrf-token']).toBe('fixture-csrf');
        attempts++;
        if (attempts === 1)
          return route.fulfill({ status: 400, json: { error: 'Fixture verification failed' } });
        draft = { ...draft, verified: true };
        return route.fulfill({ json: { draft } });
      }
      if (url.pathname === '/api/agent-library/api-tools/publish') {
        published = true;
        return route.fulfill({ json: { tool: entry } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
      return route.fulfill({
        contentType: 'text/html',
        headers: deployedSecurityHeaders(),
        body: `<html data-theme="${theme}" data-accent="${theme === 'dark' ? 'lavender' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Tool library', exact: true }).click();
    const open = page.getByRole('button', { name: 'Configure API tool', exact: true });
    await open.click();
    const editor = page.getByRole('region', { name: 'API tool configuration' });
    await editor.getByLabel('Tool name', { exact: true }).fill('Office temperature');
    await editor.getByRole('combobox', { name: 'Connection', exact: true }).selectOption('fixture');
    await editor.getByLabel('Entity ID', { exact: true }).fill('sensor.office');
    await editor.getByRole('heading', { name: 'Configure an API tool' }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`api-template-fields-${theme}.png`),
      animations: 'disabled',
    });
    await expect(editor.getByRole('button', { name: 'Publish tool', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Fixture save failed');
    await editor.getByRole('button', { name: 'Save draft', exact: true }).click();
    expect(attempts).toBe(0);
    await editor.getByText('Authorize verification', { exact: true }).click();
    await editor.getByLabel('App passphrase', { exact: true }).fill('fixture-passphrase');
    await editor.getByRole('button', { name: 'Authorize API verification', exact: true }).click();
    await editor.getByRole('button', { name: 'Verify API read', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText('Fixture verification failed');
    await expect(editor.getByRole('button', { name: 'Publish tool', exact: true })).toBeDisabled();
    await editor.getByRole('button', { name: 'Verify API read', exact: true }).click();
    await editor.getByText('Operation and implementation', { exact: true }).click();
    await expect(editor).toContainText('/api/states/sensor.office');
    await editor
      .getByRole('button', { name: 'Publish tool', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`api-template-${theme}.png`),
      animations: 'disabled',
    });
    await editor.getByRole('button', { name: 'Publish tool', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Office temperature', exact: true }),
    ).toBeVisible();
    const card = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Office temperature', exact: true }) });
    await card.locator('summary').first().click();
    await expect(card).toContainText('server/api-tool-template.ts');
    await expect(card).toContainText('a'.repeat(64));
    await editor.getByLabel('Entity ID', { exact: true }).fill('sensor.changed');
    await expect(
      editor.getByRole('button', { name: 'Verify API read', exact: true }),
    ).toBeDisabled();
    await editor.getByLabel('Entity ID', { exact: true }).press('Escape');
    await expect(open).toBeFocused();
    await open.click();
    await expect(editor.getByLabel('Entity ID', { exact: true })).toHaveValue('sensor.changed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    for (const button of await editor.locator('button, input, select').all()) {
      if (await button.isVisible())
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  });
