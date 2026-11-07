import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import {
  CollaborationMessageInputSchema,
  CollaborationMessageSchema,
} from '../../packages/protocol/src/index';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  settings,
} from '../fixtures/symposium-shared-conversation-data';

// Intercepted presentation only; actual authenticated application acceptance is separate.
const bundle = build({
  entryPoints: [resolve('tests/fixtures/symposium-composer.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/mitzo-symposium-composer.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
  },
});
for (const theme of ['dark', 'light'])
  test(
    'shared composer: readiness, finalized reply and retained refusal (' + theme + ')',
    async ({ page, isMobile }, info) => {
      const files = (await bundle).outputFiles!;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const view = sharedConversationView();
      view.messages = [];
      view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
      let ready = false;
      let sends = 0;
      let original: unknown;
      await page.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/check')
          return route.fulfill({ json: { ok: true, authSessionId: 'offline-composer-login' } });
        if (path.endsWith('/source-setup'))
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
        if (path.includes('/recipients/')) {
          const sessionId = decodeURIComponent(path.split('/').at(-1)!);
          const allowed = ready && sessionId === 'reviewer';
          return route.fulfill({
            json: {
              collaborationId: view.collaborationId,
              sessionId,
              membershipRevision: view.membershipRevision,
              policySequence: view.policySequence,
              ready: allowed,
              reason: allowed ? null : 'Participant paused. Open it before sending.',
            },
          });
        }
        if (path.endsWith('/messages/observe'))
          return route.fulfill({ json: { message: original ?? null } });
        if (path.endsWith('/messages')) {
          const input = CollaborationMessageInputSchema.parse(route.request().postDataJSON());
          sends++;
          expect(input.responders).toEqual({ kind: 'selected', sessionIds: ['reviewer'] });
          original = CollaborationMessageSchema.parse({
            ...sharedPrompt,
            text: input.text,
            responders: ['reviewer'],
            readers: ['reviewer'],
            settings: { reviewer: settings },
            policyRevisions: { reviewer: 0 },
            deliveries: [{ ...sharedPrompt.deliveries[1], status: 'delivered' }],
          });
          view.messages = [
            CollaborationMessageSchema.parse(original),
            CollaborationMessageSchema.parse({
              ...sharedReply,
              author: { sessionId: 'reviewer' },
              text: 'Reviewer answer from the retained command.',
              replyToDeliveryId: sharedPrompt.deliveries[1].deliveryId,
              source: {
                ...sharedReply.source,
                conversationId: 'reviewer',
                commandId: sharedPrompt.deliveries[1].commandId,
              },
            }),
          ];
          return route.fulfill({ json: original });
        }
        const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
        if (file)
          return route.fulfill({
            body: file.text,
            contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
          });
        if (path !== '/') return route.abort();
        return route.fulfill({
          contentType: 'text/html',
          body:
            '<!doctype html><html data-theme="' +
            theme +
            '" data-accent="' +
            (theme === 'dark' ? 'mint' : 'teal') +
            '" data-font="' +
            (theme === 'dark' ? 'system' : 'georgia') +
            '"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>',
        });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      await input.fill('Review this exact discussion.');
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check();
      await expect(
        page.getByText('Participant paused. Open it before sending.').first(),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
      await expect(input).toHaveValue('Review this exact discussion.');
      expect(sends).toBe(0);
      ready = true;
      await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
      const send = page.getByRole('button', { name: 'Send message' });
      await expect(send).toBeEnabled();
      if (isMobile) expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await send.click();
      await expect(page.getByText('Reviewer answer from the retained command.')).toBeVisible();
      await expect(input).toHaveValue('');
      expect(sends).toBe(1);
      await input.fill('Keep this draft while checking another recipient.');
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      await page.getByRole('checkbox', { name: /Reader/ }).check();
      await expect(send).toBeDisabled();
      await expect(input).toHaveValue('Keep this draft while checking another recipient.');
      expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
      expect(errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath('shared-composer-' + theme + '.png'),
        fullPage: true,
      });
    },
  );
