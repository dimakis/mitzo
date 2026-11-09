import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { sharedConversationView } from '../fixtures/symposium-shared-conversation-data';

const bundle = build({
  entryPoints: [resolve('tests/fixtures/ordinary-collaboration-status.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/ordinary-collaboration-status.js',
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
  for (const stage of ['fresh', 'setup', 'view'])
    test(`ordinary collaboration status stays above composer and recovers ${stage} (${theme})`, async ({
      page,
    }, info) => {
      const files = (await bundle).outputFiles!;
      const errors: string[] = [],
        mutations: string[] = [],
        unexpectedCollaborationReads: string[] = [];
      const reads = { setup: 0, view: 0 };
      const base = sharedConversationView();
      const view = {
        ...base,
        participantSessionIds: ['architect'],
        policies: [base.policies[0]],
        messages: [],
        cursor: 0,
      };
      let failed = false;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') mutations.push(path);
        if (path === '/api/session-collaborations/source-setup') {
          reads.setup++;
          if (stage === 'setup' && !failed) {
            failed = true;
            return route.fulfill({
              status: 503,
              json: { code: 'unavailable', error: 'Collaboration read unavailable' },
            });
          }
          return route.fulfill({
            json:
              stage === 'fresh'
                ? { state: 'unstarted', sourceConversationId: 'architect' }
                : {
                    state: 'selected',
                    sourceConversationId: 'architect',
                    collaboration: {
                      version: 1,
                      collaborationId: view.collaborationId,
                      revision: 1,
                      participantSessionIds: view.participantSessionIds,
                    },
                  },
          });
        }
        if (path === `/api/session-collaborations/${view.collaborationId}/conversation`) {
          reads.view++;
          if (stage === 'view' && !failed) {
            failed = true;
            return route.fulfill({
              status: 503,
              json: { code: 'unavailable', error: 'Collaboration read unavailable' },
            });
          }
          return route.fulfill({ json: view });
        }
        if (path.startsWith('/api/session-collaborations/')) {
          unexpectedCollaborationReads.push(path);
          return route.fulfill({ status: 500, json: { error: 'Unexpected collaboration read' } });
        }
        if (path.startsWith('/api/')) return route.fulfill({ json: [] });
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
          body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
        });
      });
      await page.setViewportSize({
        width: info.project.name.startsWith('mobile') ? 390 : 1280,
        height: 844,
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      const input = page.getByRole('textbox', { name: 'Message Mitzo' });
      const rail = page.getByRole('region', { name: 'Conversation status' });
      await expect(rail).toContainText('Ready');
      await input.fill('Keep this ordinary draft');
      await page.getByRole('button', { name: 'Assign ordinary session' }).click();
      await expect.poll(() => reads.setup).toBe(1);
      if (stage !== 'fresh') {
        await expect(rail.getByRole('alert')).toHaveText('Collaboration read unavailable');
        await expect(page.locator('[role="alert"]')).toHaveCount(1);
        const retry = rail.getByRole('button', { name: 'Refresh collaboration' });
        await expect(retry).toBeVisible();
        const errorBox = (await rail.boundingBox())!;
        const inputBox = (await page.locator('.chat-input-row').boundingBox())!;
        expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(inputBox.y);
        await page.screenshot({
          path: info.outputPath(`collaboration-${stage}-${theme}.png`),
          fullPage: true,
        });
        await retry.click();
        await expect(rail).toContainText('Ready');
      }
      await expect(page.getByText('Sign in to verify this conversation.')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Refresh collaboration' })).toHaveCount(0);
      await expect(input).toHaveValue('Keep this ordinary draft');
      await expect(rail).toHaveCount(1);
      // A shorter visual viewport exercises keyboard space without dispatching a prompt.
      await page.setViewportSize({
        width: info.project.name.startsWith('mobile') ? 390 : 1280,
        height: 520,
      });
      await input.focus();
      await expect(input).toBeFocused();
      const statusBox = (await rail.boundingBox())!;
      const composerBox = (await page.locator('.chat-input-row').boundingBox())!;
      expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(composerBox.y);
      expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`ordinary-${stage}-${theme}-keyboard.png`),
        fullPage: true,
      });
      expect(reads).toEqual({
        setup: stage === 'setup' ? 2 : 1,
        view: stage === 'fresh' ? 0 : stage === 'view' ? 2 : 1,
      });
      expect(mutations).toEqual([]);
      expect(unexpectedCollaborationReads).toEqual([]);
      expect(errors).toEqual([]);
    });
