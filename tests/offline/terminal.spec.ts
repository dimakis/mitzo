import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const mutations: { path: string; body: Record<string, unknown> }[] = [];
test.beforeEach(async ({ page }) => {
  mutations.length = 0;
  let preferences = { revision: 0, names: { briefing: 'Minion', terminal: 'Minion' }, pins: [] };
  let planConnected = false;
  let planDisconnected = false;
  let planRevocationPending = false;
  await page.addInitScript(() => {
    localStorage.setItem('mitzo-theme', 'dark');
    const original = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/events') && String(input).includes('/api/terminals/')) {
        return new Response(
          new ReadableStream({
            start(controller) {
              const long = (window as unknown as { terminalLongOutput?: boolean })
                .terminalLongOutput;
              let position = 80,
                seq = 1;
              const draw = (history: boolean) =>
                '\x1b[?1049h\x1b[H\x1b[2J' +
                Array.from(
                  { length: 20 },
                  (_, i) => `Retained row ${String(position + i + 1).padStart(3, '0')}`,
                ).join('\r\n') +
                (history ? '\r\nHistory view' : '\r\nReady prompt');
              window.addEventListener('offline-terminal-scroll', (event) => {
                if (!long || init?.signal?.aborted) return;
                const lines = (event as CustomEvent<{ lines: number | null }>).detail.lines;
                position = lines === null ? 80 : Math.max(0, Math.min(80, position + lines));
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: ' +
                      JSON.stringify({ type: 'output', data: draw(lines !== null), seq: ++seq }) +
                      '\n\n',
                  ),
                );
              });
              controller.enqueue(
                new TextEncoder().encode(
                  'data: ' +
                    JSON.stringify({
                      type: 'snapshot',
                      data: long
                        ? draw(false)
                        : '~/tools/mitzo\r\n❯ pwd\r\n/Users/operator/tools/mitzo\r\n❯ git status --short\r\n M frontend/src/pages/TerminalView.tsx\r\n❯ ',
                      seq: 1,
                    }) +
                    '\n\n',
                ),
              );
              init?.signal?.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  // Navigation can close the intercepted stream before abort cleanup.
                }
              });
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return original(input, init);
    };
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (request.method() !== 'GET')
        mutations.push({ path: url.pathname, body: request.postDataJSON() ?? {} });
      if (url.pathname === '/api/home/preferences') {
        if (request.method() === 'PUT') {
          const patch = request.postDataJSON();
          if (patch.revision !== preferences.revision)
            return route.fulfill({ status: 409, json: { error: 'Conflict' } });
          preferences = { ...preferences, names: patch.names, revision: preferences.revision + 1 };
        }
        return route.fulfill({ json: preferences });
      }
      const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
      if (url.pathname.endsWith('/scroll')) {
        await page.evaluate(
          (lines) =>
            window.dispatchEvent(new CustomEvent('offline-terminal-scroll', { detail: { lines } })),
          body.lines,
        );
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === '/api/terminals/subscriptions')
        return route.fulfill({
          json: {
            enabled: true,
            accounts:
              planConnected || planDisconnected
                ? [
                    {
                      id: 'plan-offline',
                      label: 'Personal ChatGPT',
                      email: 'user@example.test',
                      state: planConnected ? 'connected' : 'disconnected',
                      revocationPending: planRevocationPending,
                    },
                  ]
                : [],
          },
        });
      if (url.pathname === '/api/terminals/subscriptions/start')
        return route.fulfill({ status: 202, json: { id: 'attempt-offline', state: 'pending' } });
      if (url.pathname === '/api/terminals/subscriptions/plan-offline/disconnect') {
        planConnected = false;
        planDisconnected = true;
        planRevocationPending = true;
        return route.fulfill({ json: { revoked: false } });
      }
      if (url.pathname === '/api/terminals/subscriptions/attempts/attempt-offline') {
        planConnected = true;
        return route.fulfill({ json: { id: 'attempt-offline', state: 'connected' } });
      }
      const data =
        url.pathname === '/api/auth/check'
          ? { authenticated: true }
          : url.pathname === '/api/terminals'
            ? {
                id: 'term-offline',
                kind: body?.sessionId ? 'sandbox' : 'host',
                label: body?.sessionId ? 'This sandbox' : 'Your Mac',
                cwd: body?.sessionId ? '/workspace/mitzo' : '/Users/operator',
                state: 'running',
                createdAt: 1,
              }
            : url.pathname === '/api/terminals/context'
              ? {
                  selection: { accountId: 'work', model: 'luna-test', reasoningEffort: 'low' },
                  summary: { profile: 'Work OpenAI', model: 'Luna', thinking: 'Thinking: low' },
                }
              : url.pathname === '/api/terminals/accounts'
                ? [
                    ...(planConnected
                      ? [
                          {
                            id: 'plan-offline',
                            label: 'Personal ChatGPT',
                            models: [
                              {
                                id: 'luna-plan-test',
                                label: 'Plan Luna',
                                reasoningEfforts: ['low', 'high'],
                                defaultReasoningEffort: 'low',
                              },
                            ],
                          },
                        ]
                      : []),
                    {
                      id: 'work',
                      label: 'Work OpenAI',
                      models: [
                        {
                          id: 'luna-test',
                          label: 'Luna',
                          reasoningEfforts: ['low', 'high'],
                          defaultReasoningEffort: 'low',
                        },
                        {
                          id: 'luna-fast-test',
                          label: 'Luna Fast',
                          reasoningEfforts: ['low', 'high'],
                        },
                      ],
                    },
                  ]
                : url.pathname === '/api/terminals/destinations'
                  ? [{ sessionId: 'chat-a', label: 'Explore terminal routing' }]
                  : url.pathname.endsWith('/advice')
                    ? { text: 'Check the working directory.\n```sh\npwd\n```', commands: ['pwd'] }
                    : url.pathname === '/api/notifications'
                      ? { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false }
                      : url.pathname === '/api/service-health'
                        ? { services: [] }
                        : url.pathname === '/api/config'
                          ? { quickActions: [] }
                          : {};
      return route.fulfill({ json: data });
    }
    const root = resolve('frontend/dist'),
      file =
        url.pathname.startsWith('/assets/') || extname(url.pathname)
          ? url.pathname.slice(1)
          : 'index.html',
      path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    try {
      await route.fulfill({
        body: await readFile(path),
        contentType:
          (
            {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.html': 'text/html',
              '.svg': 'image/svg+xml',
              '.png': 'image/png',
            } as Record<string, string>
          )[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      await route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});

test('connects a subscription adviser through compact account management without terminal input', async ({
  page,
}, testInfo) => {
  await page.goto('/terminal');
  await page.getByRole('button', { name: 'Show Minion' }).click();
  await expect(page.getByRole('dialog', { name: 'Adviser accounts' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage adviser accounts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adviser accounts' });
  await expect(dialog).toBeVisible();
  const buttons = await dialog
    .getByRole('button')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
  expect(buttons.every((height) => height >= 44)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('adviser-accounts-dark.png') });
  await dialog.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }).click();
  await expect(dialog.getByRole('status')).toContainText('connected');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Account', { exact: true }).selectOption('plan-offline');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('luna-plan-test');
  await page.getByLabel('Thinking', { exact: true }).selectOption('high');
  expect(mutations.filter((item) => item.path.endsWith('/input'))).toHaveLength(0);
  expect(mutations.find((item) => item.path.endsWith('/subscriptions/start'))?.body).toEqual({
    label: 'Personal ChatGPT',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await page.getByRole('button', { name: 'Manage adviser accounts' }).click();
  await expect(dialog.getByRole('button', { name: 'Disconnect Personal ChatGPT' })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('adviser-accounts-light.png') });
});

test('retains remote sign-out recovery instructions after account refresh and navigation', async ({
  page,
}, testInfo) => {
  await page.goto('/terminal');
  await page.getByRole('button', { name: 'Show Minion' }).click();
  await page.getByRole('button', { name: 'Manage adviser accounts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adviser accounts' });
  await dialog.getByRole('button', { name: 'Continue with ChatGPT on your Mac' }).click();
  await expect(dialog.getByRole('status')).toContainText('connected');
  await dialog.getByRole('button', { name: 'Disconnect Personal ChatGPT' }).click();
  const recovery = dialog.getByText(
    'Remote sign-out was not confirmed; disconnect Mitzo in ChatGPT Settings.',
  );
  await expect(recovery).toBeVisible();
  await dialog.getByRole('button', { name: 'Refresh adviser accounts' }).click();
  await expect(recovery).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('adviser-revocation-dark.png') });
  await page.goto('/more');
  await page.goto('/terminal');
  await page.getByRole('button', { name: 'Show Minion' }).click();
  await page.getByRole('button', { name: 'Manage adviser accounts' }).click();
  await expect(recovery).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await expect(
    dialog.getByRole('button', { name: 'Sign in again to Personal ChatGPT' }),
  ).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('adviser-revocation-light.png') });
  expect(mutations.filter((item) => item.path.endsWith('/input'))).toHaveLength(0);
});

