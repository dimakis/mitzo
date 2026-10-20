import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const bundle = build({
  entryPoints: [resolve('tests/fixtures/sandboxes.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/sandboxes-fixture.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'] as const)
  test(
    'sandbox controls save, cancel and protect ownership (' + theme + ')',
    async ({ page }, info) => {
      const mobile = info.project.name.startsWith('mobile'),
        width = mobile ? 320 : 1280;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const errors: string[] = [],
        writes: Record<string, unknown>[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(
        ({ theme }) => {
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', theme === 'light' ? 'teal' : 'mint');
          localStorage.setItem('mitzo-font', theme === 'light' ? 'georgia' : 'system');
          document.addEventListener('DOMContentLoaded', () => {
            if (theme === 'light') document.documentElement.style.fontSize = '20px';
            document.body.style.cssText = 'height:100dvh;overflow:hidden';
          });
        },
        { theme },
      );
      const compiled = await bundle;
      let generation = 1,
        failNext = false;
      const makeSpare = () => ({
        id: 'spare-' + generation,
        name: 'mitzo-warm-' + generation++,
        physicalId: 'physical-' + generation,
        state: 'ready',
        resources: { cpu: 2, memoryGiB: 4 },
        failure: null as string | null,
        canRetire: true,
        observedState: 'ready',
        observedAt: Date.now(),
      });
      const state = {
        physicalInventory: {
          available: true,
          total: 122,
          counts: { Ready: 42, Stopped: 74, Error: 6 },
          items: [
            {
              id: 'historical',
              name: 'legacy-sandbox-needing-ownership-review',
              state: 'Stopped',
              management: 'needs_review',
            },
          ],
        },
        revision: 1,
        settings: {
          enabled: true,
          capacity: 1,
          refill: 'auto',
          expiryMinutes: 120,
          cpu: 2,
          memoryGiB: 4,
        },
        resting: false,
        busy: false,
        available: true,
        reason: null,
        capabilities: {
          cpu: true,
          memory: true,
          disk: false,
          diskReason: 'This OpenShell CLI does not expose a disk limit.',
        },
        spares: [makeSpare()],
        conversations: [
          {
            conversationId: 'conversation-one',
            sandboxName: 'retained-conversation-sandbox',
            state: 'retained',
            account: 'Work account',
            title: 'Release planning with a long readable conversation title',
            canReviewCleanup: true,
          },
        ],
      };
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (url.origin !== 'http://mitzo-ui.test') return route.abort();
        if (path === '/api/sandboxes') {
          if (route.request().method() === 'GET') return route.fulfill({ json: state });
          const body = route.request().postDataJSON();
          writes.push(body);
          expect(body.requestId).toBeTruthy();
          if (failNext) {
            failNext = false;
            return route.fulfill({
              status: 409,
              json: { error: 'Settings changed elsewhere. Refresh before retrying.' },
            });
          }
          expect(body.revision).toBe(state.revision);
          state.revision++;
          if (body.action === 'settings') {
            state.settings = body.settings;
            state.spares = state.spares.slice(0, state.settings.capacity);
            if (state.settings.enabled && state.settings.refill === 'auto')
              while (state.spares.length < state.settings.capacity) state.spares.push(makeSpare());
          } else if (body.action === 'replace') {
            state.spares = state.spares.map((x) => (x.id === body.id ? makeSpare() : x));
          } else if (body.action === 'remove') {
            state.spares = state.spares.filter((x) => x.id !== body.id);
            state.settings.enabled = false;
          } else throw Error('Unexpected mutation ' + body.action);
          return route.fulfill({ json: state });
        }
        if (path === '/api/openshell/lifecycle/conversation-one/preview')
          return route.fulfill({
            json: {
              token: 'fixture',
              action: 'none',
              blockers: ['active_session'],
              expiresAt: Date.now() + 60000,
            },
          });
        if (path === '/fixture.js' || path === '/fixture.css')
          return route.fulfill({
            contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css',
            body: compiled.outputFiles!.find((x) =>
              x.path.endsWith(path.endsWith('.js') ? '.js' : '.css'),
            )!.text,
          });
        if (path === '/mitzo-wordmark.png')
          return route.fulfill({
            contentType: 'image/png',
            body: await readFile(resolve('frontend/public/mitzo-wordmark.png')),
          });
        if (path.startsWith('/api/'))
          return route.fulfill({ json: path === '/api/health' ? { status: 'ok' } : {} });
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script type="module" src="/fixture.js"></script></html>',
        });
      });
      await page.goto('/more');
      await page.getByRole('link', { name: 'Sandboxes', exact: true }).click();
      const main = page.locator('.sandboxes-page');
      await expect(main.getByRole('heading', { name: 'Sandboxes', exact: true })).toBeVisible();
      await expect(main.getByText('122 sandboxes on this gateway')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.screenshot({ path: info.outputPath('sandbox-initial-' + theme + '.png') });
      expect(writes).toHaveLength(0);
      await expect(
        page
          .getByRole('navigation', { name: 'Main navigation' })
          .getByRole('link', { name: 'More', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      const capacity = main.getByRole('combobox', { name: 'Warm spares', exact: true });
      await capacity.selectOption('2');
      await main.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(capacity).toHaveValue('1');
      expect(writes).toHaveLength(0);
      await capacity.selectOption('2');
      await main.getByRole('button', { name: 'Save settings', exact: true }).click();
      await expect(main.getByText('2 of 2 spares ready', { exact: true })).toBeVisible();
      expect(writes).toHaveLength(1);
      await main.getByRole('button', { name: 'Resources per sandbox', exact: true }).click();
      await expect(main.getByRole('combobox', { name: 'Disk', exact: true })).toBeDisabled();
      await expect(
        main.getByText('This OpenShell CLI does not expose a disk limit.', { exact: true }),
      ).toBeVisible();
      failNext = true;
      await capacity.selectOption('1');
      await main.getByRole('button', { name: 'Save settings', exact: true }).click();
      await expect(
        main.getByText('Settings changed elsewhere. Refresh before retrying.', { exact: true }),
      ).toBeVisible();
      await expect(capacity).toHaveValue('1');
      expect(writes).toHaveLength(2);
      await main.getByRole('button', { name: 'Cancel', exact: true }).click();
      state.settings.enabled = false;
      state.settings.refill = 'manual';
      state.spares[0].observedState = 'unverified';
      state.spares[0].failure = 'Sandbox uses an older runtime recipe; replace or remove it.';
      state.revision++;
      await main.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(main.getByText('Warming paused', { exact: true })).toBeVisible();
      await main
        .getByRole('region', { name: 'Warm sandbox inventory' })
        .getByRole('button', { name: 'Details', exact: true })
        .first()
        .click();
      const obsoleteDialog = page.getByRole('dialog');
      await expect(
        obsoleteDialog.getByText('Sandbox uses an older runtime recipe; replace or remove it.', {
          exact: true,
        }),
      ).toBeVisible();
      const replace = obsoleteDialog.getByRole('button', { name: 'Replace spare', exact: true });
      await replace.focus();
      await expect(replace).toBeFocused();
      if (!mobile) {
        await page.keyboard.press('Tab');
        await expect(
          obsoleteDialog.getByRole('button', { name: 'Remove spare', exact: true }),
        ).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(
          obsoleteDialog.getByRole('button', { name: 'Recheck ownership', exact: true }),
        ).toBeFocused();
      } else {
        // iOS Safari does not tab through buttons with its default keyboard mode.
        for (const name of ['Remove spare', 'Recheck ownership']) {
          await obsoleteDialog.getByRole('button', { name, exact: true }).focus();
          await expect(obsoleteDialog.getByRole('button', { name, exact: true })).toBeFocused();
        }
      }
      const factOverlaps = await obsoleteDialog
        .locator('.sandbox-facts > div')
        .evaluateAll((rows) =>
          rows.flatMap((row) => {
            const label = row.querySelector('dt')!,
              value = row.querySelector('dd')!;
            const range = document.createRange();
            range.selectNodeContents(label);
            const labelRect = range.getBoundingClientRect(),
              valueRect = value.getBoundingClientRect();
            return labelRect.bottom > valueRect.top &&
              valueRect.bottom > labelRect.top &&
              labelRect.right > valueRect.left
              ? [label.textContent]
              : [];
          }),
        );
      expect(factOverlaps).toEqual([]);
      for (const name of ['Replace spare', 'Remove spare', 'Recheck ownership']) {
        const button = obsoleteDialog.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const rect = (await button.boundingBox())!;
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
      }
      await page.screenshot({ path: info.outputPath('sandbox-obsolete-' + theme + '.png') });
      await replace.click();
      await expect(main.getByText('Spare replaced.', { exact: true })).toBeVisible();
      expect(state.spares).toHaveLength(2);

      await main
        .getByRole('region', { name: 'Warm sandbox inventory' })
        .getByRole('button', { name: 'Details', exact: true })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Unassigned', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Selected at claim', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await main
        .getByRole('region', { name: 'Conversation sandboxes' })
        .getByRole('button', { name: 'Details', exact: true })
        .click();
      await expect(
        dialog.getByText('Cleanup is blocked: active session.', { exact: true }),
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete sandbox', exact: true })).toHaveCount(
        0,
      );
      await expect(
        dialog.getByRole('button', { name: 'Delete sandbox…', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await main
        .getByRole('button', { name: 'Resources per sandbox', exact: true })
        .scrollIntoViewIfNeeded();
      await main.screenshot({ path: info.outputPath('sandbox-settings-' + theme + '.png') });
      const geometry = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      if (mobile) {
        const fields = await main.locator('select,input[role="switch"],button').evaluateAll((xs) =>
          xs
            .filter((x) => x.getBoundingClientRect().width > 0)
            .map((x) => {
              const target = x.matches('input') ? x.closest('label')! : x;
              return {
                name: x.getAttribute('aria-label') || x.textContent,
                h: target.getBoundingClientRect().height,
                w: target.getBoundingClientRect().width,
              };
            }),
        );
        expect(fields.filter((x) => x.h < 44)).toEqual([]);
      }
      await main
        .getByRole('region', { name: 'Warm sandbox inventory' })
        .getByRole('button', { name: 'Details', exact: true })
        .first()
        .click();
      await dialog.getByRole('button', { name: 'Remove spare', exact: true }).click();
      failNext = true;
      await dialog.getByRole('button', { name: 'Remove spare and pause', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText(
        'Settings changed elsewhere. Refresh before retrying.',
      );
      expect(state.spares).toHaveLength(2);
      await dialog.getByRole('button', { name: 'Remove spare and pause', exact: true }).click();
      await expect(main.getByText('Warming paused', { exact: true })).toBeVisible();
      await expect(
        main
          .getByRole('region', { name: 'Conversation sandboxes' })
          .getByText('Release planning with a long readable conversation title', { exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
      expect(writes).toHaveLength(5);
    },
  );
