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
async function fixture(page: Page, existing = false, pending = true, codex = false) {
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
        provider: codex ? 'openai-codex' : 'anthropic-vertex',
        models: [{ id: codex ? 'fixture-luna' : 'fixture-model', label: 'Fixture model' }],
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
        provider: codex ? 'openai-codex' : 'anthropic-vertex',
        model: codex ? 'fixture-luna' : 'fixture-model',
      },
      modelSelection: {
        model: codex ? 'fixture-luna' : 'fixture-model',
        models: [{ id: codex ? 'fixture-luna' : 'fixture-model', label: 'Fixture model' }],
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
              provider: codex ? 'openai-codex' : 'anthropic-vertex',
            },
            model: codex ? 'fixture-luna' : 'fixture-model',
            ...(codex
              ? {
                  modelSource: 'accepted-turn',
                  runtime: { harness: 'codex', location: 'openshell' },
                }
              : {}),
            mode: 'agent',
            grants: ['Read'],
            skillCeiling: null,
            pending: pending ? [{ permId: 'pending', toolName: 'Bash', scope: 'request' }] : [],
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

test('Access: observed Codex route preserves drafts and scopes host approvals', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  const errors = await fixture(page, true, false, true);
  await page.goto(`/chat/${sessionId}`);
  const composer = page.getByPlaceholder('Message Mitzo...');
  await composer.fill('Keep the Codex draft');
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Access', exact: true });
  await expect(dialog.getByText('Codex', { exact: true })).toBeVisible();
  await expect(dialog.getByText('fixture-luna', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Last acknowledged model')).toBeVisible();
  await expect(dialog.getByText('OpenShell sandbox')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'lavender';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, theme);
    await dialog
      .locator('.access-resource-facts')
      .getByText('Account', { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(dialog.getByText('Fixture account', { exact: false })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`codex-access-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByText('Native Codex permissions').scrollIntoViewIfNeeded();
    await expect(
      dialog.getByText('Unknown — native permissions have not been reported here.'),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`codex-permissions-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(dialog.getByText('Team Jira')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`codex-connections-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Back to Access' }).click();
  }
  await dialog.getByRole('button', { name: 'Refresh Access' }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Refresh Access' })).toBeInViewport();
  await dialog.press('Escape');
  await expect(composer).toHaveValue('Keep the Codex draft');
  expect(errors).toEqual([]);
});

test('Access: empty ordinary composer survives Connections and return', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 640 : 800 });
  const errors = await fixture(page);
  await page.goto('/chat');
  await page.getByRole('button', { name: /Workspace controls/ }).click();
  await page.getByRole('button', { name: /Use Fixture account/ }).click();
  await page.getByRole('button', { name: /Workspace controls/ }).click();
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
