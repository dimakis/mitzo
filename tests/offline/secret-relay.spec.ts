import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
const relay = {
  id: 'relay-fixture',
  sessionId: 'original-chat',
  revision: 1,
  label: 'MQTT password',
  status: 'pending',
  expiresAt: Date.now() + 1800000,
  setupUrl: '/connections/secrets/relay-fixture',
  outcomes: [],
  targets: [
    {
      connectionId: 'ha',
      revision: 1,
      label: 'Home Assistant',
      endpoint: 'https://ha.example.test',
      path: '/api/set',
      method: 'POST',
      encoding: 'json',
      body: '{"username":"mqtt_user_heishamon","password":null}',
      fields: ['/password'],
    },
    {
      lanEndpoint: 'http://192.168.1.115',
      label: 'Heating controller',
      endpoint: 'http://192.168.1.115',
      path: '/settings',
      method: 'POST',
      encoding: 'form',
      body: 'mqtt_user=mqtt_user_heishamon&mqtt_password=',
      fields: ['mqtt_password'],
    },
  ],
};
const adapterRelay = {
  ...relay,
  label: 'Service sign-in',
  targets: [
    {
      adapter: 'mqtt',
      broker: 'mqtts://broker.example.test:8883',
      username: 'device',
      operation: 'publish',
      topic: 'home/device/set',
      payload: 'on',
      retain: false,
      allowPrivateNetwork: false,
      endpoint: 'mqtts://broker.example.test:8883',
      label: 'MQTT broker',
    },
    {
      adapter: 'browser',
      origin: 'https://service.example.test',
      endpoint: 'https://service.example.test',
      label: 'Service account',
      allowPrivateNetwork: false,
      requests: [
        { path: '/login', methods: ['GET', 'POST'] },
        { path: '/whoami', methods: ['GET'] },
        { path: '/settings', methods: ['GET', 'POST'] },
      ],
      login: {
        path: '/login',
        usernameSelector: '#user',
        username: 'device',
        passwordSelector: '#password',
        submitSelector: '#login',
      },
      mfa: { codeSelector: '#code', submitSelector: '#verify' },
      verification: { path: '/whoami', pointer: '/authenticated', equals: true },
      actions: [{ label: 'Save setting', path: '/settings', fields: [], submitSelector: '#save' }],
    },
  ],
};
async function mount(page: Page, light: boolean, adapters = false) {
  const selectedRelay = adapters ? adapterRelay : relay;
  const assets = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MemoryRouter,Routes,Route} from 'react-router-dom';
    import {ConnectionSetupView} from './frontend/src/pages/ConnectionSetupView';
    import {ConnectionSetupCard} from './frontend/src/components/ConnectionSetupCard';
    import './frontend/src/styles/tokens.css'; import './frontend/src/styles/global.css'; import './frontend/src/styles/workspace.css'; import './frontend/src/styles/connections-setup.css';
    const relay=${JSON.stringify(selectedRelay)};
    createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/chat/original-chat']}><Routes>
      <Route path='/chat/:id' element={<main className='workspace-page'><h1>Repair heating telemetry</h1><ConnectionSetupCard sessionId='original-chat' block={{blockId:'relay',blockType:'tool_use',done:true,content:'',toolName:'PrepareSecretRelay',toolResult:JSON.stringify({relay})}}/></main>}/>
      <Route path='/connections/secrets/:setupId' element={<ConnectionSetupView secretRelay/>}/>
    </Routes></MemoryRouter>);`,
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    outfile: 'relay.js',
    define: { 'import.meta.env': '{}' },
    external: ['/mitzo-wordmark.png', '/openshell-mark.svg', '/github-mark.svg'],
  });
  const captures: Array<{ path: string; body: unknown }> = [];
  let current = {
    ...selectedRelay,
    outcomes: [] as Array<{ outcome: string; challenge?: string }>,
  };
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/fixture')
      return route.fulfill({
        contentType: 'text/html',
        body: `<meta name='viewport' content='width=device-width,initial-scale=1'><style>${assets.outputFiles.find((f) => f.path.endsWith('.css'))!.text}</style><div id='root'></div>`,
      });
    const body = route.request().postDataJSON();
    captures.push({ path, body });
    if (path.endsWith('/reauthorize'))
      return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
    if (path.endsWith('/complete')) {
      current = {
        ...current,
        revision: 3,
        status: 'ready',
        outcomes: adapters
          ? [
              { outcome: 'confirmed' },
              { outcome: 'challenge_required', challenge: 'awaiting_code' },
            ]
          : [],
      };
      return route.fulfill({ json: { relay: { ...current, delivery: 'delivered' } } });
    }
    if (path.endsWith('/code')) {
      current = {
        ...current,
        revision: 5,
        outcomes: [
          { outcome: 'confirmed' },
          { outcome: 'challenge_required', challenge: 'code_ready' },
        ],
      };
      return route.fulfill({ json: { relay: current } });
    }
    if (path.endsWith('/cancel'))
      return route.fulfill({ json: { relay: { ...current, revision: 4, status: 'cancelled' } } });
    if (path === '/api/credential-connections/relays/relay-fixture')
      return route.fulfill({ json: { relay: current } });
    return route.abort();
  });
  await page.goto('http://relay-fixture.test/fixture');
  await page.evaluate((light) => {
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.documentElement.dataset.accent = light ? 'teal' : 'mint';
    document.documentElement.dataset.font = light ? 'georgia' : 'system';
  }, light);
  await page.addScriptTag({
    content: assets.outputFiles.find((f) => f.path.endsWith('.js'))!.text,
  });
  return captures;
}
for (const light of [false, true])
  test(`private relay capture, review and revoke (${light ? 'light' : 'dark'})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    const captures = await mount(page, light);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--font-ui').trim(),
      ),
    ).not.toBe('');
    await page.getByRole('link', { name: 'Add password or token' }).click();
    await expect(page.getByRole('heading', { name: 'Add MQTT password' })).toBeVisible();
    await expect(
      page.getByText('This device uses unencrypted HTTP', { exact: false }),
    ).toBeVisible();
    const details = page.getByText('Review request template', { exact: true }).first();
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('{"username":"mqtt_user_heishamon","password":null}', { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('private-relay.png'), fullPage: true });
    const password = page.getByLabel('Password or token', { exact: true });
    await password.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('private-relay-entry.png') });
    expect(
      await page
        .getByRole('button', { name: 'Save securely and continue' })
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
    await password.fill('synthetic-secret');
    await page.getByLabel('Mitzo passphrase', { exact: true }).fill('synthetic-unlock');
    await page.getByRole('button', { name: 'Save securely and continue' }).click();
    await expect(page.getByRole('heading', { name: 'MQTT password saved securely' })).toBeVisible();
    await expect(password).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain('synthetic-secret');
    expect(captures.filter((c) => c.path.endsWith('/complete'))).toEqual([
      {
        path: '/api/credential-connections/relays/relay-fixture/complete',
        body: { revision: 1, secret: 'synthetic-secret' },
      },
    ]);
    await expect(page.getByRole('link', { name: 'Return to chat' })).toHaveAttribute(
      'href',
      '/chat/original-chat',
    );
    await page.getByRole('button', { name: 'Revoke relay access' }).click();
    await expect(page.getByRole('heading', { name: 'Setup cancelled' })).toBeVisible();
  });

