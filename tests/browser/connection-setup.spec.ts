import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

const setup = {
  id: 'browser-draft',
  sessionId: 'original-chat',
  revision: 1,
  status: 'pending',
  expiresAt: Date.now() + 1_800_000,
  profile: 'home-assistant',
  setupUrl: '/connections/setup/browser-draft',
  connection: {
    label: 'Home Assistant',
    endpoint: 'https://ha.example.test',
    auth: { kind: 'bearer' },
    paths: ['/api/'],
    methods: ['GET', 'HEAD', 'POST'],
    allowPrivateNetwork: false,
  },
  credential: {
    label: 'Home Assistant key',
    instructions: 'Create a long-lived access token in your Home Assistant profile.',
    helpUrl: 'https://www.home-assistant.io/docs/authentication/',
  },
};

// Bundle the actual view, tool group, API wrapper and browser authorization cache.
// All requests terminate in Playwright's route handler; no backend or model exists.
async function mountFixture(page: Page, { cached = false, chat = false, reject = false } = {}) {
  const assets = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemoryRouter, Route, Routes } from 'react-router-dom';
      import { ConnectionSetupView } from './frontend/src/pages/ConnectionSetupView';
      import { ToolGroup } from './frontend/src/components/ToolGroup';
      import { reauthorizeKeychain } from './frontend/src/lib/credential-connections-api';
      import './frontend/src/styles/global.css';
      import './frontend/src/styles/workspace.css';
      import './frontend/src/styles/workspace-chat.css';
      import './frontend/src/styles/connections-setup.css';
      const setup=${JSON.stringify(setup)};
      const tools=[{blockId:'prepare',blockType:'tool_use',content:'',done:true,
        toolName:'mcp__mitzo-connections__PrepareConnectionSetup',toolResult:JSON.stringify({setup})},
        {blockId:'read',blockType:'tool_use',content:'',done:true,toolName:'Read',toolResult:'Documentation checked'}];
      (async()=>{
        ${cached ? "await reauthorizeKeychain('fixture-passphrase');" : ''}
        createRoot(document.getElementById('root')).render(
          <MemoryRouter initialEntries={[${JSON.stringify(chat ? '/chat/original-chat' : setup.setupUrl)}]}>
            <Routes>
              <Route path='/connections/setup/:setupId' element={<ConnectionSetupView/>}/>
              <Route path='/chat/:sessionId' element={<main className='workspace-page'><h1>Original task: turn on the oven</h1><ToolGroup tools={tools} sessionId='original-chat'/></main>}/>
            </Routes>
          </MemoryRouter>);
      })();`,
    },
    outfile: 'connection-setup.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
    alias: {
      '@mitzo/client': `${process.cwd()}/packages/client/src/index.ts`,
      '@mitzo/protocol': `${process.cwd()}/packages/protocol/src/index.ts`,
    },
  });
  const requests: Array<{ path: string; body: unknown; csrf?: string }> = [];
  let current = { ...setup };
  let denied = false;
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/fixture')
      return route.fulfill({
        contentType: 'text/html',
        body: `<meta name='viewport' content='width=device-width, initial-scale=1.0'><style>${assets.outputFiles.find((file) => file.path.endsWith('.css'))!.text}</style><style>html,body{height:100dvh;overflow:hidden}#root{height:100dvh}</style><div id='root'></div>`,
      });
    const body = route.request().postDataJSON();
    requests.push({ path, body, csrf: route.request().headers()['x-csrf-token'] });
    if (path === '/api/credential-connections/reauthorize')
      return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60_000 } });
    if (path === `/api/credential-connections/setups/${setup.id}/complete`) {
      if (reject && !denied) {
        denied = true;
        return route.fulfill({ status: 403, json: { error: 'Authorize again' } });
      }
      current = { ...setup, status: 'ready', revision: 2 };
      return route.fulfill({
        json: { setup: { ...current, delivery: 'delivered', connectionId: 'ha' } },
      });
    }
    if (path === `/api/credential-connections/setups/${setup.id}`)
      return route.fulfill({ json: { setup: current } });
    return route.abort();
  });
  await page.goto('http://connection-fixture.test/fixture');
  await page.addScriptTag({
    content: assets.outputFiles.find((file) => file.path.endsWith('.js'))!.text,
  });
  return requests;
}

test('chat-prepared setup stays visible when operations are collapsed and continues the original task', async ({
  page,
}, testInfo) => {
  const requests = await mountFixture(page, { chat: true, cached: true });
  await expect(page.getByRole('button', { name: /2 tool calls/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await testInfo.attach('chat-setup-action', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('link', { name: 'Add Home Assistant key' }).click();
  const key = page.getByLabel('Home Assistant key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Mitzo passphrase', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Authentication', { exact: true })).toHaveCount(0);
  await testInfo.attach('focused-key-only-setup', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await key.fill('fixture-key-only');
  await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home Assistant is connected' })).toBeVisible();
  const mutation = requests.find((request) => request.path.endsWith('/complete'))!;
  expect(mutation).toMatchObject({
    body: { revision: 1, secret: 'fixture-key-only' },
    csrf: 'fixture-csrf',
  });
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-key-only');
  await expect(page.getByText('fixture-key-only', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Return to chat' }).click();
  await expect(
    page.getByRole('heading', { name: 'Original task: turn on the oven' }),
  ).toBeVisible();
});

test('focused secure setup scrolls internally in a short viewport with native document scrolling disabled', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 430 });
  await mountFixture(page);
  const key = page.getByLabel('Home Assistant key', { exact: true });
  await expect(key).toBeVisible();
  await key.fill('fixture-key');
  await page.getByLabel('Mitzo passphrase', { exact: true }).fill('fixture-passphrase');
  const main = page.getByRole('main');
  expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await main.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const connect = page.getByRole('button', { name: 'Connect Home Assistant', exact: true });
  await expect(connect).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await testInfo.attach('setup-internal-scroll', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await connect.click();
  await expect(page.getByRole('heading', { name: 'Home Assistant is connected' })).toBeVisible();
});

test('refused cached authorization returns to inline reauthorization rather than retrying a revoked capability', async ({
  page,
}) => {
  const requests = await mountFixture(page, { cached: true, reject: true });
  await page.getByLabel('Home Assistant key', { exact: true }).fill('fixture-key');
  await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
  await expect(page.getByLabel('Mitzo passphrase', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Home Assistant key', { exact: true })).toHaveValue('');
  await page.getByLabel('Mitzo passphrase', { exact: true }).fill('fixture-new-passphrase');
  await page.getByLabel('Home Assistant key', { exact: true }).fill('fixture-key-retry');
  await page.getByRole('button', { name: 'Connect Home Assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home Assistant is connected' })).toBeVisible();
  expect(requests.filter((request) => request.path.endsWith('/reauthorize'))).toHaveLength(2);
});
