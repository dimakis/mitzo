import { expect, test } from '@playwright/test';

// CI's isolated browser fixtures exercise both desktop Chromium and phone WebKit.
// Every API request is mocked; no credentials, models or sandbox backends are used.
test('key replacement keeps readable billing disclosure, progress and durable result feedback', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  let account = {
    accountId: 'work',
    label: 'Work OpenAI API',
    health: 'not_verified',
    revision: 'v1',
    errorCode: null as string | null,
    canSynchronize: true,
    verifiedAt: null as number | null,
  };
  let allowSave!: () => void;
  const saved = new Promise<void>((resolve) => {
    allowSave = resolve;
  });
  let holdRefresh = false;
  let failRefresh = false;
  let loseSaveResponse = false;
  let allowRefresh!: () => void;
  const refreshed = new Promise<void>((resolve) => {
    allowRefresh = resolve;
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/connections')
      return route.fulfill({
        json: { connections: [], legacy: [], eligibleAccounts: [], openAIKeysManaged: true },
      });
    if (path === '/api/connections/templates')
      return route.fulfill({ json: { templates: [], capabilities: [] } });
    if (path === '/api/connections/reauthorize')
      return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
    if (path === '/api/connections/openai-keys') {
      if (failRefresh) {
        failRefresh = false;
        return route.abort();
      }
      if (holdRefresh) await refreshed;
      return route.fulfill({ json: { accounts: [account] } });
    }
    if (path === '/api/connections/openai-keys/work/replace') {
      if (loseSaveResponse) return route.abort();
      expect(route.request().postDataJSON()).toMatchObject({
        apiKey: 'synthetic-key',
        revision: 'v1',
      });
      await saved;
      account = {
        ...account,
        revision: 'v2',
        health: 'needs_attention',
        errorCode: 'CHAT_UPDATE_UNCONFIRMED',
      };
      return route.fulfill({ json: account });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/connections?manage=openai&connection=work');
  await page.getByRole('button', { name: 'Replace API key', exact: true }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('synthetic-passphrase');
  await page.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  const form = page.getByRole('region', { name: 'OpenAI API key management' });
  const key = form.getByLabel('New API key', { exact: true });
  await expect(key).toBeVisible();
  await expect(form.getByRole('checkbox')).toHaveCount(0);
  await expect(form.getByText(/OpenAI bills the account associated with this key/)).toBeVisible();
  expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const buttonFont = await form
    .getByRole('button', { name: 'Save API key', exact: true })
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(buttonFont).toBe(await key.evaluate((element) => getComputedStyle(element).fontFamily));
  await page.screenshot({
    path: test.info().outputPath('key-replacement-form.png'),
    fullPage: true,
  });
  await form.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(form.getByText('Enter your replacement API key.', { exact: true })).toBeVisible();
  await key.fill('synthetic-key');
  await form.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(form.getByText(/Checking the key and updating/)).toBeVisible();
  await expect(key).toHaveCount(0);
  allowSave();
  await expect(form.getByText(/The key is saved on this Mac/)).toBeVisible();
  await expect(form.getByRole('button', { name: 'Finish key update', exact: true })).toBeVisible();
  holdRefresh = true;
  await form.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  allowRefresh();
  await expect(form.getByText(/Status refreshed at/)).toBeVisible();
  await expect(form.getByText(/The key is saved on this Mac/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('key-replacement-result.png'),
    fullPage: true,
  });
  await form.getByRole('button', { name: 'Replace API key', exact: true }).click();
  await form.getByLabel('New API key', { exact: true }).fill('synthetic-key');
  loseSaveResponse = true;
  failRefresh = true;
  account = { ...account, revision: 'v3', health: 'ready', errorCode: null, verifiedAt: 200 };
  await form.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(form.getByText(/The details below may be out of date/)).toBeVisible();
  await expect(form.getByText(/the key may already have been saved/)).toBeVisible();
  await form.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(form.getByText('The saved key is ready to use.', { exact: true })).toBeVisible();
  await expect(form.getByText(/the key may already have been saved/)).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('key-replacement-confirmed-refresh.png'),
    fullPage: true,
  });
});
