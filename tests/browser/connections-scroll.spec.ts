import { expect, test } from '@playwright/test';

for (const state of ['loaded', 'loading', 'error'] as const) {
  test(`Connection management stays reachable with native document scrolling disabled: ${state}`, async ({
    page,
    isMobile,
  }) => {
    // Capacitor's Keyboard.setScroll({ isDisabled: true }) disables the native
    // document scroller. Lock it here so a body scroll cannot mask the regression.
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.overflow = 'hidden';
        document.body.style.cssText = 'height: 100dvh; overflow: hidden';
      });
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/connections') {
        return route.fulfill({
          json: {
            connections: [],
            legacy: [],
            eligibleAccounts: ['work'],
            appliesTo: 'new conversations only',
          },
        });
      }
      if (path === '/api/symposium/personal/connections') {
        if (state === 'loading') return;
        if (state === 'error')
          return route.fulfill({ status: 503, json: { error: 'Personal accounts unavailable' } });
        return route.fulfill({
          json: {
            connections: Array.from({ length: 8 }, (_, index) => ({
              id: `personal-${index}`,
              label: `Personal account ${index + 1}`,
              revision: 1,
              state: 'disconnected',
            })),
          },
        });
      }
      if (path === '/api/connections/templates') {
        return route.fulfill({ json: { templates: [] } });
      }
      // All backend traffic is mocked: no credentials or model calls.
      return route.fulfill({ json: {} });
    });
    await page.goto('/connections?manage=personal');
    if (state === 'loaded')
      await expect(page.getByRole('heading', { name: 'Personal account 8' })).toBeVisible();
    else if (state === 'loading')
      await expect(page.getByText('Loading personal accounts…', { exact: true })).toBeVisible();
    else await expect(page.getByText(/Could not load personal accounts/)).toBeVisible();
    const main = page.getByRole('main');
    const bottom = page.getByRole('button', { name: 'Refresh personal accounts', exact: true });

    for (const height of isMobile ? [844, 430] : [720]) {
      // A shorter viewport models KeyboardResize.Native and landscape/small phones.
      await page.setViewportSize({ width: isMobile ? 390 : 1280, height });
      await expect.poll(() => main.evaluate((element) => element.clientHeight)).toBeGreaterThan(0);
      if (state === 'loaded')
        await expect
          .poll(() => main.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThan(0);
      await main.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(bottom).toBeInViewport();
      if (isMobile) {
        const bottomBox = await bottom.boundingBox();
        const tabsBox = await page.locator('.workspace-tabs').boundingBox();
        expect(bottomBox!.y + bottomBox!.height).toBeLessThanOrEqual(tabsBox!.y);
      }
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(
        page.getByRole('heading', { name: 'Manage ChatGPT account', exact: true }),
      ).toBeInViewport();
    }
  });
}

test('Add connection opens a focused chooser and authorizes only after access review', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/connections')
      return route.fulfill({
        json: {
          connections: [],
          legacy: [],
          eligibleAccounts: ['work'],
          appliesTo: 'new conversations',
        },
      });
    if (path === '/api/connections/templates')
      return route.fulfill({
        json: {
          capabilities: [],
          templates: [
            {
              id: 'jira-readonly',
              version: 1,
              label: 'Jira',
              category: 'data',
              description: 'Read issues.',
              risk: 'read-only',
              available: true,
              capabilityTemplates: [],
              credentialFields: [
                {
                  key: 'token',
                  label: 'API token',
                  description: 'Use a scoped token.',
                  style: 'api-token',
                  secret: true,
                  required: true,
                },
              ],
              connectionFields: [
                {
                  key: 'email',
                  label: 'Atlassian account email',
                  description: 'Account identity.',
                  kind: 'email',
                  required: true,
                },
              ],
            },
          ],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Add connection', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose ChatGPT', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose Jira', exact: true })).toBeVisible();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Account label', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Choose Jira', exact: true }).click();
  await page.getByLabel('API token', { exact: true }).fill('fixture-token');
  await page.getByLabel('Atlassian account email', { exact: true }).fill('person@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
  await page.getByLabel('work', { exact: true }).check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByLabel('Passphrase', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify and connect Jira', exact: true }).click();
  await expect(page.getByLabel('Passphrase', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByLabel('API token', { exact: true })).toHaveValue('fixture-token');
});

test('new OpenAI API enrollment requires identity and billing consent without changing existing chats', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  const accounts: Array<{
    id: string;
    requestId: string;
    label: string;
    projectLabel: string;
    state: string;
  }> = [];
  let submissions = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/connections')
      return route.fulfill({
        json: {
          connections: [],
          legacy: [],
          eligibleAccounts: [],
          openAIAccountsManaged: true,
          appliesTo: 'new conversations only',
        },
      });
    if (path === '/api/connections/templates')
      return route.fulfill({ json: { templates: [], capabilities: [] } });
    if (path === '/api/connections/reauthorize')
      return route.fulfill({ json: { csrf: 'fixture-csrf', expiresAt: Date.now() + 60000 } });
    if (path === '/api/connections/openai-accounts') {
      if (route.request().method() === 'GET')
        return route.fulfill({ json: { enabled: true, accounts } });
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({
        csrf: 'fixture-csrf',
        label: 'Work Research',
        projectLabel: 'Research work project',
        apiKey: 'fixture-one-shot-key',
        billingConfirmed: true,
      });
      expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
      submissions += 1;
      const account = {
        id: 'fixture-new-work',
        requestId: input.requestId,
        label: input.label,
        projectLabel: input.projectLabel,
        state: 'ready',
      };
      accounts.push(account);
      return route.fulfill({ status: 201, json: { account } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/connections');
  await page.getByRole('link', { name: 'Choose OpenAI API' }).click();
  await expect(
    page.getByRole('heading', { name: 'Add OpenAI API account', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm identity to add an account' }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('fixture-passphrase');
  await page.getByRole('button', { name: 'Reauthorize', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Work Research');
  await page
    .getByLabel('Intended work project name', { exact: true })
    .fill('Research work project');
  await page.getByLabel('API key', { exact: true }).fill('fixture-one-shot-key');
  await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('type', 'password');
  await expect(page.getByText(/gpt-6-luna/)).toContainText('newly entered key’s project');
  await expect(page.getByText(/does not verify the key’s project identity/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validate and add account' })).toBeDisabled();
  await page.getByRole('checkbox').check();
  const checkbox = await page.getByRole('checkbox').boundingBox();
  expect(checkbox?.width).toBeLessThanOrEqual(24);
  const consent = await page
    .getByText('I authorize this validation charge to the project associated with this key.', {
      exact: true,
    })
    .boundingBox();
  expect(consent).not.toBeNull();
  expect(consent!.x + consent!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: test.info().outputPath('openai-account-enrollment.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Validate and add account' }).click();
  await expect(page.getByText('Work Research is ready for new chats.')).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Existing tasks keep their current account/)).toBeVisible();
  expect(submissions).toBe(1);
  await page.screenshot({
    path: test.info().outputPath('openai-account-enrolled.png'),
    fullPage: true,
  });
});
