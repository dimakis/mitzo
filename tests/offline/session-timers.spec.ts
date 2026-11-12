import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import type { SessionTimer } from '@mitzo/protocol';

// Match Mitzo's secure browser context without any network or backend server.
test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/session-timers.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/session-timers-fixture.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(`timers preserve Chats and composer controls (${theme})`, async ({ page }, info) => {
    const phone = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: phone ? 320 : 1280, height: 844 });
    const timers: SessionTimer[] = [
      {
        id: 'agent-timer',
        sessionId: 'worker',
        prompt: 'Check PR #7',
        intervalMinutes: 10,
        maxRuns: null,
        revision: 1,
        status: 'active',
        createdBy: 'agent',
        sourceSessionId: 'coordinator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextRunAt: Date.now() + 600000,
        lastRunAt: null,
        runCount: 0,
        lastError: null,
      },
    ];
    const template = timers[0];
    const mutations: Array<Record<string, unknown>> = [],
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      class OfflineEvents extends EventTarget {
        readyState = 1;
        close() {}
      }
      window.EventSource = OfflineEvents as unknown as typeof EventSource;
      localStorage.setItem('mitzo-session-view-mode', 'all');
    });
    const files = (await bundle).outputFiles!;
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (path === '/api/session-timers/sessions')
        return route.fulfill({ json: [{ sessionId: 'worker', title: 'PR worker' }] });
      if (path.startsWith('/api/session-timers')) {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          mutations.push(body);
          if (path === '/api/session-timers') {
            const created = {
              ...template,
              prompt: body.prompt,
              sessionId: body.sessionId,
              intervalMinutes: body.intervalMinutes,
              maxRuns: body.maxRuns,
              id: 'human-timer',
              status: 'active' as const,
              nextRunAt: Date.now() + (body.startImmediately ? 0 : body.intervalMinutes * 60000),
              createdBy: 'user' as const,
              sourceSessionId: null,
              revision: 1,
            };
            timers.push(created);
            return route.fulfill({ status: 201, json: created });
          }
          const timer = timers.find((t) => path.endsWith('/' + t.id))!;
          Object.assign(timer, {
            revision: timer.revision + 1,
            status:
              body.action === 'pause'
                ? 'paused'
                : body.action === 'cancel'
                  ? 'cancelled'
                  : 'active',
            nextRunAt:
              body.action === 'pause' || body.action === 'cancel' ? null : Date.now() + 600000,
          });
          if (body.action === 'delete') {
            timer.status = 'cancelled';
            timer.nextRunAt = null;
            timers.splice(timers.indexOf(timer), 1);
          }
          return route.fulfill({ json: timer });
        }
        return route.fulfill({ json: timers });
      }
      const data: Record<string, unknown> = {
        '/api/sessions': {
          sessions: [
            { id: 'worker', summary: 'PR worker', lastModified: Date.now(), isActive: false },
          ],
          hasMore: false,
        },
        '/api/config': { quickActions: [] },
        '/api/session-overview': [],
        '/api/version': {},
        '/api/telos/work/collection': { profiles: [], records: [], failures: [] },
        '/api/auth/check': { authenticated: true },
      };
      if (path in data) return route.fulfill({ json: data[path] });
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: file.text,
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/');
    await page.getByLabel('Conversation options', { exact: true }).click();
    await page.getByRole('button', { name: 'Timers', exact: true }).click();
    await page.getByRole('button', { name: 'Check PR #7', exact: true }).click();
    await expect(page.getByText('Created by agent', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume timer', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume timer', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel timer', exact: true }).click();
    await expect(page.getByText('Cancelled · Every 10 minutes', { exact: true })).toBeVisible();
    await expect(page.locator('.session-timer-full-prompt')).not.toHaveAttribute('open', '');
    await expect(page.getByRole('button', { name: 'Delete timer', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Delete timer', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await expect(page.getByText('Timer deleted.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByLabel('Conversation options', { exact: true })).toBeFocused();
    if (phone) await page.getByRole('link', { name: 'Open PR worker', exact: true }).click();
    else await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    const draft = page.getByRole('textbox', { name: /message|prompt/i }).first();
    await expect(draft).toHaveValue('Check PR #7 for new review comments.');
    const clock = page.getByRole('button', { name: 'Schedule prompt', exact: true });
    if (phone) {
      await expect(clock).not.toBeVisible();
      await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
    }
    await expect(clock).toBeVisible();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Attach images or PDF', exact: true }),
    ).toBeVisible();
    await clock.focus();
    await clock.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Check PR #7 for new review comments.',
    );
    await page.getByRole('spinbutton', { name: 'Every', exact: true }).fill('15');
    await page.screenshot({ path: info.outputPath('timer-create.png') });
    const box = await page
      .getByRole('dialog', { name: 'Schedule a prompt', exact: true })
      .boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(phone ? 320 : 1280);
    await page.getByRole('button', { name: 'Create timer', exact: true }).click();
    await expect(page.getByText('Created by you', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('timer-details.png') });
    await page.keyboard.press('Escape');
    await expect(draft).toHaveValue('Check PR #7 for new review comments.');
    if (phone)
      await expect(
        page.getByRole('button', { name: 'More composer actions', exact: true }),
      ).toBeFocused();
    else await expect(clock).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      mutations.some(
        (m) => m.prompt === 'Check PR #7 for new review comments.' && m.intervalMinutes === 15,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  });
