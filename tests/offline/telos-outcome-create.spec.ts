import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import type { createTelosSourceApprovalData } from '../../server/__tests__/fixtures/telos-source-approval-data';

// The real review component uses crypto.randomUUID, available in secure contexts.
test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/telos-outcome-create.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-outcome-create.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});

let createData: typeof createTelosSourceApprovalData;
test.beforeAll(async () => {
  // Notification configuration is captured at module initialization.
  delete process.env.NTFY_TOPIC;
  delete process.env.PUSHOVER_API_TOKEN;
  delete process.env.PUSHOVER_USER_KEY;
  createData = (await import('../../server/__tests__/fixtures/telos-source-approval-data'))
    .createTelosSourceApprovalData;
  await bundle;
});

for (const theme of ['dark', 'light'])
  for (const flow of ['direct', 'revision'])
    test(`Telos outcome: latest exchange, retry and ${flow} create (${theme})`, async ({
      page,
      isMobile,
    }, info) => {
      delete process.env.NTFY_TOPIC;
      delete process.env.PUSHOVER_API_TOKEN;
      delete process.env.PUSHOVER_USER_KEY;
      const host = createData();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw Error('Offline host forbids network');
      };
      try {
        const permission = await host.request({ kind: 'create', marker: 'native' });
        const files = (await bundle).outputFiles;
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const saves: unknown[] = [];
        const feedback: unknown[] = [];
        let failRead = true;
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== 'https://mitzo-ui.test') throw Error('Unexpected external request');
          if (url.pathname === '/fixture.js' || url.pathname === '/fixture.css')
            return route.fulfill({
              body: files.find((file) =>
                file.path.endsWith(url.pathname.endsWith('.js') ? '.js' : '.css'),
              )!.text,
              contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
            });
          if (url.pathname === '/fixture/permission') return route.fulfill({ json: permission });
          if (url.pathname === '/')
            return route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
            });
          const match = url.pathname.match(
            /^\/api\/telos\/work\/source\/permissions\/([^/]+)(?:\/(preview|approve|request-changes))?$/,
          );
          if (!match) return route.abort();
          if (!match[2] && failRead) {
            failRead = false;
            return route.fulfill({
              status: 503,
              json: { code: 'unavailable', error: 'Temporary read failure' },
            });
          }
          try {
            const body = match[2] ? route.request().postDataJSON() : null;
            if (match[2] === 'approve') saves.push(body);
            if (match[2] === 'request-changes') feedback.push(body);
            const result =
              match[2] === 'request-changes'
                ? await host.service.requestChanges(match[1], body, host.actor)
                : match[2] === 'approve'
                  ? await host.service.approve(match[1], body, host.actor)
                  : match[2] === 'preview'
                    ? await host.service.preview(match[1], body, host.actor)
                    : await host.service.review(
                        match[1],
                        'planning',
                        host.actor,
                        Number(url.searchParams.get('afterSequence') ?? 0),
                        url.searchParams.has('beforeSequence')
                          ? Number(url.searchParams.get('beforeSequence'))
                          : undefined,
                      );
            return route.fulfill({ json: result });
          } catch (error) {
            return route.fulfill({
              status: 503,
              json: { code: 'unavailable', error: String(error) },
            });
          }
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
        await page.emulateMedia({
          reducedMotion: 'reduce',
          colorScheme: theme as 'dark' | 'light',
        });
        await page.goto('/');
        if (theme === 'light') await page.addStyleTag({ content: 'html { font-size: 125%; }' });
        await page.getByRole('button', { name: 'Retry source review' }).click();
        const save = page.getByRole('button', { name: 'Create outcome' });
        await expect(save).toBeEnabled();
        await expect(page.getByRole('region', { name: 'Reviewed source' })).toContainText(
          'Later discussion that was not selected.',
        );
        await expect(page.getByRole('checkbox').first()).not.toBeVisible();
        expect(saves).toEqual([]);
        expect(host.counts().canonicalCreates).toBe(0);
        const bounds = await save.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (flow === 'revision') {
          await page.getByRole('button', { name: 'Request changes' }).click();
          const input = page.getByRole('textbox', { name: 'What should change?' });
          await expect(input).toBeFocused();
          await input.fill('Focus on mobile first and test recovery.');
          const send = page.getByRole('button', { name: 'Send changes' });
          const sendBounds = await send.boundingBox();
          expect(sendBounds!.height).toBeGreaterThanOrEqual(44);
          expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(844);
          await page.screenshot({
            path: info.outputPath(`reviewed-context-telos-outcome-feedback-${theme}.png`),
          });
          await send.click();
          await expect(
            page.getByText('Changes sent. Waiting for a revised proposal.'),
          ).toBeVisible();
          await host.settled();
          expect(feedback).toHaveLength(1);
          expect(JSON.parse(host.denialMessage()!)).toMatchObject({
            feedback: 'Focus on mobile first and test recovery.',
            originalOutcome: { summary: 'Studio acoustic treatment' },
          });
          expect(saves).toEqual([]);
          expect(host.counts().canonicalCreates).toBe(0);
          const revised = await host.request({
            kind: 'create',
            marker: 'native',
            summary: 'Mobile creation first',
          });
          expect(revised.permId).not.toBe(permission.permId);
          await page.evaluate(
            (detail) => window.dispatchEvent(new CustomEvent('fixture-proposal', { detail })),
            revised,
          );
          await expect(page.getByText('New outcome · Mobile creation first')).toBeVisible();
          await expect(save).toBeEnabled();
        }
        await page.screenshot({
          path: info.outputPath(`reviewed-context-telos-outcome-create-${theme}.png`),
        });
        await save.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByText('Reviewed source saved.', { exact: false })).toBeVisible();
        await host.settled();
        expect(saves).toHaveLength(1);
        expect(saves[0]).toMatchObject({ selection: { messageIds: ['after'], artifacts: [] } });
        expect(host.counts().canonicalCreates).toBe(1);
        await expect(page.getByRole('link', { name: 'Open saved item' })).toHaveAttribute(
          'href',
          '/todos/created-1',
        );
        await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep my draft');
        expect(errors).toEqual([]);
      } finally {
        globalThis.fetch = originalFetch;
        host.close();
      }
    });
