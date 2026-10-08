import { expect, test } from '@playwright/test';
import { readConnectionsAccess } from '../../server/connections-access.js';
import type { Connection } from '../../server/connections-store.js';

test('Connections describes account evidence and service scope without contradictory health warnings', async ({
  page,
}) => {
  const now = Date.now();
  await page.emulateMedia({ colorScheme: 'dark' });
  const base: Connection = {
    id: 'github-managed',
    ownerId: 'operator',
    templateId: 'github-readonly',
    templateVersion: 1,
    label: 'GitHub · developer/project',
    endpoint: 'https://api.github.com',
    publicConfig: { allowedRepositories: ['developer/project'], allowedBaseBranches: ['main'] },
    gatewayProviderName: 'managed-github',
    gatewayProviderId: 'provider-1',
    gateway: 'test',
    workspace: 'default',
    submittedEmail: '',
    status: 'active',
    revision: 1,
    desiredAccountIds: ['work'],
    identity: 'developer',
    verifiedAt: now - 86_400_000,
    errorCode: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const common = {
    billing: 'google-cloud',
    models: [{ id: 'luna', label: 'Luna' }],
    modelDiscovery: { stale: false },
    capabilities: { streaming: true, tools: true, images: false },
  };
  const inventory = await readConnectionsAccess({
    accounts: () => [
      {
        ...common,
        id: 'work',
        label: 'Work Vertex',
        provider: 'anthropic-vertex',
        lastSuccessfulUse: { model: 'luna', succeededAt: now - 600_000 },
      },
      {
        ...common,
        id: 'personal',
        label: 'Personal ChatGPT',
        provider: 'openai-codex',
        lastSuccessfulUse: { model: null, succeededAt: now - 600_000 },
        signIn: {
          status: 'verified',
          source: 'openshell-provider-grant',
          checkedAt: now,
          expiresAt: now + 3_600_000,
          configuredIdentity: { email: 'brokered-subscription@local.invalid', planType: 'pro' },
          observedIdentity: null,
          profileRevision: 'route',
          explanation:
            'The account connection check passed. Model and tool access are checked separately.',
        },
      },
    ],
    managed: () => [
      {
        ...base,
        publishingEnabled: true,
        capabilityGrants: [
          {
            id: 'grant',
            connectionId: base.id,
            connectionRevision: 1,
            capabilityId: 'github.publish-pr',
            capabilityVersion: 1,
            accountIds: ['work'],
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      {
        ...base,
        id: 'jira',
        templateId: 'jira-readonly',
        label: 'Jira',
        endpoint: 'https://example.atlassian.net',
        publicConfig: { email: 'person@example.test' },
        gatewayProviderName: 'managed-jira',
        identity: '712020:01234567-1234-1234-1234-123456789012',
      },
    ],
    legacy: async () => [
      { name: 'github', type: 'github' },
      { name: 'google-workspace', type: 'mitzo-google-workspace-spike' },
    ],
    gateway: 'test',
    workspace: 'default',
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname === '/api/connections-access' ? inventory : {},
    }),
  );
  await page.goto('/connections-access');
  const work = page.getByRole('article', { name: 'Work Vertex' });
  await expect(work.getByText('Set up', { exact: true })).toBeVisible();
  await expect(work.getByText(/Last used successfully:/)).toBeVisible();
  await expect(
    page.getByText(/Not verified|Not configured|Verification is stale|local\.invalid|712020:/),
  ).toHaveCount(0);
  const github = page.getByRole('article', { name: 'GitHub · developer/project' });
  await expect(github.getByText('Connection enabled', { exact: true })).toBeVisible();
  await expect(
    github.getByText('PR repositories: developer/project', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('article', { name: 'GitHub · additional connection' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Google Workspace' })).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: 'Jira' })
      .getByText('Configured account: person@example.test', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How web access works' })).toBeVisible();
  expect(
    await page.getByRole('main').evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('connections-evidence.png'),
    fullPage: true,
  });
  await page
    .getByRole('heading', { name: 'Services', exact: true })
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: test.info().outputPath('connections-services.png'),
    fullPage: true,
  });
  await github.getByRole('button', { name: 'Manage GitHub · developer/project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('PR repositories: developer/project', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Repository reads · PR publishing after approval', { exact: true }),
  ).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Manage Personal ChatGPT' }).click();
  await expect(
    page.getByRole('dialog').getByText('Model not recorded', { exact: true }),
  ).toBeVisible();
});
