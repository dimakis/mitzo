import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

test.use({ baseURL: 'https://mitzo-ui.test' });

async function fixtureUsage(page: Page, reported = true) {
  await page.addInitScript(() => {
    localStorage.setItem('mitzo:transport', 'ws');
    localStorage.setItem('mitzo-theme', 'dark');
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
          JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-tokens' }),
        );
      if (message.type === 'switch_session' && reported) {
        socket.send(
          JSON.stringify({
            type: 'token_update',
            sessionId: message.sessionId,
            agentContext: 80882,
            contextCeiling: 258400,
            sessionTotal: 634199,
            sessionTotalStatus: 'observed',
            numTurns: 1,
            turnIndex: 1,
            numCompactions: 0,
            tokenLimits: {
              model: 'fixture-model',
              source: 'runtime',
              contextWindow: 258400,
              stale: false,
            },
          }),
        );
      }
    });
  });
  const fixtures: Record<string, unknown> = {
    '/api/auth/check': { authenticated: true },
    '/api/config': { quickActions: [] },
    '/api/skills': [],
    '/api/sessions': [
      { id: 'token-fixture', summary: 'Token usage example', totalTokens: 0, isActive: false },
    ],
    '/api/accounts': [
      {
        id: 'fixture-account',
        label: 'Fixture account',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    ],
    '/api/home/briefing-chats': [],
    '/api/service-health': { services: [], checkedAt: Date.now() },
    '/api/tasks': [],
    '/api/sessions/token-fixture/messages': [],
    '/api/sessions/token-fixture/meta': {
      sessionType: 'chat',
      accountBinding: {
        accountId: 'fixture-account',
        accountLabel: 'Fixture account',
        model: 'fixture-model',
      },
      modelSelection: {
        model: 'fixture-model',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      },
    },
    '/api/sessions/token-fixture/symposium/status': {
      sessionId: 'token-fixture',
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
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
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
}

test('token usage separates capacity from cumulative usage with reachable help', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: isMobile ? 640 : 800 });
  await fixtureUsage(page);
  await page.goto('/chat/token-fixture');
  const wheel = page.getByRole('button', { name: 'Token usage', exact: true });
  await expect(wheel).toBeVisible();
  expect((await wheel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.token-bar--normal')).toBeVisible();
  await wheel.click();
  const panel = page.locator('.token-bar-detail');
  await expect(panel.getByText('Latest request', { exact: true })).toBeVisible();
  await expect(panel.getByText('80,882 / 258,400', { exact: true })).toBeVisible();
  await expect(panel.getByText('31% of effective limit', { exact: true })).toBeVisible();
  await expect(panel.getByText('634,199', { exact: true })).toBeVisible();
  const help = panel.locator('summary');
  await expect(help).toHaveText('How these numbers work');
  expect((await help.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'light' ? 'teal' : 'lavender';
      document.documentElement.dataset.font = theme === 'light' ? 'georgia' : 'system';
    }, appearance);
    await page.screenshot({
      path: testInfo.outputPath(`token-usage-${appearance}.png`),
      animations: 'disabled',
    });
    await help.focus();
    await help.press('Enter');
    await expect(panel.locator('details')).toHaveAttribute('open', '');
    const optimization = panel.getByText(/Repeated context and large tool results/);
    await optimization.scrollIntoViewIfNeeded();
    await expect(optimization).toBeInViewport();
    await expect(panel.getByText(/KV states/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`token-help-${appearance}.png`),
      animations: 'disabled',
    });
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await help.focus();
    await help.press('Enter');
    await expect(panel.locator('details')).not.toHaveAttribute('open', '');
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  await help.click();
  await panel.getByText(/not a cost figure/).scrollIntoViewIfNeeded();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath('token-help-larger-text.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(wheel).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
});

test('token usage stays hidden until usage is reported', async ({ page }) => {
  await fixtureUsage(page, false);
  await page.goto('/chat/token-fixture');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Token usage', exact: true })).toHaveCount(0);
});
