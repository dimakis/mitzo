import { expect, test } from '@playwright/test';

// CI's isolated browser fixtures exercise both desktop Chromium and phone WebKit.
// Every API request is mocked; no credentials, models or sandbox backends are used.
test('key replacement keeps readable consent, progress and durable result feedback', async ({
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
    verifiedAt: null,
  };
  let allowSave!: () => void;
  const saved = new Promise<void>((resolve) => {
    allowSave = resolve;
  });
  let holdRefresh = false;
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
      if (holdRefresh) await refreshed;
      return route.fulfill({ json: { accounts: [account] } });
    }
    if (path === '/api/connections/openai-keys/work/replace') {
      expect(route.request().postDataJSON()).toMatchObject({
        apiKey: 'synthetic-key',
        sameProject: true,
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
  const consent = form.getByRole('checkbox');
  const box = await consent.boundingBox();
  expect(box!.width).toBe(20);
  const textBox = await form.locator('.connections-key-confirmation span').boundingBox();
  expect(textBox!.width).toBeGreaterThan(150);
  expect(textBox!.x).toBeGreaterThan(box!.x + box!.width);
  expect(Math.abs(textBox!.y - box!.y)).toBeLessThan(4);
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
  await consent.check();
  await form.getByRole('button', { name: 'Save API key', exact: true }).click();
  await expect(form.getByText(/Checking the key and updating/)).toBeVisible();
  await expect(key).toHaveCount(0);
  allowSave();
  await expect(form.getByText(/The key update is incomplete/)).toBeVisible();
  await expect(form.getByRole('button', { name: 'Finish key update', exact: true })).toBeVisible();
  holdRefresh = true;
  await form.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  allowRefresh();
  await expect(form.getByText(/Status refreshed at/)).toBeVisible();
  await expect(form.getByText(/The key update is incomplete/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('key-replacement-result.png'),
    fullPage: true,
  });
});