test('keeps the shared masthead and gives the terminal most of the mobile viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/more');
  const mobile = testInfo.project.name.startsWith('mobile');
  const brand = page.locator(
    mobile ? '.mobile-workspace-masthead .mitzo-brand' : '.workspace-rail .mitzo-brand',
  );
  const before = await brand.boundingBox();
  await page.getByRole('link', { name: 'Terminal', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Connected');
  expect(await brand.boundingBox()).toEqual(before);
  expect(
    await page
      .locator('.terminal-console')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThan(200);
  expect(await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('terminal-collapsed.png') });
  const height = await page
    .locator('.terminal-console')
    .evaluate((element) => element.getBoundingClientRect().height);
  await expect(page.getByRole('button', { name: 'Show controls' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect
    .poll(() =>
      page
        .locator('.terminal-console')
        .evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeLessThan(height - 35);
  await page.screenshot({ path: testInfo.outputPath('terminal-focus.png') });
});

test('reviews adviser output and stages commands before explicit execution', async ({
  page,
}, testInfo) => {
  await page.goto('/terminal?sessionId=chat-a&returnTo=%2Fchat%2Fchat-a');
  await expect(page.getByRole('status')).toContainText('Connected');
  await expect(page.getByRole('link', { name: 'Back to chat' })).toHaveAttribute(
    'href',
    '/chat/chat-a',
  );
  await page.getByRole('button', { name: 'Show Minion' }).click();
  await expect(page.getByLabel('Account', { exact: true })).toHaveValue('work');
  await page.getByLabel('Thinking', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Share output' }).click();
  await page.getByLabel('Reviewed output').fill('Reviewed safe output');
  await page.getByLabel('Ask Minion').fill('What should I check?');
  await page.getByRole('button', { name: 'Ask adviser' }).click();
  await page.getByRole('button', { name: 'Use pwd', exact: true }).click();
  await expect(page.getByLabel('Command', { exact: true })).toHaveValue('pwd');
  expect(mutations.filter((item) => item.path.endsWith('/input'))).toHaveLength(0);
  expect(mutations.find((item) => item.path.endsWith('/advice'))?.body).toMatchObject({
    accountId: 'work',
    model: 'luna-test',
    reasoningEffort: 'high',
    output: 'Reviewed safe output',
  });
  await page.getByRole('button', { name: 'Hide Minion' }).click();
  await page.getByRole('button', { name: 'Run command' }).click();
  await expect(page.getByLabel('Command', { exact: true })).toHaveValue('');
  expect(mutations.filter((item) => item.path.endsWith('/input'))).toEqual([
    { path: '/api/terminals/term-offline/input', body: { data: 'pwd\r' } },
  ]);
  await page.getByRole('button', { name: 'Previous command' }).click();
  await expect(page.getByLabel('Command', { exact: true })).toHaveValue('pwd');
  await page.screenshot({ path: testInfo.outputPath('terminal-chat.png') });
});

test('keeps command and adviser input reachable when the phone keyboard reduces the viewport', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Phone keyboard layout');
  await page.goto('/terminal');
  await expect(page.getByRole('status')).toContainText('Connected');
  const original = page.viewportSize()!;
  await page.getByLabel('Command', { exact: true }).focus();
  await page.setViewportSize({ ...original, height: 420 });
  await expect
    .poll(async () => {
      const box = await page.getByLabel('Command', { exact: true }).boundingBox();
      return box!.y + box!.height;
    })
    .toBeLessThanOrEqual(420);
  await page.setViewportSize(original);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await page.getByRole('button', { name: 'Show Minion' }).click();
  await page.getByLabel('Ask Minion').focus();
  await page.setViewportSize({ ...original, height: 420 });
  await expect
    .poll(async () => {
      const box = await page.getByLabel('Ask Minion').boundingBox();
      return box!.y + box!.height;
    })
    .toBeLessThanOrEqual(420);
  await page.screenshot({ path: testInfo.outputPath('terminal-keyboard.png') });
});

test('Settings saves one workspace terminal name and the terminal uses it after navigation', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('mitzo-assistant-name', 'Old browser name'));
  await page.goto('/settings');
  await expect(page.getByLabel('Terminal minion name')).toHaveValue('Minion');
  await expect(page.getByLabel('Assistant name', { exact: true })).toHaveCount(0);
  await page.getByLabel('Briefing minion name').fill('Jeeves');
  await page.getByLabel('Terminal minion name').fill('Orbit');
  await page.getByRole('button', { name: 'Save names', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Names saved.');
  await page.goto('/terminal');
  await page.getByRole('button', { name: 'Show Orbit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ask Orbit', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Show Old browser name', exact: true }),
  ).toHaveCount(0);
  expect(mutations.filter(({ path }) => path === '/api/home/preferences')).toEqual([
    {
      path: '/api/home/preferences',
      body: { revision: 0, names: { briefing: 'Jeeves', terminal: 'Orbit' } },
    },
  ]);
});

test('scrolls long tmux output with touch and wheel while keeping controls compact', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    (window as unknown as { terminalLongOutput: boolean }).terminalLongOutput = true;
  });
  await page.goto('/terminal');
  await expect(page.getByRole('status')).toContainText('Connected');
  await expect(page.locator('.xterm-rows')).toContainText('Retained row 081');
  const output = page.getByLabel('Interactive terminal');
  await output.dispatchEvent('wheel', { ctrlKey: true, deltaY: 100, deltaMode: 0 });
  expect(
    mutations.filter((item) => item.path.endsWith('/scroll') || item.path.endsWith('/input')),
  ).toHaveLength(0);
  const bounds = await output.boundingBox();
  const body = await page.locator('.terminal-page').boundingBox();
  expect(bounds!.height).toBeGreaterThan(300);
  if (testInfo.project.name.startsWith('mobile'))
    expect(bounds!.height).toBeGreaterThan(body!.height * 0.65);
  await output.evaluate((element) => {
    const point = (y: number) => ({ identifier: 1, clientY: y, clientX: 100, target: element });
    const fire = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point(y)] });
      element.dispatchEvent(event);
    };
    fire('touchstart', 100);
    fire('touchmove', 180);
    fire('touchend', 180);
  });
  await expect(page.getByRole('button', { name: 'Live output', exact: true })).toBeVisible();
  expect(mutations.filter((item) => item.path.endsWith('/scroll')).at(-1)?.body.lines).toBeLessThan(
    0,
  );
  await expect(page.locator('.xterm-rows')).not.toContainText('Retained row 100');
  await page.getByRole('button', { name: 'Live output', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Live output', exact: true })).toHaveCount(0);
  await expect(page.locator('.xterm-rows')).toContainText('Retained row 100');
  expect(mutations.filter((item) => item.path.endsWith('/scroll')).at(-1)?.body).toEqual({
    lines: null,
  });
  await output.dispatchEvent('wheel', { deltaY: 160, deltaMode: 0 });
  await expect(page.getByRole('button', { name: 'Live output', exact: true })).toBeVisible();
  expect(mutations.filter((item) => item.path.endsWith('/input'))).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('terminal-compact-dark.png') });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await page.setViewportSize({
    ...page.viewportSize()!,
    width: testInfo.project.name.startsWith('mobile') ? 320 : 1280,
  });
  expect(await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('terminal-compact-light.png') });
});
