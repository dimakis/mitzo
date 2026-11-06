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
async function fixture(
  page: Page,
  existing = true,
  pending = true,
  requests?: Record<string, unknown>[],
  decisions: unknown[] = [],
) {
  const errors: string[] = [];
  let reads = 0;
  const live = new Map((requests ?? []).map((request) => [request.permId, request]));
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
      if (message.type === 'permission_response' && requests) {
        decisions.push(message);
        live.delete(message.permId);
        socket.send(
          JSON.stringify({ type: 'permission_resolved', sessionId, permId: message.permId }),
        );
      }
      if (message.type === 'switch_session' && requests) {
        socket.send(
          JSON.stringify({
            type: 'session_switched',
            sessionId,
            pendingPermissions: [...live.values()],
          }),
        );
      } else if (message.type === 'switch_session' && pending)
        socket.send(
          JSON.stringify({
            type: 'permission_request',
            sessionId,
            permId: 'pending',
            toolName: 'Bash',
            toolInput: 'fixture-command --input=' + 'long-request-path/'.repeat(50),
            description: 'Run the requested workspace check.',
            sessionGrantDescription: 'Keep workspace shell checks allowed until this session ends.',
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
      if (
        requests &&
        decodeURIComponent(url.pathname).startsWith('/api/notifications/permission:')
      ) {
        const id = decodeURIComponent(url.pathname).split('permission:')[1];
        return route.fulfill({
          json: { id: `permission:${id}`, sessionId, resolution: live.has(id) ? null : 'deny' },
        });
      }
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

for (const theme of ['dark', 'light']) {
  test(`Approval navigation: exact request and retained answers ${theme}`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 720 : 900 });
    await page.addInitScript((theme) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', 'mint');
      localStorage.setItem('mitzo-font', 'georgia');
    }, theme);
    const decisions: unknown[] = [];
    const errors = await fixture(
      page,
      true,
      true,
      [
        {
          permId: 'first',
          sessionId,
          toolName: 'AskUserQuestion',
          toolInput: '',
          questions: [
            {
              id: 'q',
              header: 'Choice',
              question: 'Which release?',
              options: [],
              multiSelect: false,
            },
          ],
        },
        {
          permId: 'second',
          sessionId,
          toolName: 'Bash',
          toolInput: 'check-second-request',
          title: 'Check release',
          tier: 'elevated',
        },
      ],
      decisions,
    );
    await page.goto(`/chat/${sessionId}?approval=second`);
    await expect(page.getByText('check-second-request', { exact: true })).toBeVisible();
    const picker = page.getByLabel('Pending approvals');
    await expect(picker).toHaveValue('second');
    await expect(page.getByText('2 pending', { exact: true })).toBeVisible();
    expect(decisions).toEqual([]);
    await picker.selectOption('first');
    await page.getByLabel('Your answer').fill('Ship the selected release');
    await picker.selectOption('second');
    await page.evaluate((sessionId) => {
      window.dispatchEvent(
        new CustomEvent('mitzo:open-notification', {
          cancelable: true,
          detail: { sessionId, notificationId: 'permission:first' },
        }),
      );
    }, sessionId);
    await expect(page).toHaveURL(new RegExp('approval=first'));
    await expect(page.getByLabel('Your answer')).toHaveValue('Ship the selected release');
    await picker.selectOption('second');
    await picker.focus();
    await expect(picker).toBeFocused();
    expect((await picker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(
        `responsiveness-approval-navigation-${testInfo.project.name}-${theme}.png`,
      ),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.getByLabel('Your answer')).toHaveValue('Ship the selected release');
    expect(decisions).toEqual([
      expect.objectContaining({
        type: 'permission_response',
        sessionId,
        permId: 'second',
        decision: 'deny',
      }),
    ]);
    await page.evaluate((sessionId) => {
      window.dispatchEvent(
        new CustomEvent('mitzo:open-notification', {
          cancelable: true,
          detail: { sessionId, notificationId: 'permission:second' },
        }),
      );
    }, sessionId);
    await expect(
      page.getByText('This request was already handled.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Your answer')).toHaveCount(0);
    await page.getByLabel('Pending approvals').selectOption('first');
    await expect(page.getByLabel('Your answer')).toHaveValue('Ship the selected release');
    expect(errors).toEqual([]);
  });
}

for (const theme of ['dark', 'light']) {
  test(`Approval cards: quiet actions and complete details ${theme}`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 640 : 800 });
    await page.addInitScript(
      ({ theme }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', 'mint');
        localStorage.setItem('mitzo-font', 'georgia');
      },
      { theme },
    );
    const errors = await fixture(page);
    await page.goto(`/chat/${sessionId}`);
    const card = page.getByRole('region', { name: 'Approval required' });
    await expect(card).toBeVisible();
    await expect(
      card.getByText('Keep workspace shell checks allowed until this session ends.'),
    ).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    for (const name of ['Allow Once', 'Allow for session', 'Deny']) {
      const button = card.getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport();
      expect(
        await button.evaluate((el) => parseFloat(getComputedStyle(el).minHeight)),
      ).toBeGreaterThanOrEqual(44);
      expect(Math.round((await button.boundingBox())!.height * 1000) / 1000).toBeGreaterThanOrEqual(
        44,
      );
      await button.focus();
      await expect(button).toBeFocused();
      expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        'rgba(0, 0, 0, 0)',
      );
    }
    const actionBoxes = await Promise.all(
      ['Allow Once', 'Allow for session', 'Deny'].map((name) =>
        card.getByRole('button', { name, exact: true }).boundingBox(),
      ),
    );
    expect(
      Math.max(...actionBoxes.map((box) => box!.y)) - Math.min(...actionBoxes.map((box) => box!.y)),
    ).toBeLessThan(1);
    const details = card.locator('details');
    await expect(details).toHaveAttribute('open', '');
    await expect(card.locator('pre')).toContainText('long-request-path/'.repeat(50));
    for (const button of await card.getByRole('button').all())
      await expect(button).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await card.getByText('Request details', { exact: true }).click();
    await expect(details).not.toHaveAttribute('open', '');
    await card.getByText('Request details', { exact: true }).click();
    await page.evaluate((theme) => {
      if (theme === 'dark') document.documentElement.style.fontSize = '';
      const body = document.querySelector('.perm-banner-info');
      if (body) body.scrollTop = 0;
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`approval-${testInfo.project.name}-${theme}.png`),
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });
}
