import { disabledLocalCapabilities } from '../support/disabled-local-capabilities';
import { chooseSetting, openChatSetting, settingRow, settingsHome } from '../support/chat-settings';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { SessionCapabilityGrant } from '../../server/session-capability-grants';

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
async function fixture(page: Page, existing = false, pending = true, unknown = false) {
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
    '/api/session-launch/defaults': { revision: 0, configuration: null },
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
        if (unknown)
          return route.fulfill({ json: { sessionId, observedAt: Date.now(), state: 'unknown' } });
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
  await chooseSetting(page, 'Account', 'fixture-account');
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
  const access = page.getByRole('button', { name: 'Links & access', exact: true });
  await expect(access).toBeVisible();
  expect((await access.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await access.click();
  const dialog = page.locator('.chat-access-dialog');
  await expect(dialog).toHaveAccessibleName('Links & access');
  await expect(dialog.getByText(/No session has started/)).toBeVisible();
  await dialog.locator('.session-access-details > summary').click();
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
    await dialog.locator('.session-access-connection > summary').focus();
    await dialog.locator('.session-access-connection > summary').press('Enter');
    await expect(dialog.getByText('Configured Jira reads')).toBeVisible();
    await dialog.getByText(/google: unavailable/).scrollIntoViewIfNeeded();
    await expect(dialog.getByText(/google: unavailable/)).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`connections-${theme}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Back to Links & access' }).click();
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
  await page.getByRole('button', { name: 'Links & access', exact: true }).click();
  const dialog = page.locator('.chat-access-dialog');
  await dialog.locator('.session-access-details > summary').click();
  await expect(dialog.getByText(/callable tools have not been inventoried/)).toBeVisible();
  await dialog.getByRole('button', { name: /^Permissions/ }).click();
  await expect(dialog.getByText('Bash · request')).toBeVisible();
  await dialog.getByRole('button', { name: 'View pending approvals' }).click();
  await expect(page.locator('.perm-banner')).toBeInViewport();
  await page.getByRole('button', { name: 'Links & access', exact: true }).click();
  await dialog.getByRole('button', { name: 'Refresh Access' }).click();
  await expect(dialog.getByText(/Stale — refresh failed/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'View pending approvals' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('stale-access.png'), animations: 'disabled' });
  await dialog.press('Escape');
  expect(errors).toEqual([]);
});

test('Access: missing runtime evidence is independent of provider', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  const errors = await fixture(page, true, false, true);
  await page.goto(`/chat/${sessionId}`);
  await page.getByRole('button', { name: 'Links & access', exact: true }).click();
  const dialog = page.locator('.chat-access-dialog');
  await expect(
    dialog.getByText(/This runtime has not supplied current session evidence/),
  ).toBeVisible();
  await expect(dialog.getByText(/currently reports live Claude/)).toHaveCount(0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'lavender';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`unknown-runtime-${theme}.png`),
      animations: 'disabled',
    });
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Links & access', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('Access: selected sessions, expiry, revocation and human-review availability', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 800 });
  const errors = await fixture(page, true, false);
  const writes: unknown[] = [];
  let grants: SessionCapabilityGrant[] = [];
  const sessions = [
    {
      sessionId,
      title: 'Access fixture',
      cwd: '/tasks/current',
      account: 'fixture-account',
      mode: 'agent',
      revision: '1'.repeat(64),
      development: true,
      repository: 'fixture-repository',
    },
    {
      sessionId: 'second',
      title: 'Another task with a long readable title',
      cwd: '/tasks/second',
      account: 'fixture-account',
      mode: 'agent',
      revision: '2'.repeat(64),
      development: true,
      repository: 'fixture-repository',
    },
  ];
  await page.route(`**/api/sessions/${sessionId}/access-grants**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(body);
      expect(body.sessionIds).toEqual([sessionId, 'second']);
      expect(body.durationMinutes).toBe(15);
      expect(body.expectedContexts).toEqual({
        [sessionId]: '1'.repeat(64),
        second: '2'.repeat(64),
      });
      expect(route.request().headers()['x-mitzo-access-intent']).toBe('manage-grants');
      grants = [
        {
          id: 'shared',
          capability: body.capability,
          sessionIds: body.sessionIds,
          expiresAt: Date.now() + 15 * 60000,
          scope: body.scope,
        },
      ];
      return route.fulfill({ status: 201, json: grants[0] });
    }
    if (method === 'DELETE') {
      grants = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      json: {
        sessionId,
        observedAt: Date.now(),
        sessions,
        grants,
        automaticReview: {
          state: 'unavailable',
          reason:
            'A qualified reviewer and account route are unavailable. Human review handles remaining requests.',
        },
      },
    });
  });
  await page.goto(`/chat/${sessionId}`);
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  await composer.fill('Preserve this unsent draft');
  const access = page.getByRole('button', { name: 'Links & access', exact: true });
  await access.click();
  const dialog = page.locator('.chat-access-dialog');
  const manage = dialog.getByRole('button', { name: 'Manage reusable access' });
  await dialog.getByRole('button', { name: /^Permissions/ }).click();
  await manage.scrollIntoViewIfNeeded();
  await manage.click();
  await expect(dialog.getByText(/Human review handles remaining requests/)).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'mint';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, theme);
    await dialog.getByLabel('Access type').selectOption('github-read');
    await dialog
      .getByRole('textbox', { name: 'GitHub repository', exact: true })
      .fill('example/repo');
    const second = dialog.getByRole('checkbox', {
      name: 'Another task with a long readable title',
      exact: true,
    });
    const selectionLayout = await second.evaluate((input) => {
      const row = input.closest('label')!;
      return {
        checkbox: input.getBoundingClientRect().width,
        text: row.querySelector('span')!.getBoundingClientRect().width,
        row: row.getBoundingClientRect().width,
      };
    });
    expect(selectionLayout.checkbox).toBeLessThanOrEqual(24);
    expect(selectionLayout.text).toBeGreaterThan(selectionLayout.row * 0.75);
    await second.check();
    await dialog.getByLabel('Expires after').selectOption('15');
    const create = dialog.getByRole('button', { name: 'Grant access', exact: true });
    await expect(create).toBeEnabled();
    await create.focus();
    await page.keyboard.press('Enter');
    const revoke = dialog.getByRole('button', {
      name: 'Revoke GitHub repository reads: example/repo',
    });
    await expect(revoke).toBeVisible();
    await revoke.scrollIntoViewIfNeeded();
    expect((await revoke.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`reusable-access-${theme}.png`),
      animations: 'disabled',
    });
    await revoke.click();
    await expect(dialog.getByText('No active reusable grants.')).toBeVisible();
    for (const kind of ['development', 'google-read', 'telos-progress']) {
      await dialog.getByLabel('Access type').selectOption(kind);
      if (kind === 'google-read') {
        await dialog.getByLabel('Google account email').fill('fixture@example.test');
        await dialog.getByLabel('Resource ID').fill('fixture-document');
      }
      if (kind === 'telos-progress') await dialog.getByLabel('Telos item ID').fill('fixture-item');
      await dialog
        .getByLabel('Reuse in')
        .selectOption(kind === 'development' ? 'repository' : 'operator');
      await second.check();
      await create.click();
      const scopedRevoke = dialog.getByRole('button', {
        name: /^Revoke (Development|Google Workspace|Telos progress)/,
      });
      await expect(scopedRevoke).toBeVisible();
      await expect(
        dialog
          .locator('.reusable-access-grant')
          .getByText(
            kind === 'development'
              ? 'This repository and AI account, including future chats'
              : 'This login and AI account, including future chats',
            { exact: true },
          ),
      ).toHaveCount(1);
      await scopedRevoke.scrollIntoViewIfNeeded();
      expect((await scopedRevoke.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`reusable-access-${kind}-${theme}.png`),
        animations: 'disabled',
      });
      await scopedRevoke.click();
      await expect(dialog.getByText('No active reusable grants.')).toBeVisible();
    }
  }
  await dialog.press('Escape');
  await expect(access).toBeFocused();
  await expect(composer).toHaveValue('Preserve this unsent draft');
  expect(writes).toHaveLength(8);
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
  await page.getByRole('tab', { name: 'References' }).click();
  await page.getByRole('button', { name: /example.com.*references/ }).click();
  await expect(page.getByRole('button', { name: /example.com\/research/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sources' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Outputs', exact: true })).toBeVisible();
  await page.getByText('Observed tool names', { exact: true }).click();
  await expect(
    page.locator('.chat-resource-dialog').getByText('Read', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('references.png'), animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('Ordinary Agent settings keeps Model and Thinking together in the approved sheet without shared account renaming', async ({
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
  const account = settingRow(panel, 'Account');
  const model = settingRow(panel, 'Model');
  const thinking = settingRow(panel, 'Thinking');
  await expect(account).toHaveAttribute('data-value', 'fixture-account');
  await expect(model).toHaveAttribute('data-value', 'fixture-model');
  await expect(thinking).toHaveAttribute('data-value', 'high');
  const send = page.getByRole('button', { name: 'Start session', exact: true });
  await expect(send).toBeDisabled();
  async function assertFields() {
    const modelBox = (await model.boundingBox())!;
    const thinkingBox = (await thinking.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    // The approved sheet uses the same consecutive rows on phone and desktop.
    expect(thinkingBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height - 1);
    expect(Math.abs(thinkingBox.x - modelBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(accountBox.width - modelBox.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(accountBox.x - modelBox.x)).toBeLessThanOrEqual(1);
    expect(modelBox.y).toBeGreaterThanOrEqual(accountBox.y + accountBox.height - 1);
    for (const box of [accountBox, modelBox, thinkingBox])
      expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(input).toHaveValue(draft);
  }
  await openChatSetting(page, 'account');
  await expect(panel.locator('[data-setting-value="fixture-account"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(panel.getByRole('button', { name: 'Edit account alias', exact: true })).toHaveCount(
    0,
  );
  await expect(send).toBeDisabled();
  await settingsHome(page);
  await assertFields();
  await chooseSetting(page, 'Account', 'fixture-account');
  await expect(send).toBeEnabled();
  await expect(model).toHaveAttribute('data-value', 'fixture-model');
  await expect(thinking).toHaveAttribute('data-value', 'high');
  await openChatSetting(page, 'model');
  await expect(panel.locator('[data-setting-value="fixture-model"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await openChatSetting(page, 'thinking');
  await expect(panel.locator('[data-setting-value="high"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await settingsHome(page);
  await assertFields();
  await expect(input).toHaveValue(draft);
  expect(aliasWrites).toEqual([]);
  expect(sends).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath(`local-approved-agent-settings-legacy-alias-${width}-saved.png`),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