for (const light of [false, true])
  test(`private browser and MQTT review with MFA (${light ? 'light' : 'dark'})`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    const captures = await mount(page, light, true);
    await page.getByRole('link', { name: 'Add password or token' }).click();
    await expect(page.getByText('MQTT publish (QoS 1)', { exact: true })).toBeVisible();
    await expect(page.getByText('Browser sign-in at /login', { exact: true })).toBeVisible();
    await expect(page.getByText('Save setting at /settings', { exact: true })).toBeVisible();
    const disclosure = page.getByText('Review adapter configuration', { exact: true }).last();
    await disclosure.focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath('adapters-review.png'), fullPage: true });
    await page.getByLabel('Password or token', { exact: true }).fill('synthetic-password');
    await page.getByLabel('Mitzo passphrase', { exact: true }).fill('synthetic-unlock');
    await page.getByRole('button', { name: 'Save securely and continue' }).click();
    const code = page.getByLabel('Verification code', { exact: true });
    await expect(code).toBeVisible();
    await code.focus();
    await expect(code).toBeFocused();
    expect(await code.getAttribute('type')).toBe('password');
    const submit = page.getByRole('button', { name: 'Continue private sign-in' });
    expect(await submit.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
      44,
    );
    await page.screenshot({ path: info.outputPath('private-mfa.png'), fullPage: true });
    await code.fill('123456');
    await submit.click();
    await expect(code).toHaveCount(0);
    await expect(page.getByText('Verification code is ready.', { exact: false })).toBeVisible();
    expect(captures.filter((c) => c.path.endsWith('/code'))).toEqual([
      {
        path: '/api/credential-connections/relays/relay-fixture/code',
        body: { revision: 3, targetIndex: 1, code: '123456' },
      },
    ]);
    expect(await page.locator('body').innerText()).not.toMatch(/synthetic-password|123456/);
  });
