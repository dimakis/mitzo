import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/permission-once-only.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/permission-once-only.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

for (const theme of ['dark', 'light'] as const) {
  test(`once-only permission consumers retain scope, geometry and keyboard behavior (${theme})`, async ({
    page,
    isMobile,
    browserName,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [],
      unexpected: string[] = [],
      sourceReads: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.routeWebSocket('**/*', (socket) => {
      unexpected.push('WebSocket');
      socket.close();
    });
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://mitzo-ui.test') {
        unexpected.push(url.href);
        return route.abort();
      }
      const asset = files.find(
        (file) => url.pathname === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (asset)
        return route.fulfill({
          body: asset.text,
          contentType: asset.path.endsWith('.css') ? 'text/css' : 'application/javascript',
        });
      if (url.pathname.startsWith('/api/telos/work/source/permissions/')) {
        sourceReads.push(url.href);
        if (route.request().method() !== 'GET') {
          unexpected.push('Unexpected source mutation');
          return route.abort();
        }
        return route.fulfill({ status: 503, json: { error: 'Offline source review unavailable' } });
      }
      if (url.pathname !== '/') {
        unexpected.push(url.href);
        return route.abort();
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}" style="font-size:${theme === 'dark' ? 16 : 20}px"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
      });
    });
    const respond = () => page.evaluate(() => window.fixtureResponses);
    for (const view of ['banner', 'notification']) {
      for (const allow of ['false', 'missing', 'true']) {
        await page.goto(`/?view=${view}&allow=${allow}`);
        const panel = page.getByRole('region', {
          name: view === 'banner' ? 'Approval required' : 'Notification details',
          exact: true,
        });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('button')).toHaveCount(allow === 'false' ? 2 : 3);
        await expect(panel.getByRole('button', { name: /session/i })).toHaveCount(
          allow === 'false' ? 0 : 1,
        );
        if (allow === 'false') {
          await expect(
            panel.getByText(
              view === 'banner'
                ? 'Allow once covers the displayed request.'
                : 'Allow once covers this request.',
              { exact: true },
            ),
          ).toBeVisible();
          await expect(
            panel.getByText('Allow for session keeps this approval until the session ends.', {
              exact: true,
            }),
          ).toHaveCount(0);
        } else {
          await expect(
            panel.getByText('Allow for session keeps this approval until the session ends.', {
              exact: true,
            }),
          ).toBeVisible();
        }
        const geometry = await panel
          .getByRole('button')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
        for (const rect of geometry) {
          expect(rect.height).toBeGreaterThanOrEqual(44);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(isMobile ? 320 : 1280);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          isMobile ? 320 : 1280,
        );
        if (view === 'banner' && allow === 'false') {
          expect(Math.abs(geometry[0].width - geometry[1].width)).toBeLessThanOrEqual(1);
          await page.screenshot({ path: info.outputPath('once-only-banner.png'), fullPage: true });
          const scroll = await panel.locator('.perm-banner-info').evaluate((node) => {
            node.scrollTop = node.scrollHeight;
            const input = node.querySelector('pre')!;
            return {
              top: node.scrollTop,
              inputBottom: input.getBoundingClientRect().bottom,
              infoBottom: node.getBoundingClientRect().bottom,
              inputText: input.textContent,
            };
          });
          expect(scroll.top).toBeGreaterThan(0);
          expect(scroll.inputText).toContain('END OF REVIEWED REQUEST');
          expect(scroll.inputBottom).toBeLessThanOrEqual(scroll.infoBottom + 1);
          await expect(
            panel.getByRole('button', { name: 'Allow Once', exact: true }),
          ).toBeInViewport();
          await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeInViewport();
          await page.screenshot({
            path: info.outputPath('once-only-banner-scrolled.png'),
            fullPage: true,
          });
          for (const name of ['Request details', 'Allow Once', 'Deny']) {
            await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
            const focused = await page.evaluate(() => {
              const e = document.activeElement!;
              return {
                name: e.getAttribute('aria-label') ?? e.textContent?.trim(),
                outline: getComputedStyle(e).outlineStyle,
              };
            });
            expect(focused.name).toBe(name);
            expect(focused.outline).not.toBe('none');
          }
          await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
          await expect(
            panel.getByRole('button', { name: 'Allow Once', exact: true }),
          ).toBeFocused();
          await page.keyboard.press('Enter');
          await expect
            .poll(respond)
            .toEqual([['component-permission', 'once', 'PublishReviewedPullRequest']]);
          await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled();
        } else {
          const decision = allow === 'false' ? 'deny' : 'always';
          await panel
            .getByRole('button', {
              name: allow === 'false' ? 'Deny' : 'Allow for session',
              exact: true,
            })
            .click();
          await expect
            .poll(respond)
            .toEqual(
              view === 'banner'
                ? [['component-permission', decision, 'PublishReviewedPullRequest']]
                : [[decision]],
            );
        }
      }
    }
    for (const allow of ['false', 'missing']) {
      await page.goto(`/?view=banner&kind=conversation&allow=${allow}`);
      await expect(
        page.getByRole('button', { name: 'Allow for session', exact: true }),
      ).toHaveCount(allow === 'false' ? 0 : 1);
      await page.getByRole('button', { name: 'Grant to conversation', exact: true }).click();
      await expect
        .poll(respond)
        .toEqual([['component-permission', 'once', 'PublishReviewedPullRequest']]);
    }
    for (const view of ['banner', 'notification']) {
      await page.goto(`/?view=${view}&kind=question&allow=false`);
      await expect(page.getByRole('button', { name: /session/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Send answer', exact: true })).toBeDisabled();
      await page.getByRole('radio', { name: 'Proceed', exact: true }).check();
      await page.getByRole('button', { name: 'Send answer', exact: true }).click();
      const answers = { q1: ['Proceed'] };
      await expect
        .poll(respond)
        .toEqual(
          view === 'banner'
            ? [['component-permission', 'once', 'PublishReviewedPullRequest', answers]]
            : [['once', answers]],
        );
    }
    await page.goto('/?view=banner&kind=source&allow=true');
    await expect(page.getByRole('heading', { name: 'Save to Telos', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: /session/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Allow Once', exact: true })).toBeDisabled();
    expect(sourceReads).toHaveLength(1);
    expect(await respond()).toEqual([]);
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
