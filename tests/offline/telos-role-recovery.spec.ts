import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { offlineRoleReview } from '../support/telos-role-presentation';
import type { TelosWorkRoleSetupInput } from '../../packages/protocol/src/telos-work-api';

// Actual client, hook, setup component and ChatInput; all traffic intercepted.
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-role-recovery.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-role-recovery.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
test.setTimeout(60_000);
for (const theme of ['dark', 'light'])
  test(`durable role rejection preserves the ordinary composer through explicit review and replay (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const files = (await compiled).outputFiles;
    const calls: TelosWorkRoleSetupInput[] = [];
    const errors: string[] = [],
      unexpected: string[] = [];
    let revision = 'a'.repeat(64),
      reviews = 0;
    const retainedReviews = new Map<string, ReturnType<typeof offlineRoleReview>>();
    const wrappers: unknown[] = [];
    const work = () => ({
      itemId: 'item',
      kind: 'outcome',
      parentId: null,
      revision,
      sources: [],
      links: [],
      assignments: [],
      attempts: [],
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = files.find(
        (f) => path === (f.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path === '/api/telos/work/items/item') {
        const value = work();
        return route.fulfill({ json: value });
      }
      if (path === '/api/telos/work/roles/review' || path === '/api/telos/work/roles/context') {
        reviews++;
        const selection = {
          version: 1,
          itemId: 'item',
          role: 'lead',
          brief: {
            revision,
            sha256: 'b'.repeat(64),
            text: JSON.stringify({
              summary: 'Record the first studio session',
              intent: 'Keep the reviewed recording.',
              acceptanceCriteria: ['Retain the recording.'],
            }),
          },
          parentCriteria: [],
          overallGoal: { itemId: 'item', revision, text: 'Make a comfortable recording space.' },
          sources: [],
          artifacts: [],
        };
        if (path.endsWith('/roles/context')) return route.fulfill({ json: selection });
        const reviewed = offlineRoleReview(selection, {
          itemTitle: 'Record the first studio session',
          goalTitle: 'Recording space',
          materials: [],
        });
        retainedReviews.set(reviewed.presentationRef.id, reviewed);
        return route.fulfill({ json: reviewed });
      }
      if (
        path === '/api/telos/work/roles/setup' ||
        path === '/api/telos/work/roles/setup-reviewed'
      ) {
        const body = route.request().postDataJSON();
        const input = (
          path.endsWith('/roles/setup-reviewed') ? body.input : body
        ) as TelosWorkRoleSetupInput;
        if (path.endsWith('/roles/setup-reviewed')) {
          const reviewed = retainedReviews.get(body.presentationRef.id);
          expect(reviewed?.presentationRef).toEqual(body.presentationRef);
          expect(reviewed?.selection).toEqual(input.contextSelection);
          wrappers.push(body);
        }
        calls.push(input);
        if (calls.length === 1) {
          revision = 'e'.repeat(64);
          return route.fulfill({
            status: 409,
            json: {
              code: 'conflict',
              error: 'Work revision conflict',
              recovery: {
                version: 1,
                requestId: input.requestId,
                outcome: 'rejected_before_allocation',
              },
            },
          });
        }
        if (calls.length === 2)
          return route.fulfill({
            status: 503,
            json: { code: 'unavailable', error: 'Offline response lost' },
          });
        const conversation = { namespace: 'mitzo', conversationId: 'fixture-lead' };
        const value = work();
        return route.fulfill({
          json: {
            commandId: 'fixture-receipt',
            actorId: 'operator:offline',
            work: {
              ...value,
              links: [
                {
                  version: 1,
                  linkId: 'lead-link',
                  itemId: 'item',
                  role: 'lead',
                  conversation,
                  linkedAt: null,
                  linkedBy: 'operator:offline',
                  availability: 'available',
                  attemptId: null,
                },
              ],
              assignments: [
                {
                  itemId: 'item',
                  role: 'lead',
                  conversation,
                  revision: 1,
                  assignedAt: null,
                  assignedBy: 'operator:offline',
                },
              ],
            },
          },
        });
      }
      if (path.startsWith('/api/')) {
        unexpected.push(path);
        return route.fulfill({ status: 503, json: { error: 'Unexpected offline endpoint' } });
      }
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'system' : 'georgia'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}${theme === 'light' ? 'html{font-size:160%}' : ''}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const confirm = page.getByRole('button', { name: 'Assign lead & open chat' });
    await composer.fill('Keep this unsent recording plan.');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const review = page.getByRole('button', { name: 'Review updated brief' });
    await expect(review).toBeEnabled();
    await page.reload();
    await expect(review).toBeEnabled();
    await page.waitForLoadState('networkidle');
    expect(reviews).toBe(1);
    expect(calls).toHaveLength(1);
    await expect(composer).toHaveValue('Keep this unsent recording plan.');
    await review.scrollIntoViewIfNeeded();
    await review.focus();
    await expect(review).toBeFocused();
    expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`role-recovery-${theme}.png`) });
    await review.press('Enter');
    await expect(confirm).toBeEnabled();
    expect(reviews).toBe(2);
    expect(calls).toHaveLength(1);
    await confirm.click();
    await expect(page.getByRole('alert')).toHaveText(
      'Setup could not be confirmed. Retry to recover the same request.',
    );
    expect(calls[1].requestId).not.toBe(calls[0].requestId);
    expect(calls[1].expectedRevision).toBe('e'.repeat(64));
    expect(calls[1].settings).toEqual(calls[0].settings);
    await page.reload();
    await confirm.click();
    await expect(
      page.getByRole('status', { name: '', exact: true }).filter({ hasText: 'Bound fixture-lead' }),
    ).toBeVisible();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(wrappers).toHaveLength(3);
    expect(wrappers[2]).toEqual(wrappers[1]);
    expect(reviews).toBe(2);
    await expect(composer).toHaveValue('Keep this unsent recording plan.');
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
