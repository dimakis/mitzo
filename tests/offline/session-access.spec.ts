import { disabledLocalCapabilities } from '../support/disabled-local-capabilities';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const sessionId = 'access-chat';
const inventory = {
  generatedAt: Date.now(),
  resources: [
    {
      id: 'configured-jira',
      nativeId: 'jira',
      kind: 'managed-connection',
      section: 'services',
      owner: 'operator',
      label: 'Team Jira',
      provider: 'jira-readonly',
      status: 'active',
      verification: {
        state: 'unverified',
        verifiedAt: null,
        reason: 'Current conversation access has not been checked.',
      },
      access: {
        summary: 'Configured Jira reads',
        appliesTo: 'New conversations only',
        desiredAccountIds: ['fixture-account'],
        observedAttachments: null,
      },
      details: {},
      actions: [],
    },
  ],
  sources: [
    { id: 'accounts', state: 'available', reason: null },
    { id: 'google', state: 'unavailable', reason: 'Google could not be checked.' },
  ],
};
async function fixture(page: Page, existing = false, pending = true) {
  const errors: string[] = [];
  let reads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('mitzo:transport', 'ws');
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height:100dvh;overflow:hidden';
    });
  });
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        socket.send(
          JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-access' }),
        );
      if (message.type === 'switch_session' && pending)
        socket.send(
          JSON.stringify({
            type: 'permission_request',
            sessionId,
            permId: 'pending',
            toolName: 'Bash',
            toolInput: 'fixture command',
            approvalScope: 'request',
            tier: 'elevated',
          }),
        );
    });
  });
  const fixtures: Record<string, unknown> = {
    '/api/auth/check': { authenticated: true },
    '/api/config': { quickActions: [] },
    '/api/skills': [],
    '/api/accounts': [
      {
        id: 'fixture-account',
        label: 'Fixture account',
        provider: 'anthropic-vertex',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    ],
    '/api/sessions': existing ? [{ id: sessionId, summary: 'Access fixture', isActive: true }] : [],
    '/api/tasks': [],
    '/api/home/briefing-chats': [],
    '/api/service-health': { services: [], checkedAt: Date.now() },
    '/api/connections-access': inventory,
    [`/api/sessions/${sessionId}/meta`]: {
      sessionType: 'chat',
      accountBinding: {
        accountId: 'fixture-account',
        accountLabel: 'Fixture account',
        provider: 'anthropic-vertex',
        model: 'fixture-model',
      },
      modelSelection: {
        model: 'fixture-model',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    },
    [`/api/sessions/${sessionId}/messages`]: [
      {
        messageId: 'assistant',
        role: 'assistant',
        blocks: [
          {
            blockId: 'text',
            blockType: 'text',
            content: 'A historical reference: https://example.com/research',
          },
          {
            blockId: 'read',
            blockType: 'tool_use',
            content: '',
            toolName: 'Read',
            toolResult: 'https://example.com/read-result',
            toolResultImages: [{ id: 'fixture-image', mediaType: 'image/png' }],
          },
        ],
      },
    ],
    [`/api/sessions/${sessionId}/symposium/status`]: { sessionId, config: null, seats: [] },
    [`/api/sessions/${sessionId}/outputs`]: { outputs: [], candidates: [] },
  };
  const types: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.endsWith('/events'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (await disabledLocalCapabilities(route, url)) return;
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 405, json: { error: 'No writes in this fixture' } });
      if (url.pathname === `/api/sessions/${sessionId}/access`) {
        reads++;
        if (reads > 2) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        return route.fulfill({
          json: {
            sessionId,
            observedAt: Date.now(),
            state: 'current',
            account: {
              accountId: 'fixture-account',
              accountLabel: 'Fixture account',
              provider: 'anthropic-vertex',
            },
            model: 'fixture-model',
            mode: 'agent',
            grants: ['Read'],
            skillCeiling: null,
            pending: [{ permId: 'pending', toolName: 'Bash', scope: 'request' }],
            attachments: null,
            tools: null,
            limits: null,
          },
        });
      }
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const path = resolve(
      root,
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html',
    );
    if (!path.startsWith(root + '/')) return route.abort();
    try {
      await route.fulfill({
        body: await readFile(path),
        contentType: types[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
  return errors;
}

test('Access: empty ordinary composer survives Connections and return', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 640 : 800 });
  const errors = await fixture(page);
  await page.goto('/chat');
  const settings = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption('fixture-account');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(settings).toBeFocused();
  const composer = page.getByPlaceholder('Message Mitzo...');
  await composer.fill('Keep this draft intact');
  // A real file attachment remains client-side; this fixture forbids API writes.
  await page.locator('input[type=file]').setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  const access = page.getByRole('button', { name: 'Access', exact: true });
  await expect(access).toBeVisible();
  expect((await access.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await access.click();
  const dialog = page.getByRole('dialog', { name: 'Access', exact: true });
  await expect(dialog.getByText(/No session has started/)).toBeVisible();
  await expect(dialog.getByText('fixture-model', { exact: true })).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'lavender';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`empty-access-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(dialog.getByText('Team Jira')).toBeVisible();
    await dialog.locator('summary').focus();
    await dialog.locator('summary').press('Enter');
    await expect(dialog.getByText('Configured Jira reads')).toBeVisible();
    await dialog.getByText(/google: unavailable/).scrollIntoViewIfNeeded();
    await expect(dialog.getByText(/google: unavailable/)).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`connections-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Back to Access' }).click();
  }
  await dialog.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(composer).toHaveValue('Keep this draft intact');
  await expect(page.getByRole('button', { name: 'Remove attachment 1' })).toBeVisible();
  await expect(access).toBeFocused();
  expect(errors).toEqual([]);
});

test('Access: pending request, unknown capability and stale refresh', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  const errors = await fixture(page, true);
  await page.goto(`/chat/${sessionId}`);
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Access' });
  await expect(dialog.getByText('Bash · request')).toBeVisible();
  await expect(dialog.getByText(/callable tools have not been inventoried/)).toBeVisible();
  await dialog.getByRole('button', { name: 'View pending approvals' }).click();
  await expect(page.locator('.perm-banner')).toBeInViewport();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await dialog.getByRole('button', { name: 'Refresh Access' }).click();
  await expect(dialog.getByText(/Stale — refresh failed/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'View pending approvals' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('stale-access.png'), animations: 'disabled' });
  await dialog.press('Escape');
  expect(errors).toEqual([]);
});

test('References: historical links and observed tools are not outputs', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  const errors = await fixture(page, true, false);
  await page.goto(`/chat/${sessionId}`);
  await page.getByRole('button', { name: 'Open session tray' }).click();
  await page.getByRole('button', { name: 'References 2' }).click();
  await expect(page.getByRole('link', { name: 'example.com/research', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sources 0' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Outputs', exact: true })).toBeVisible();
  await page.getByText('Observed capabilities', { exact: true }).click();
  await expect(page.locator('.session-tray').getByText('Read', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('references.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('Ordinary legacy Agent settings keeps Model and Thinking paired while saving an account alias', async ({
  page,
  isMobile,
}, testInfo) => {
  const width = isMobile ? 390 : 1280;
  await page.setViewportSize({ width, height: isMobile ? 844 : 900 });
  const errors = await fixture(page);
  const sends: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /^\/api\/chat\/(?:runtime\/|local-codex\/)?send$/.test(path))
      sends.push(path);
  });
  await page.route('**/api/accounts', (route) =>
    route.fulfill({
      json: [
        {
          id: 'fixture-account',
          label: 'Fixture account',
          provider: 'anthropic-vertex',
          models: [
            {
              id: 'fixture-model',
              label: 'Fixture model',
              reasoningEfforts: ['low', 'high'],
              defaultReasoningEffort: 'high',
            },
          ],
        },
      ],
    }),
  );
  const aliasWrites: unknown[] = [];
  await page.route('**/api/accounts/fixture-account/alias', (route) => {
    expect(route.request().method()).toBe('PUT');
    aliasWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { label: 'Reviewed billing account' } });
  });
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  const draft = 'Retain this unsent draft while reviewing the billing alias';
  await input.fill(draft);
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const panel = page.getByRole('region', { name: 'Agent settings', exact: true });
  await expect(panel).toBeVisible();
  const account = panel.getByRole('combobox', { name: 'Account', exact: true });
  const model = panel.getByRole('combobox', { name: 'Model', exact: true });
  const thinking = panel.getByRole('combobox', { name: 'Thinking level', exact: true });
  await expect(account).toHaveValue('fixture-account');
  await expect(model).toHaveValue('fixture-model');
  await expect(thinking).toHaveValue('high');
  const send = page.getByRole('button', { name: 'Start session', exact: true });
  await expect(send).toBeDisabled();
  async function assertFields() {
    const modelBox = (await model.boundingBox())!;
    const thinkingBox = (await thinking.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    if (isMobile) {
      expect(thinkingBox.y).toBeGreaterThan(modelBox.y);
      expect(Math.abs(thinkingBox.x - modelBox.x)).toBeLessThanOrEqual(1);
    } else {
      expect(Math.abs(thinkingBox.y - modelBox.y)).toBeLessThanOrEqual(1);
      expect(thinkingBox.x).toBeGreaterThan(modelBox.x + modelBox.width);
      expect(accountBox.width).toBeGreaterThan(modelBox.width);
    }
    expect(Math.abs(accountBox.x - modelBox.x)).toBeLessThanOrEqual(1);
    expect(modelBox.y).toBeGreaterThan(accountBox.y + accountBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(input).toHaveValue(draft);
  }
  await assertFields();
  const rename = panel.getByRole('button', { name: 'Edit account alias', exact: true });
  const renameBox = (await rename.boundingBox())!;
  expect(renameBox.y + renameBox.height).toBeLessThanOrEqual((await model.boundingBox())!.y);
  await rename.click();
  const alias = panel.getByRole('textbox', { name: 'Account alias', exact: true });
  await expect(alias).toHaveValue('Fixture account');
  await alias.fill('Reviewed billing account');
  expect((await alias.boundingBox())!.y + (await alias.boundingBox())!.height).toBeLessThanOrEqual(
    (await model.boundingBox())!.y,
  );
  await assertFields();
  await page.screenshot({
    path: testInfo.outputPath(`local-approved-agent-settings-legacy-alias-${width}-editor.png`),
    fullPage: true,
  });
  await panel.getByRole('button', { name: 'Save alias', exact: true }).click();
  await expect(alias).toHaveCount(0);
  await expect(account.locator('option:checked')).toHaveText('Reviewed billing account');
  await expect(send).toBeDisabled();
  await assertFields();
  await account.selectOption('fixture-account');
  await expect(send).toBeEnabled();
  await expect(model).toHaveValue('fixture-model');
  await expect(thinking).toHaveValue('high');
  await expect(input).toHaveValue(draft);
  expect(aliasWrites).toEqual([{ alias: 'Reviewed billing account' }]);
  expect(sends).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath(`local-approved-agent-settings-legacy-alias-${width}-saved.png`),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
