import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

test.use({ baseURL: 'https://mitzo-ui.test' });
const question = 'What state are my Strats in?';
const reference =
  'Strats means RHAISTRAT. Use the maintained Jira command.\n' +
  'Reference evidence.\n'.repeat(600);
const expanded = `The user has attached the following reference files for this message.\nUse them to inform your response.\n\n<context name="Jira Essentials" source="jira_process/context/agent-routing.md">\n${reference}\n</context>\n\n---CONTEXT_END---\n${question}`;

async function fixture(page: Page) {
  const sent: Record<string, unknown>[] = [];
  let echo: (() => void) | undefined;
  const history: unknown[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('mitzo:transport', 'ws');
    localStorage.setItem('mitzo-theme', 'dark');
  });
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        socket.send(
          JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'context-fixture' }),
        );
      if (message.type === 'switch_session')
        socket.send(
          JSON.stringify({
            type: 'session_state_changed',
            sessionId: message.sessionId,
            state: 'idle',
          }),
        );
      if (message.type === 'send') {
        sent.push(message);
        echo = () => {
          const user = {
            messageId: message.clientMsgId,
            role: 'user',
            contextBlocks: ['Jira Essentials'],
            blocks: [{ blockId: 'text', blockType: 'text', content: expanded }],
          };
          history.push(user);
          socket.send(
            JSON.stringify({
              type: 'user_message',
              v: 2,
              sessionId: 'context-fixture',
              messageId: message.clientMsgId,
              text: expanded,
              contextBlocks: ['Jira Essentials'],
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'session_state_changed',
              sessionId: 'context-fixture',
              state: 'idle',
            }),
          );
        };
      }
    });
  });
  const account = {
    id: 'fixture-account',
    label: 'Fixture account',
    models: [{ id: 'fixture-model', label: 'Fixture model' }],
  };
  const fixtures: Record<string, unknown> = {
    '/api/auth/check': { authenticated: true },
    '/api/config': {
      quickActions: [],
      contextBlocks: {
        'Jira Essentials': {
          path: 'jira_process/context/agent-routing.md',
          sizeBytes: reference.length,
        },
      },
    },
    '/api/skills': [],
    '/api/accounts': [account],
    '/api/tasks': [],
    '/api/sessions/context-fixture/outputs': { outputs: [], candidates: [] },
    '/api/home/briefing-chats': [],
    '/api/service-health': { services: [], checkedAt: 0 },
    '/api/sessions': [
      {
        id: 'context-fixture',
        summary: 'Context injection example',
        totalTokens: 0,
        isActive: false,
      },
    ],
    '/api/sessions/context-fixture/meta': {
      sessionType: 'chat',
      accountBinding: {
        accountId: account.id,
        accountLabel: account.label,
        model: 'fixture-model',
      },
      modelSelection: { model: 'fixture-model', models: account.models },
    },
    '/api/sessions/context-fixture/symposium/status': {
      sessionId: 'context-fixture',
      config: null,
      seats: [],
    },
  };
  const types: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
      return route.fulfill({
        json:
          url.pathname === '/api/sessions/context-fixture/messages'
            ? history
            : (fixtures[url.pathname] ?? {}),
      });
    }
    const root = resolve('frontend/dist');
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const path = resolve(root, file);
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
  return {
    sent,
    acknowledge: () => {
      if (!echo) throw Error('No submitted message');
      echo();
    },
  };
}

test('context selection is visible on send, echoed content collapses, and replay keeps the same disclosure', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 740 : 900 });
  const transport = await fixture(page);
  await page.goto('/chat/context-fixture');
  await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
  await page.getByRole('button', { name: 'Sources 0', exact: true }).click();
  await page.getByRole('button', { name: /^Jira Essentials/ }).click();
  await page.getByRole('button', { name: 'Close session tray', exact: true }).click();
  await page.getByLabel('Message Mitzo', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const selected = page.getByRole('button', { name: /Context selected/ });
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => transport.sent.length).toBe(1);
  transport.acknowledge();
  const injected = page.getByRole('button', { name: /Context injected/ });
  await expect(injected).toBeVisible();
  await expect(injected).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.msg-bubble-content')).toHaveText(question);
  await expect(page.locator('.msg-context-injection-source pre')).toHaveCount(0);
  expect((await injected.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'lavender';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`context-collapsed-${theme}.png`),
      animations: 'disabled',
    });
    await injected.focus();
    await injected.press('Enter');
    await expect(injected).toHaveAttribute('aria-expanded', 'true');
    const source = page.locator('.msg-context-injection-source pre');
    await expect(source).toHaveText(reference.trim());
    expect(await source.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    expect(await source.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`context-expanded-${theme}.png`),
      animations: 'disabled',
    });
    await injected.press('Enter');
    await expect(injected).toHaveAttribute('aria-expanded', 'false');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(injected).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.msg-bubble-content')).toHaveText(question);
  await injected.click();
  await expect(page.locator('.msg-context-injection-path')).toHaveText(
    'jira_process/context/agent-routing.md',
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
  expect(
    await page
      .locator('.msg-context-injection')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
});
