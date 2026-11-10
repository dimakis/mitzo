import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-joining-review.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-joining-review.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: { '@mitzo/protocol': resolve('packages/protocol/src/index.ts') },
});
for (const theme of ['dark', 'light'])
  for (const participant of ['claude', 'api'])
    test(`Symposium participant repository: ${participant} (${theme})`, async ({
      page,
      isMobile,
    }, info) => {
      const files = (await bundle).outputFiles!;
      const account = {
        accountId: participant === 'claude' ? 'offline-claude' : 'offline-api',
        provider: participant === 'claude' ? 'anthropic-claude' : 'openai',
        profileRevision: 'r1',
      };
      const harness = participant === 'claude' ? 'claude-sdk' : 'codex';
      const models = [{ id: 'offline-fixture', label: 'Offline model' }];
      const inventory = {
        version: 1,
        authority: 'configuration-only',
        defaultLocation: 'openshell',
        capabilityRevision: 'r1',
        accounts: [
          {
            account,
            label: 'Selected participant',
            models,
            modelDiscovery: { source: 'configured', stale: false },
          },
        ],
        targets: [
          {
            targetId: 'local-mac',
            targetRevision: 'r1',
            label: 'Local Mac',
            location: 'local',
            harness,
          },
        ],
        routes: [
          { account, targetId: 'local-mac', location: 'local', harness, modes: ['agent'], models },
        ],
        locations: [{ location: 'local', status: 'configured' }],
        agentProfiles: [],
      };
      let preparations = 0;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/check')
          return route.fulfill({ json: { ok: true, authSessionId: 'offline-participant-login' } });
        if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
        if (path === '/api/repository-workspaces/catalog')
          return route.fulfill({
            json: {
              available: true,
              location: 'local',
              repositories: [
                {
                  connectionId: 'local',
                  repositoryId: 'project',
                  repository: 'local/project',
                  label: 'Selected project',
                },
              ],
            },
          });
        if (path === '/api/repository-workspaces/local') {
          const body = route.request().postDataJSON();
          expect(body.ordinaryRuntime).toEqual({
            runOn: 'local',
            runtime: { account, harness, targetId: 'local-mac' },
          });
          preparations++;
          return route.fulfill({
            json: {
              id: body.requestId,
              repository: 'local/project',
              baseBranch: 'main',
              baseOid: 'a'.repeat(40),
              featureBranch: 'mitzo/offline-participant',
              state: 'ready',
              ordinaryRuntime: {
                version: 2,
                account,
                harness: { implementation: harness },
                execution: { location: 'local', targetId: 'local-mac', targetRevision: 'r1' },
              },
            },
          });
        }
        const file = files.find((file) =>
          path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'),
        );
        if (file)
          return route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (path !== '/') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/?state=repository&account=' + participant);
      await page.getByRole('button', { name: 'Add repository' }).click();
      await page.getByLabel('Local repository').selectOption('local:local/project');
      const prepare = page.getByRole('button', { name: 'Use repository' });
      if (isMobile) expect((await prepare.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await prepare.click();
      await expect(page.getByText('Participant repository prepared')).toBeVisible();
      await expect(page.getByText(/worktree starts from latest upstream main/)).toBeVisible();
      expect(preparations).toBe(1);
      expect(errors).toEqual([]);
      expect(
        await page
          .locator('main')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`participant-${participant}-${theme}.png`),
        fullPage: true,
      });
    });
for (const theme of ['dark', 'light']) {
  test(`Symposium joining review: approved frozen context and brief (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await bundle).outputFiles!;
    const errors: string[] = [];
    let renderedLogin = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'mitzo-ui.test' || route.request().method() !== 'GET')
        return route.abort();
      // Each presentation case has its own verified fixture login. Durable
      // same-login reload recovery is exercised by the actual recovery owner tests.
      if (url.pathname === '/api/auth/check')
        return route.fulfill({
          json: { ok: true, authSessionId: `offline-render-${++renderedLogin}` },
        });
      const file = files.find((f) =>
        url.pathname.endsWith(f.path.endsWith('.css') ? '.css' : '.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (url.pathname !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of isMobile ? [320, 390] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { joiningFixture: { reviews: number } }).joiningFixture.reviews,
        ),
      ).toBe(0);
      await page.getByRole('button', { name: 'Review joining brief' }).click();
      const dialog = page.getByRole('dialog', { name: 'Before joining' });
      await expect(dialog.getByText('Context for the fresh agent')).toBeVisible();
      await expect(dialog.getByText('1 message · 1 artifact version')).toBeVisible();
      await dialog.getByText('Review included context').click();
      await expect(dialog.getByText('Saved version 2 · chat-experience-plan.md')).toBeVisible();
      const brief = dialog.getByRole('textbox', {
        name: /Joining brief · sent to every participant/,
      });
      await expect(brief).toHaveValue(/Shared messages and artifacts are source material/);
      const join = dialog.getByRole('button', { name: 'Join conversation', exact: true });
      await expect(join).toBeEnabled();
      expect(
        await dialog
          .locator('.conversation-agents-body')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(join).toBeInViewport();
      await page.screenshot({
        path: info.outputPath(`before-joining-${width}-${theme}.png`),
        style: '[data-fixture-controls] { visibility: hidden; }',
      });
      await brief.fill('Review recovery without changing the saved source versions.');
      await expect(join).toBeEnabled();
      await join.click();
      await expect(dialog.getByText(/Reviewer joining\./)).toBeVisible();
      await expect(brief).toBeDisabled();
      await dialog.getByRole('button', { name: 'Check again' }).click();
      await expect(dialog.getByText(/Reviewer joined\./)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Review joining brief' })).toBeFocused();
    }
    await page.goto('/?state=uncertain');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    const dialog = page.getByRole('dialog', { name: 'Before joining' });
    await dialog.getByRole('button', { name: 'Join conversation' }).click();
    await expect(dialog.getByRole('alert')).toContainText('same request');
    await dialog.getByRole('button', { name: 'Check again' }).click();
    const confirmations = await page.evaluate(
      () =>
        (window as unknown as { joiningFixture: { confirmations: unknown[] } }).joiningFixture
          .confirmations,
    );
    expect(confirmations).toHaveLength(2);
    expect(confirmations[0]).toEqual(confirmations[1]);
    await page.goto('/?state=unmeasured');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    await expect(page.getByRole('status')).toContainText('Context capacity is unavailable');
    await expect(page.getByRole('button', { name: 'Join conversation' })).toBeEnabled();
    await page.getByRole('button', { name: 'Join conversation' }).click();
    await expect(
      page.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/Reviewer joined\./)).toBeVisible();
    await page.goto('/?state=capacity');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    await expect(page.getByRole('button', { name: 'Join conversation' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Choose less context');
    await page.goto('/?state=refreeze-error');
    await page.getByRole('button', { name: 'Review joining brief' }).click();
    await page
      .getByRole('textbox', { name: /Joining brief · sent to every participant/ })
      .fill('Keep this edited brief.');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: /Joining brief · sent to every participant/ }),
    ).toHaveValue('Keep this edited brief.');
    await expect(page.getByRole('button', { name: 'Join conversation' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
