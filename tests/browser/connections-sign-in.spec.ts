import { expect, test } from '@playwright/test';

// Both configured Playwright projects cover this regression: phone WebKit and desktop Chromium.
test('shows broker connection evidence, configured identity and access scope separately', async ({
  page,
}) => {
  await page.routeWebSocket('**/*', (socket) => socket.close());
  let sourceUnavailable = false;
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/connections-access') {
      if (sourceUnavailable) {
        return route.fulfill({
          json: {
            generatedAt: Date.now(),
            resources: [],
            sources: [
              { id: 'accounts', state: 'unavailable', reason: 'Account source could not be read.' },
            ],
          },
        });
      }
      return route.fulfill({
        json: {
          generatedAt: 1_700_000_000_000,
          sources: [{ id: 'accounts', state: 'available', reason: null }],
          resources: [
            {
              id: 'account/work',
              kind: 'ai-account',
              section: 'accounts',
              owner: 'account-profiles',
              nativeId: 'work',
              gateway: null,
              workspace: null,
              label: 'Work Codex',
              provider: 'openai-codex',
              status: 'configured',
              revision: null,
              accountIdentity: 'configured@example.test',
              signIn: {
                status: 'verified',
                source: 'openshell-provider-grant',
                checkedAt: Date.now(),
                configuredIdentity: { email: 'configured@example.test', planType: 'pro' },
                observedIdentity: null,
                profileRevision: 'current-profile',
                explanation:
                  'Provider grant is valid. The configured email was not observed from the provider.',
              },
              verification: {
                state: 'unverified',
                verifiedAt: null,
                reason: 'Effective conversation access has not been checked.',
              },
              access: {
                summary: 'Configured model catalog',
                desiredAccountIds: [],
                observedAttachments: null,
                appliesTo: 'New conversations',
              },
              actions: [],
              details: { models: [{ id: 'luna', label: 'Luna' }] },
            },
          ],
        },
      });
    }
    // No backend, credentials or model requests are used in this test.
    return route.fulfill({ json: {} });
  });
  await page.goto('/connections-access');
  const row = page.getByRole('article', { name: 'Work Codex' });
  await expect(row.getByText('Sign-in: Connected', { exact: true })).toBeVisible();
  await expect(row.getByText('Configured: configured@example.test', { exact: true })).toBeVisible();
  await expect(row.getByText('Access: Not verified', { exact: true })).toBeVisible();
  await expect(row.getByText('Signed in', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('connections-sign-in-list.png'),
    fullPage: true,
  });
  await row.getByRole('button', { name: 'Manage Work Codex' }).click();
  const dialog = page.getByRole('dialog', { name: 'Work Codex' });
  await expect(dialog.getByText('Sign-in', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Connected', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Configured account', { exact: true })).toBeVisible();
  await expect(dialog.getByText('configured@example.test', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Last sign-in check', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Access verification', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText('Effective conversation access has not been checked.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText('Account', { exact: true })).toHaveCount(0);
  // Access uncertainty must not contradict the observed provider grant.
  await expect(dialog.locator('p').filter({ hasText: /sign-in.*not.*checked/i })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('connections-sign-in.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Close details' }).click();
  sourceUnavailable = true;
  await page.getByRole('button', { name: 'Refresh access' }).click();
  await expect(page.getByText('AI accounts: Source unavailable', { exact: true })).toBeVisible();
  await expect(row.getByText('Sign-in: Check is stale', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Manage Work Codex' }).click();
  await expect(dialog.getByText('Check is stale', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Showing an older account/)).toBeVisible();
  await expect(dialog.getByText('configured@example.test', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Last sign-in check', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Connected', { exact: true })).toHaveCount(0);
});
