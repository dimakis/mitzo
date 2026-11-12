import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { readChatStorage } from '../support/persisted-chat-storage';
import {
  CollaborationMessageInputSchema,
  CollaborationMessageSchema,
  CollaborationPromptReviewRequestSchema,
  CollaborationPromptReviewResultSchema,
  CollaborationDurableTranscriptSchema,
} from '../../packages/protocol/src/index';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  settings,
  uuid,
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
    'shared observer survives singleton membership (' + theme + ')',
    async ({ page, isMobile }, info) => {
      const files = (await bundle).outputFiles!;
      const view = sharedConversationView();
      view.messages = [];
      const policies = structuredClone(view.policies);
      let writes = 0;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/') && route.request().method() !== 'GET') writes++;
        if (path === '/api/auth/check')
          return route.fulfill({ json: { ok: true, authSessionId: 'offline-observer-login' } });
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
              sessionId: decodeURIComponent(path.split('/').at(-1)!),
              membershipRevision: view.membershipRevision,
              policySequence: view.policySequence,
              ready: true,
              reason: null,
            },
          });
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
          body: `<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      const picker = page.getByRole('button', { name: 'Choose who replies' });
      await expect(picker).toBeVisible();
      await page.getByRole('textbox', { name: 'Message Mitzo' }).fill('Keep this unsent draft.');
      view.participantSessionIds = ['architect'];
      view.membershipRevision++;
      view.policies = policies.filter((policy) => policy.sessionId === 'architect');
      await expect(picker).toBeHidden({ timeout: 7000 });
      view.participantSessionIds = ['architect', 'reviewer'];
      view.membershipRevision++;
      view.policies = policies.filter((policy) =>
        view.participantSessionIds.includes(policy.sessionId),
      );
      view.messages = [{ ...sharedReply, text: 'Remote reply after rejoining.' }];
      view.cursor = 3;
      await expect(page.getByText('Remote reply after rejoining.')).toBeVisible({ timeout: 7000 });
      await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
        'Keep this unsent draft.',
      );
      expect(writes).toBe(0);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath('singleton-rejoin-' + theme + '.png'),
        fullPage: true,
      });
    },
  );
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
      let reviewCount = 0;
      let attachedSnapshot: { snapshotId: string; sha256: string };
      const sourceText = 'Exact saved design context for this prompt.';
      const artifactText =
        'Frozen résumé — saved version two\n<script>literal reviewed text</script>\n';
      const artifact = {
        artifactId: 'reviewed-artifact',
        revision: 2,
        sha256: createHash('sha256').update(artifactText).digest('hex'),
        sourceConversationId: 'architect',
        mediaType: 'text/plain',
        sizeBytes: Buffer.byteLength(artifactText),
        contentBase64: Buffer.from(artifactText).toString('base64'),
      };
      const source = CollaborationDurableTranscriptSchema.parse({
        sourceConversationId: 'architect',
        boundary: { sequence: 1, messageId: 'selected-source' },
        messages: [
          {
            conversationId: 'architect',
            sequence: 1,
            messageId: 'selected-source',
            author: 'operator',
            source: null,
            blocks: [
              {
                blockId: 'text',
                content: sourceText,
                sha256: createHash('sha256').update(sourceText).digest('hex'),
              },
            ],
          },
        ],
      });
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
        if (path === '/api/sessions/architect/messages' && route.request().method() === 'GET')
          return route.fulfill({ json: source });
        if (path.endsWith('/prompt-reviews')) {
          const input = CollaborationPromptReviewRequestSchema.parse(
            route.request().postDataJSON(),
          );
          reviewCount++;
          const snapshot = {
            version: 1,
            snapshotId: uuid(100 + reviewCount),
            sha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
            sourceConversationId: 'architect',
            boundary: source.boundary,
            mode: input.selection.mode,
            purpose: input.selection.purpose,
            joiningBrief: input.selection.joiningBrief,
            messages: source.messages,
            artifacts: [artifact],
            summary: null,
            capacity: { status: 'unverified', reason: 'Offline capacity is unverified' },
          };
          attachedSnapshot = { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 };
          return route.fulfill({
            json: CollaborationPromptReviewResultSchema.parse({
              snapshot,
              recipientSessionIds: input.recipientSessionIds,
              settings: { reviewer: settings, reader: settings },
              expectedMembershipRevision: input.selection.expectedMembershipRevision,
              expectedPolicySequence: input.expectedPolicySequence,
              requiresReview: false,
              artifactLabels: [
                {
                  artifactId: artifact.artifactId,
                  revision: artifact.revision,
                  sha256: artifact.sha256,
                  title: 'Frozen saved note',
                },
              ],
            }),
          });
        }
        if (path.endsWith('/progress'))
          return route.fulfill({
            json: {
              collaborationId: view.collaborationId,
              membershipRevision: view.membershipRevision,
              replies: [],
              refusals: [],
            },
          });
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
          return route.fulfill({ json: { message: original ?? null, terminal: !!original } });
        if (path.endsWith('/messages')) {
          const input = CollaborationMessageInputSchema.parse(route.request().postDataJSON());
          sends++;
          expect(input.responders).toEqual({ kind: 'selected', sessionIds: ['reviewer'] });
          expect(input.snapshot).toEqual(attachedSnapshot);
          original = CollaborationMessageSchema.parse({
            ...sharedPrompt,
            snapshot: input.snapshot,
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
      await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).click();
      await page.getByRole('button', { name: 'Done choosing replies', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toContainText(
        'Reviewer',
      );
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
      const contextTrigger = page.getByRole('button', { name: 'Review prompt context' });
      await contextTrigger.click();
      const context = page.getByRole('dialog', { name: 'Context for this prompt' });
      await expect(context.getByRole('textbox', { name: 'Purpose' })).toBeEnabled();
      await context.getByRole('textbox', { name: 'Purpose' }).fill('Review this exact source');
      await context.getByRole('checkbox', { name: /Exact saved design context/ }).check();
      await context
        .getByRole('textbox', { name: 'Brief', exact: true })
        .fill('Initial one-prompt brief');
      await context.getByRole('button', { name: 'Review context', exact: true }).click();
      const attach = context.getByRole('button', { name: 'Attach reviewed context' });
      await expect(attach).toBeEnabled();
      await context
        .getByRole('textbox', { name: 'Brief', exact: true })
        .fill('Edited exact one-prompt brief');
      await expect(attach).toBeDisabled();
      await context.getByRole('button', { name: 'Review context', exact: true }).click();
      await expect(attach).toBeEnabled();
      await context.getByText('Review included context', { exact: false }).click();
      const artifactPreview = context.getByLabel('Saved contents, version 2');
      await expect(artifactPreview).toHaveText(artifactText);
      expect(await artifactPreview.textContent()).toBe(artifactText);
      await expect(artifactPreview.locator('script')).toHaveCount(0);
      expect(sends).toBe(0);
      expect(reviewCount).toBe(2);
      expect(await context.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (isMobile) expect((await attach.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({
        path: info.outputPath('prompt-context-review-' + theme + '.png'),
        fullPage: true,
      });
      await page.keyboard.press('Escape');
      await expect(contextTrigger).toBeFocused();
      await contextTrigger.click();
      await expect(attach).toBeEnabled();
      await attach.click();
      await expect(context).not.toBeVisible();
      await expect(
        page.getByText('Reviewed context attached: Review this exact source'),
      ).toBeVisible();
      await expect(send).toBeEnabled();
      if (isMobile) expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await send.click();
      await expect(page.getByText('Reviewer answer from the retained command.')).toBeVisible();
      await expect(input).toHaveValue('');
      expect(sends).toBe(1);
      await expect(page.getByRole('button', { name: 'Remove prompt context' })).toHaveCount(0);
      await input.fill('Keep this draft while checking another recipient.');
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      await page.getByRole('checkbox', { name: /reader/i }).click();
      await expect(page.getByRole('button', { name: 'Choose who replies' })).toContainText(
        'reader',
      );
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

for (const theme of ['dark', 'light'])
  test(
    'shared composer: Defaults preserves independent recipient recovery (' + theme + ')',
    async ({ page, isMobile }, info) => {
      const files = (await bundle).outputFiles!;
      const view = sharedConversationView();
      view.messages = [];
      view.policies.find((policy) => policy.sessionId === 'reviewer')!.repliesByDefault = true;
      view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
      let original: typeof sharedPrompt | undefined;
      let input: ReturnType<typeof CollaborationMessageInputSchema.parse> | undefined;
      let sends = 0;
      let settled = false;
      let stops = 0;
      const observations: unknown[] = [];
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/check')
          return route.fulfill({ json: { ok: true, authSessionId: 'offline-multi-login' } });
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
        if (path.endsWith('/progress'))
          return route.fulfill({
            json: {
              collaborationId: view.collaborationId,
              membershipRevision: view.membershipRevision,
              replies:
                original && !settled
                  ? [
                      {
                        projectionId: uuid(91),
                        sourceMessageId: 'live-reviewer-source',
                        deliveryId: uuid(5),
                        sessionId: 'reviewer',
                        text: 'Reviewer is answering this exact prompt.',
                      },
                    ]
                  : [],
              refusals: [],
            },
          });
        if (path.includes('/recipients/'))
          return route.fulfill({
            json: {
              collaborationId: view.collaborationId,
              sessionId: decodeURIComponent(path.split('/').at(-1)!),
              membershipRevision: view.membershipRevision,
              policySequence: view.policySequence,
              ready: true,
              reason: null,
            },
          });
        if (path.endsWith('/messages/stop')) {
          expect(route.request().postDataJSON()).toEqual(input);
          stops++;
          return route.fulfill({
            json: {
              requestId: input!.requestId,
              recipients: original!.deliveries
                .filter((d) => d.purpose === 'reply')
                .map((d) => ({
                  sessionId: d.sessionId,
                  deliveryId: d.deliveryId,
                  status: d.sessionId === 'architect' ? 'settled' : 'uncertain',
                })),
            },
          });
        }
        if (path.endsWith('/messages/observe')) {
          observations.push(route.request().postDataJSON());
          if (original && settled) {
            original = CollaborationMessageSchema.parse({
              ...original,
              deliveries: original.deliveries.map((delivery) =>
                delivery.sessionId === 'reviewer'
                  ? { ...delivery, outcome: 'failed', revision: 3 }
                  : delivery,
              ),
            });
            view.messages[0] = original;
            view.cursor = 3;
          }
          return route.fulfill({ json: { message: original ?? null, terminal: settled } });
        }
        if (path.endsWith('/messages')) {
          input = CollaborationMessageInputSchema.parse(route.request().postDataJSON());
          expect(input.responders).toEqual({ kind: 'default' });
          sends++;
          original = CollaborationMessageSchema.parse({
            ...sharedPrompt,
            text: input.text,
            deliveries: sharedPrompt.deliveries.map((delivery) =>
              delivery.purpose === 'reply'
                ? {
                    ...delivery,
                    status: 'delivered',
                    outcome: delivery.sessionId === 'architect' ? 'completed' : 'uncertain',
                  }
                : delivery,
            ),
          });
          view.messages = [original, { ...sharedReply, projectionId: uuid(88) }];
          return route.fulfill({ json: original });
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
      const picker = page.getByRole('button', { name: 'Choose who replies' });
      await picker.focus();
      await picker.press('Enter');
      await page.getByRole('button', { name: 'Defaults', exact: true }).click();
      await expect(
        page.getByRole('checkbox', { name: 'Current agent', exact: true }),
      ).toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Reviewer', exact: true })).toBeChecked();
      await page.getByRole('button', { name: 'Done choosing replies' }).click();
      await expect(picker).toBeFocused();
      const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
      await composer.fill('Both agents: review independently.');
      const send = page.getByRole('button', { name: 'Send message' });
      await expect(send).toBeEnabled();
      await send.click();
      await expect(page.getByText(sharedReply.text)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Check original request' })).toBeVisible();
      await expect(page.getByText('Reviewer is answering this exact prompt.')).toBeVisible();
      await expect(page.getByLabel('Message details for Reviewer')).toBeVisible();
      await page.screenshot({
        path: info.outputPath('multiple-responders-live-' + theme + '.png'),
        fullPage: true,
      });
      const stop = page.getByRole('button', { name: 'Stop generation' });
      await expect(stop).toBeVisible();
      if (isMobile) expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await stop.click();
      await expect(page.getByText(/Stop could not be confirmed for every recipient/)).toBeVisible();
      await composer.fill('Keep the next draft while the other agent is uncertain.');
      // Recovery requires a committed next draft and the original uncertain request.
      // Edit-time save initiation alone does not prove IndexedDB committed either.
      await expect
        .poll(() =>
          readChatStorage(
            page,
            (storage, id) => JSON.parse(storage.getItem('mitzo-chat-draft:' + id) ?? 'null'),
            'shared:' + view.collaborationId,
          ),
        )
        .toMatchObject({
          id: 'shared:' + view.collaborationId,
          text: 'Keep the next draft while the other agent is uncertain.',
          collaborationSend: { input, stopRequested: true },
        });
      await page.reload();
      await expect(composer).toHaveValue('Keep the next draft while the other agent is uncertain.');
      await expect(picker).toBeDisabled();
      await expect(page.getByText(/Stop was requested/)).toBeVisible();
      await expect(page.getByText('Reviewer is answering this exact prompt.')).toBeVisible();
      expect(stops).toBe(1);
      await page.getByRole('button', { name: 'Check original request' }).click();
      expect(sends).toBe(1);
      expect(observations).not.toHaveLength(0);
      for (const observation of observations) expect(observation).toEqual(input);
      settled = true;
      await page.getByRole('button', { name: 'Check original request' }).click();
      await expect(picker).toBeEnabled();
      const receipt = page.getByText(/1 recipient needs attention/);
      await expect(receipt).toBeVisible();
      await receipt.click();
      await expect(page.getByText('Reply failed', { exact: true })).toBeVisible();
      await expect(page.getByText('Reply completed', { exact: true })).toBeVisible();
      await expect(page.getByText('Context pending · no response requested')).toBeVisible();
      await expect(page.getByText(sharedReply.text)).toBeVisible();
      await expect(composer).toHaveValue('Keep the next draft while the other agent is uncertain.');
      expect(sends).toBe(1);
      if (isMobile) expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(
        await page
          .locator('main')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: info.outputPath('shared-composer-multi-' + theme + '.png'),
        fullPage: true,
      });
    },
  );
