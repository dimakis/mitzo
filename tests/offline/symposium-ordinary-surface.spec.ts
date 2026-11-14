import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import {
  sharedConversationView,
  sharedReply,
} from '../fixtures/symposium-shared-conversation-data';

// Production ordinary composition; only auth/HTTP/external membership boundaries
// are deterministic fixtures. Actual application admission is slice 3's matrix.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-ordinary-surface.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-ordinary-surface.js',
  jsx: 'automatic',
  minify: true,
  external: [
    '/mitzo-wordmark.png',
    '/openshell-mark.svg',
    '/github-mark.svg',
    '/openai-mark.svg',
    '/claude-mark.svg',
  ],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});

for (const theme of ['dark', 'light'])
  test(`ordinary shared surface keeps one history and composer (${theme})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const files = (await bundle).outputFiles!;
    const view = sharedConversationView();
    view.messages = [];
    view.participantSessionIds = ['architect'];
    view.policies = view.policies
      .slice(0, 1)
      .map((policy) => ({ ...policy, readsFutureDiscussion: false, repliesByDefault: false }));
    let sends = 0;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/fixture/join') {
        view.participantSessionIds = ['architect', 'reviewer'];
        view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
        view.membershipRevision++;
        view.policies = sharedConversationView()
          .policies.slice(0, 2)
          .map((policy) => ({
            ...policy,
            membershipRevision: view.membershipRevision,
            readsFutureDiscussion: false,
            repliesByDefault: false,
          }));
        view.messages = [sharedReply];
        return route.fulfill({ json: {} });
      }
      if (path.includes('/source-setup'))
        return route.fulfill({
          json: {
            state: 'selected',
            sourceConversationId: 'architect',
            collaboration: {
              version: 1,
              collaborationId: view.collaborationId,
              revision: view.membershipRevision,
              participantSessionIds: view.participantSessionIds,
            },
          },
        });
      if (path.endsWith('/conversation')) return route.fulfill({ json: view });
      if (path.endsWith('/progress'))
        return route.fulfill({
          json: {
            collaborationId: view.collaborationId,
            membershipRevision: view.membershipRevision,
            replies: [],
            refusals: [],
          },
        });
      if (path.includes('/recipients/'))
        return route.fulfill({
          json: {
            collaborationId: view.collaborationId,
            sessionId: path.split('/').at(-1),
            membershipRevision: view.membershipRevision,
            policySequence: view.policySequence,
            ready: true,
            reason: null,
          },
        });
      if (path.endsWith('/symposium/status')) {
        // Retain a qualification gap on resize, without replacing the input.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return route.fulfill({ json: { sessionId: 'architect', config: null, seats: [] } });
      }
      if (path.endsWith('/messages')) {
        sends++;
        return route.fulfill({ status: 503, json: { error: 'Original request needs checking' } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    const wheel = page.getByRole('button', { name: 'Token usage', exact: true });
    const mic = page.getByRole('button', { name: 'Record voice message' });
    for (const control of [wheel, mic]) {
      await expect(control).toBeVisible();
      await control.evaluate((node) => {
        (node as HTMLElement).dataset.retained = 'original';
      });
    }
    await expect(input).toHaveValue('Ordinary unsent draft');
    await input.fill('Draft retained through joining and resizing');
    await input.evaluate((node) => {
      (node as HTMLElement).dataset.retained = 'original';
    });
    await page.getByRole('button', { name: 'Join reviewer externally' }).click();
    await expect(page.getByRole('button', { name: 'Choose who replies' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose who replies' })).toHaveText('');
    await expect(wheel).toHaveAttribute('title', 'Token usage — Architect');
    await wheel.click();
    await expect(page.locator('.token-bar-detail-row').filter({ hasText: 'Agent' })).toHaveText(
      'AgentArchitect',
    );
    await page.keyboard.press('Escape');
    await expect(input).toHaveAttribute('data-retained', 'original');
    await expect(page.locator('.chat-messages')).toHaveCount(1);
    await expect(page.getByText('Ordinary history before joining')).toHaveCount(1);
    await expect(page.getByText(sharedReply.text)).toHaveCount(1);
    for (const width of [320, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(input).toHaveAttribute('data-retained', 'original');
      await expect(input).toHaveValue('Draft retained through joining and resizing');
      for (const control of [wheel, mic]) {
        await expect(control).toBeVisible();
        await expect(control).toHaveAttribute('data-retained', 'original');
      }
      await expect(page.locator('.chat-messages')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toBeVisible();
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      const heading = page.locator('.workspace-controls-heading');
      await heading.screenshot({
        path: info.outputPath(`ordinary-header-large-${width}-${theme}.png`),
      });
      const names = heading.locator('.conversation-participant-names');
      expect((await names.boundingBox())!.width).toBeGreaterThanOrEqual(64);
      for (const action of await heading.getByRole('button').all()) {
        const bounds = (await action.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      await expect(input).toBeInViewport();
      await expect(input).toHaveAttribute('data-retained', 'original');
      await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
    }
    await page.getByRole('button', { name: 'Toggle source running' }).click();
    await expect(input).toHaveAttribute('data-retained', 'original');
    await expect(wheel).toHaveAttribute('data-retained', 'original');
    await expect(mic).toHaveAttribute('data-retained', 'original');
    await expect(page.getByRole('button', { name: 'Choose who replies' })).toBeVisible();
    await page.getByRole('button', { name: 'Choose who replies' }).click();
    await page.getByRole('checkbox', { name: 'Architect', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Done choosing replies' }).click();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`ordinary-${theme}.png`), fullPage: true });
    expect(sends).toBe(0);
    expect(errors).toEqual([]);
  });
