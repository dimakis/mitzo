import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { navigateWithServiceHealth } from '../support/service-health-navigation';
import { waitForNewFixtureReads } from '../support/fixture-reads';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  TelosSourcePermissionPreview,
  TelosSourcePermissionReceipt,
  TelosSourcePermissionReview,
} from '@mitzo/protocol';
import type { createTelosSourceApprovalData } from '../fixtures/telos-source-approval-data';

test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-source-approval.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-source-approval.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
  },
});

// Load the offline host and bundle before the timed UI journey. Keep Node-side
// network blocked between setup and each scenario as well as inside the cases.
let restoreSetupFetch: (() => void) | undefined;
test.beforeAll(async () => {
  delete process.env.NTFY_TOPIC;
  delete process.env.PUSHOVER_API_TOKEN;
  delete process.env.PUSHOVER_USER_KEY;
  const originalFetch = globalThis.fetch;
  const externalFetches: string[] = [];
  globalThis.fetch = async (input) => {
    externalFetches.push(String(input));
    throw Error('Offline source fixture forbids Node-side network');
  };
  restoreSetupFetch = () => {
    globalThis.fetch = originalFetch;
    expect(externalFetches).toEqual([]);
  };
  await compiled;
  await import('../fixtures/telos-source-approval-data');
  await import('../../server/telos-source-approval');
});
test.afterAll(() => restoreSetupFetch?.());

for (const theme of ['dark', 'light'] as const)
  for (const responseLoss of ['source', 'canonical'] as const)
    test(`normal chat reviews exact Telos source, creates/adopts and recovers ${responseLoss} response loss (${theme})`, async ({
      page,
    }, info) => {
      // Clear notification configuration before importing the actual harness.
      // Node-side traffic is also blocked: browser interception cannot fence it.
      delete process.env.NTFY_TOPIC;
      delete process.env.PUSHOVER_API_TOKEN;
      delete process.env.PUSHOVER_USER_KEY;
      const originalFetch = globalThis.fetch;
      const externalFetches: string[] = [];
      globalThis.fetch = async (input) => {
        externalFetches.push(String(input));
        throw Error('Offline source fixture forbids Node-side network');
      };
      let data: ReturnType<typeof createTelosSourceApprovalData> | undefined;
      try {
        const { createTelosSourceApprovalData: createData } =
          await import('../fixtures/telos-source-approval-data');
        const { TelosSourceSaveUncertainError } =
          await import('../../server/telos-source-approval');
        data = createData();
        const host = data;
        const files = (await compiled).outputFiles;
        const errors: string[] = [],
          unexpected: string[] = [];
        const previews: TelosSourcePermissionPreview[] = [],
          receipts: TelosSourcePermissionReceipt[] = [];
        const approvalRequests: unknown[] = [];
        const reviews: TelosSourcePermissionReview[] = [];
        let recoveryReadUnavailable = false;
        let materialReadUnavailable = false;
        const account = {
          id: 'offline-account',
          label: 'Offline fixture account',
          models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['high'] }],
        };
        const metadata = {
          sessionType: 'chat',
          accountBinding: {
            accountId: account.id,
            accountLabel: account.label,
            model: 'luna-fixture',
          },
          modelSelection: {
            model: 'luna-fixture',
            reasoningEffort: 'high',
            models: account.models,
          },
          branch: 'offline/source-review',
          numTurns: host.messages.length,
        };
        page.on('pageerror', (error) => errors.push(error.message));
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.setViewportSize({
          width: info.project.name.startsWith('mobile') ? 320 : 1280,
          height: 900,
        });
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
        const deliver = async () => {
          const events = host.drainEvents();
          if (events.length)
            await page.evaluate(
              (value) =>
                window.dispatchEvent(new CustomEvent('fixture-host-events', { detail: value })),
              events,
            );
        };
        await page.route('**/*', async (route) => {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname;
          if (url.origin !== 'https://mitzo-ui.test') {
            unexpected.push(url.origin);
            return route.abort();
          }
          if (path === '/fixture.js' || path === '/fixture.css')
            return route.fulfill({
              contentType: path.endsWith('.js') ? 'application/javascript' : 'text/css',
              body: files.find((file) => file.path.endsWith(path.endsWith('.js') ? '.js' : '.css'))!
                .text,
            });
          if (path.endsWith('.png') || path.endsWith('.svg'))
            return route.fulfill({
              body: await readFile(resolve('frontend/public', path.slice(1))),
              contentType: path.endsWith('.png') ? 'image/png' : 'image/svg+xml',
            });
          if (path === '/fixture/approval/request') {
            await host.request(request.postDataJSON());
            return route.fulfill({ json: { events: host.drainEvents() } });
          }
          if (path === '/fixture/approval/respond') {
            await host.respond(request.postDataJSON());
            return route.fulfill({ json: { events: host.drainEvents() } });
          }
          if (path === '/fixture/approval/reconnect') {
            return route.fulfill({
              json: {
                events: [
                  ...host.drainEvents(),
                  {
                    type: 'session_switched',
                    sessionId: 'planning',
                    pendingPermissions: host.pendingRequests(),
                  },
                ],
              },
            });
          }
          const permission = path.match(
            /^\/api\/telos\/work\/source\/permissions\/([^/]+)(?:\/(preview|approve|materials))?$/,
          );
          if (permission) {
            try {
              const permId = decodeURIComponent(permission[1]);
              const operation = permission[2];
              if (operation === 'approve') approvalRequests.push(request.postDataJSON());
              if (!operation && recoveryReadUnavailable) {
                return route.fulfill({
                  status: 503,
                  json: { code: 'unavailable', error: 'Offline fixture interrupts recovery reads' },
                });
              }
              if (operation === 'materials' && materialReadUnavailable) {
                return route.fulfill({
                  status: 503,
                  json: {
                    code: 'unavailable',
                    error: 'Offline fixture interrupts material metadata reads',
                  },
                });
              }
              const result =
                operation === 'preview'
                  ? await host.service.preview(permId, request.postDataJSON(), host.actor)
                  : operation === 'approve'
                    ? await host.service.approve(permId, request.postDataJSON(), host.actor)
                    : operation === 'materials'
                      ? await host.service.materials(
                          permId,
                          {
                            sessionId: url.searchParams.get('sessionId')!,
                            toolUseId: url.searchParams.get('toolUseId')!,
                            proposalSha256: url.searchParams.get('proposalSha256')!,
                            ...(url.searchParams.has('after')
                              ? { after: JSON.parse(url.searchParams.get('after')!) }
                              : {}),
                          },
                          host.actor,
                        )
                      : await host.service.review(
                          permId,
                          url.searchParams.get('sessionId')!,
                          host.actor,
                          Number(url.searchParams.get('afterSequence') ?? 0),
                        );
              if (operation === 'preview') previews.push(result as TelosSourcePermissionPreview);
              if (!operation) reviews.push(result as TelosSourcePermissionReview);
              if (operation === 'approve') {
                receipts.push(result as TelosSourcePermissionReceipt);
                await host.settled();
              }
              await route.fulfill({ json: result });
              if (operation === 'approve') await deliver();
            } catch (error) {
              const code =
                error instanceof TelosSourceSaveUncertainError
                  ? 'save_uncertain'
                  : error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'unavailable';
              await route.fulfill({
                status: code === 'conflict' ? 409 : code === 'unauthorized' ? 403 : 503,
                json: {
                  code,
                  error: error instanceof Error ? error.message : 'Source review unavailable',
                },
              });
            }
            return;
          }
          if (path === '/api/telos/work/links')
            return route.fulfill({
              json: host.work.forConversation(request.postDataJSON(), host.actor),
            });
          expect(request.method()).toBe('GET');
          if (path === '/api/telos/work/collection')
            return route.fulfill({ json: host.work.readCollection('active', host.actor) });
          if (path === '/api/todos') return route.fulfill({ json: host.todos() });
          const source = path.match(/^\/api\/telos\/work\/items\/([^/]+)\/sources\/([^/]+)$/);
          if (source)
            return route.fulfill({
              json: host.service.capture.read(
                decodeURIComponent(source[1]),
                decodeURIComponent(source[2]),
                host.actor,
              ),
            });
          const record = path.match(/^\/api\/telos\/work\/items\/([^/]+)\/record$/);
          if (record)
            return route.fulfill({
              json: host.work.readRecord(decodeURIComponent(record[1]), host.actor),
            });
          const work = path.match(/^\/api\/telos\/work\/items\/([^/]+)$/);
          if (work)
            return route.fulfill({ json: host.work.read(decodeURIComponent(work[1]), host.actor) });
          const outputs = path.match(/^\/api\/telos\/items\/([^/]+)\/artifacts$/);
          if (outputs)
            return route.fulfill({
              json: {
                artifacts: host.artifacts
                  .list({ itemId: decodeURIComponent(outputs[1]) })
                  .filter((artifact) => artifact.sourceKind !== 'source_capture'),
                limit: 100,
              },
            });
          if (path === '/api/sessions/planning/messages')
            return route.fulfill({
              json: { messages: host.messages, current: null, currents: [], cursor: 3 },
            });
          if (path === '/api/sessions/planning/meta') return route.fulfill({ json: metadata });
          if (path === '/api/sessions/planning/symposium/status')
            return route.fulfill({
              json: { sessionId: 'planning', config: null, seats: [], deliveries: [] },
            });
          if (path === '/api/accounts') return route.fulfill({ json: [account] });
          if (path === '/api/sessions')
            return route.fulfill({
              json: {
                sessions: [
                  {
                    id: 'planning',
                    summary: 'Studio planning',
                    lastModified: 1792144800000,
                    isActive: false,
                  },
                ],
                hasMore: false,
              },
            });
          if (
            [
              '/api/home/briefing-chats',
              '/api/skills',
              '/api/symposium/profile-proposals',
            ].includes(path)
          )
            return route.fulfill({ json: [] });
          if (path === '/api/home/preferences')
            return route.fulfill({
              json: {
                revision: 0,
                names: { briefing: 'Briefing', terminal: 'Terminal' },
                pins: [],
              },
            });
          if (path === '/api/agent-library')
            return route.fulfill({ json: { drafts: [], versions: [] } });
          if (path === '/api/sessions/planning/compactions')
            return route.fulfill({ json: { records: [], truncated: false } });
          if (path === '/api/chat/runtime/capabilities')
            return route.fulfill({ status: 503, json: { code: 'entry_disabled' } });
          if (path === '/api/chat/web-search-consent/planning')
            return route.fulfill({
              json: { ok: true, grant: 'denied', revision: 1, updatedAt: 1792144800000 },
            });
          if (path === '/api/service-health')
            return route.fulfill({ json: { services: [], checkedAt: 1792144800000 } });
          if (['/api/config', '/api/version'].includes(path)) return route.fulfill({ json: {} });
          if (path.startsWith('/api/')) {
            unexpected.push(path);
            return route.fulfill({
              status: 404,
              json: { error: 'Unavailable offline fixture endpoint' },
            });
          }
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
          });
        });

        // Own timers from document startup so the later deadline jump also fires polling.
        await page.clock.install();
        await navigateWithServiceHealth(page, () => page.goto('/chat/planning'));
        const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
        await input.fill('Keep this ordinary chat draft.');
        const request = async (
          kind: 'create' | 'adopt',
          marker: 'native' | 'sdk',
          itemId?: string,
        ) => {
          await page.evaluate(
            (detail) => window.dispatchEvent(new CustomEvent('fixture-request-source', { detail })),
            { kind, marker, itemId },
          );
          const card = page.getByRole('region', { name: 'Approval required', exact: true });
          await expect(
            card.getByRole('checkbox', { name: /Use the approved acoustic plan/ }),
          ).toBeVisible();
          await expect(
            card.getByRole('button', { name: 'Allow for session', exact: true }),
          ).toHaveCount(0);
          await expect(
            card.getByRole('heading', { name: 'Save to Telos', exact: true }),
          ).toBeVisible();
          await expect(card.getByRole('heading', { name: /mcp__/ })).toHaveCount(0);
          const sourceDetails = card
            .locator('details')
            .filter({ has: page.locator('summary', { hasText: /^Source details$/ }) })
            .last();
          await expect(sourceDetails).not.toHaveAttribute('open', '');
          await expect(card.getByText(/Seat unknown · generation unknown/)).toHaveCount(0);
          await expect(
            card.getByRole('button', { name: 'Allow Once', exact: true }),
          ).toBeDisabled();
          expect(
            await card
              .getByRole('checkbox')
              .evaluateAll((checkboxes) =>
                checkboxes.every((checkbox) => !(checkbox as HTMLInputElement).checked),
              ),
          ).toBe(true);
          const choices = await card.locator('.telos-source-choice').evaluateAll((labels) =>
            labels.map((label) => ({
              width: label.getBoundingClientRect().width,
              height: label.getBoundingClientRect().height,
              checkbox: label.querySelector('input')!.getBoundingClientRect().width,
              text: label.querySelector(':scope > span')!.getBoundingClientRect().width,
              fits: label.scrollWidth <= label.clientWidth,
            })),
          );
          for (const choice of choices) {
            expect(
              choice.text,
              'source choice must keep readable text beside its checkbox',
            ).toBeGreaterThanOrEqual(choice.width / 2);
            expect(choice.checkbox, 'checkbox must not consume the source label').toBeLessThan(
              choice.width / 4,
            );
            expect(choice.height).toBeGreaterThanOrEqual(44);
            expect(choice.fits).toBe(true);
          }
          expect(
            await card
              .locator('.telos-source-choices')
              .evaluateAll((fieldsets) =>
                fieldsets.every((fieldset) => fieldset.scrollWidth <= fieldset.clientWidth),
              ),
          ).toBe(true);
          for (const name of ['Allow Once', 'Deny']) {
            const action = card.getByRole('button', { name, exact: true });
            await expect(action).toBeInViewport();
            expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          }
          return card;
        };
        const card = await request('create', 'sdk');
        await expect(
          card.getByText('New outcome · Studio acoustic treatment', { exact: true }),
        ).toBeVisible();
        await expect(
          card
            .getByRole('region', { name: 'Outcome brief', exact: true })
            .getByText('Record clearly', { exact: true }),
        ).toHaveCount(1);
        for (const label of ['Outcome', 'Why this matters', 'Done when', 'Milestones'])
          await expect(card.getByRole('heading', { name: label, exact: true })).toBeVisible();
        await expect(
          card.getByRole('heading', { name: 'Save to Telos', exact: true }),
        ).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`source-approval-brief-${theme}.png`) });
        await card.getByRole('checkbox', { name: /Use the approved acoustic plan/ }).check();
        await card.getByRole('checkbox', { name: /Acoustic plan.*revision 1/ }).check();
        await card.getByRole('button', { name: 'Review selected source', exact: true }).click();
        await expect(
          card.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toBeVisible();
        expect(
          previews[0].preview.packet.context.messages.map((message) => message.messageId),
        ).toEqual(['approved']);
        expect(previews[0].preview.packet.context.boundary.messageId).toBe('approved');
        expect(previews[0].preview.packet.context.artifacts[0]).toMatchObject({
          artifactId: host.material.id,
          revision: 1,
          sha256: host.material.sha256,
        });
        host.advanceMaterial();
        expect(
          await card
            .locator('.perm-banner-info')
            .evaluate((body) => body.scrollWidth <= body.clientWidth),
        ).toBe(true);
        await card
          .getByRole('checkbox', { name: /Use the approved acoustic plan/ })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`source-approval-choice-${theme}.png`) });
        await card
          .getByRole('region', { name: 'Reviewed source', exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`source-approval-create-${theme}.png`) });
        await card.getByRole('button', { name: 'Allow Once', exact: true }).click();
        await expect(card).toHaveCount(0);
        expect(receipts).toHaveLength(1);
        const created = receipts[0].receipt.work.itemId;
        expect(host.toolResult()?.isError).toBe(false);
        expect(JSON.parse(host.toolResult()!.content)).toMatchObject({
          id: created,
          path: '/todos/' + created,
          sourceSnapshotId: receipts[0].sourceSnapshotId,
        });
        expect(
          host
            .receiptSource(receipts[0])
            .packet.context.messages.map((message) => message.messageId),
        ).toEqual(['approved']);
        expect(host.receiptSource(receipts[0]).packet.context.artifacts[0].revision).toBe(1);
        expect(host.work.read(created, host.actor).assignments).toEqual([]);
        await expect(input).toHaveValue('Keep this ordinary chat draft.');

        await page.getByRole('button', { name: 'Open session tray' }).click();
        const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
        await resources
          .getByRole('link', { name: 'Studio acoustic treatment', exact: true })
          .click();
        await expect(page).toHaveURL(new RegExp('/todos/' + created + '$'));
        await page.getByRole('button', { name: 'Open original chat', exact: true }).click();
        await expect(page.locator('[data-telos-source-anchor="true"]')).toContainText(
          'Use the approved acoustic plan.',
        );
        await expect(
          page.getByText('Later discussion that was not selected.', { exact: true }),
        ).toBeAttached();
        await expect(input).toHaveValue('Keep this ordinary chat draft.');

        const adoption = await request('adopt', 'native', created);
        await expect(
          adoption.getByText('Add source to existing item · ' + created, { exact: true }),
        ).toBeVisible();
        await adoption
          .getByRole('checkbox', { name: /Earlier discussion that was not selected/ })
          .check();
        await adoption.getByRole('button', { name: 'Review selected source', exact: true }).click();
        await expect(
          adoption.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toBeVisible();
        await adoption
          .getByRole('region', { name: 'Reviewed source', exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`source-approval-adopt-${theme}.png`) });
        await adoption.getByRole('button', { name: 'Allow Once', exact: true }).click();
        await expect(adoption).toHaveCount(0);
        expect(receipts).toHaveLength(2);
        expect(receipts[1].receipt.work.itemId).toBe(created);
        expect(JSON.parse(host.toolResult()!.content)).toMatchObject({
          id: created,
          path: '/todos/' + created,
          sourceSnapshotId: receipts[1].sourceSnapshotId,
        });
        expect(receipts[1].sourceSnapshotId).not.toBe(receipts[0].sourceSnapshotId);
        expect(
          host
            .receiptSource(receipts[1])
            .packet.context.messages.map((message) => message.messageId),
        ).toEqual(['before']);
        const savedCount = host.counts().sources.total;

        const denied = await request('create', 'native');
        await denied.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(denied).toHaveCount(0);
        expect(host.counts().sources.total).toBe(savedCount);
        expect(host.counts().canonicalCreates).toBe(1);

        const stale = await request('adopt', 'sdk', created);
        await stale
          .getByRole('checkbox', { name: /Later discussion that was not selected/ })
          .check();
        await stale.getByRole('button', { name: 'Review selected source', exact: true }).click();
        await expect(
          stale.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toBeVisible();
        host.staleItem(created);
        await stale.getByRole('button', { name: 'Allow Once', exact: true }).click();
        const staleError = stale.getByRole('alert');
        await expect(staleError).toContainText('This request changed or is no longer authorized');
        await staleError.scrollIntoViewIfNeeded();
        await expect(staleError).toBeInViewport();
        await expect(stale.getByRole('button', { name: 'Allow Once', exact: true })).toBeDisabled();
        await page.screenshot({ path: info.outputPath(`source-approval-stale-${theme}.png`) });
        expect(host.counts().sources.total).toBe(savedCount);
        await stale.getByRole('button', { name: 'Deny', exact: true }).click();
        await expect(stale).toHaveCount(0);
        await expect(input).toHaveValue('Keep this ordinary chat draft.');
        expect(host.counts()).toMatchObject({
          canonicalCreates: 1,
          denials: 2,
          allocations: 0,
          originSessions: ['planning'],
        });
        expect(
          host.work
            .forConversation({ namespace: 'mitzo', conversationId: 'planning' }, host.actor)
            .map((link) => link.itemId),
        ).toEqual([created]);

        if (responseLoss === 'canonical') {
          // The original live card has not reconnected or become recoveryOnly.
          // Its authenticated save_uncertain response confirms this exact
          // durable attempt; a later authority conflict must retain same-save retry.
          const live = await request('create', 'native');
          await live.getByRole('checkbox', { name: /Use the approved acoustic plan/ }).check();
          await live.getByRole('button', { name: 'Review selected source', exact: true }).click();
          await expect(
            live.getByRole('region', { name: 'Reviewed source', exact: true }),
          ).toBeVisible();
          const livePreview = previews.at(-1)!;
          const livePreviewCount = previews.length;
          const liveReceiptCount = receipts.length;
          host.loseNextCanonicalResponse();
          await live.getByRole('button', { name: 'Allow Once', exact: true }).click();
          await expect(live.getByRole('alert')).toContainText('Save is unconfirmed');
          expect(host.hideOriginalSource()).toBe(true);
          const beforeLiveDenied = host.retainedOwnerCounts();
          await live.getByRole('button', { name: 'Allow Once', exact: true }).click();
          await expect(live.getByRole('alert')).toContainText('same save after access returns');
          await expect(live.getByRole('alert')).not.toContainText(
            /new request|ask again|review a new/i,
          );
          await expect(live.getByRole('button', { name: 'Allow Once', exact: true })).toBeEnabled();
          await expect(live.getByRole('timer')).toHaveCount(1);
          await expect(
            page.getByRole('region', { name: 'Save recovery', exact: true }),
          ).toHaveCount(0);
          expect(host.retainedOwnerCounts()).toEqual(beforeLiveDenied);
          expect(receipts).toHaveLength(liveReceiptCount);
          expect(previews).toHaveLength(livePreviewCount);
          await page.screenshot({
            path: info.outputPath(`source-approval-live-denied-${theme}.png`),
          });
          expect(host.restoreOriginalSourceAccess()).toBe(true);
          await live.getByRole('button', { name: 'Allow Once', exact: true }).click();
          await expect(live).toHaveCount(0);
          expect(receipts).toHaveLength(liveReceiptCount + 1);
          const liveReceipt = receipts.at(-1)!;
          expect(host.receiptSource(liveReceipt).packet).toEqual(livePreview.preview.packet);
          expect(liveReceipt.canonicalCreation).toMatchObject({ created: false });
          expect(host.counts().canonicalCreates).toBe(beforeLiveDenied.canonicalCreates);
          expect(approvalRequests.slice(-3)).toEqual([
            approvalRequests.at(-3),
            approvalRequests.at(-3),
            approvalRequests.at(-3),
          ]);
          expect(previews).toHaveLength(livePreviewCount);
          expect(host.counts().allocations).toBe(0);
          await expect(input).toHaveValue('Keep this ordinary chat draft.');
          await page.screenshot({
            path: info.outputPath(`source-approval-live-restored-${theme}.png`),
          });
        }
        if (responseLoss === 'canonical') {
          const history = host.retainMaterialHistory();
          const materials = await request('create', 'sdk');
          await materials.getByRole('checkbox', { name: /Use the approved acoustic plan/ }).check();
          // Text-only review remains available before material discovery ends.
          await materials
            .getByRole('button', { name: 'Review selected source', exact: true })
            .click();
          await expect(
            materials.getByRole('region', { name: 'Reviewed source', exact: true }),
          ).toBeVisible();
          expect(previews.at(-1)!.preview.packet.context.artifacts).toEqual([]);
          const more = materials.getByRole('button', {
            name: 'Load more retained materials',
            exact: true,
          });
          await more.scrollIntoViewIfNeeded();
          expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          const beforeMaterialRead = host.retainedOwnerCounts();
          const previewCountBeforeMaterialRead = previews.length;
          materialReadUnavailable = true;
          await more.click();
          const readError = materials.getByRole('alert');
          await expect(readError).toContainText('More retained materials are unavailable');
          await expect(more).toBeEnabled();
          await expect(
            materials.getByRole('region', { name: 'Reviewed source', exact: true }),
          ).toBeVisible();
          expect(host.retainedOwnerCounts()).toEqual(beforeMaterialRead);
          expect(previews).toHaveLength(previewCountBeforeMaterialRead);
          await readError.scrollIntoViewIfNeeded();
          await expect(readError).toBeInViewport();
          await page.screenshot({
            path: info.outputPath(`source-material-pages-error-${theme}.png`),
          });
          materialReadUnavailable = false;
          await more.click();
          const older = materials.getByRole('checkbox', {
            name: /Retained material history.*revision 150 /,
          });
          await expect(older).not.toBeChecked();
          await older.check();
          await more.click();
          await expect(more).toHaveCount(0);
          await expect(older).toBeChecked();
          await expect(
            materials.getByRole('checkbox', { name: /Retained material history.*revision 205 / }),
          ).not.toBeChecked();
          await older.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`source-material-pages-choice-${theme}.png`),
          });
          await materials
            .getByRole('button', { name: 'Review selected source', exact: true })
            .click();
          const reviewed = materials.getByRole('region', { name: 'Reviewed source', exact: true });
          await expect(reviewed).toBeVisible();
          const pin = previews.at(-1)!.preview.packet.context.artifacts;
          expect(pin).toHaveLength(1);
          expect(pin[0]).toMatchObject({
            artifactId: history[149].id,
            revision: 150,
            sha256: history[149].sha256,
            contentBase64: Buffer.from('Exact retained material revision 150').toString('base64'),
          });
          expect(host.artifacts.read(history[149].id).revision).toBe(205);
          await reviewed.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`source-material-pages-reviewed-${theme}.png`),
          });
          await materials.getByRole('button', { name: 'Allow Once', exact: true }).click();
          await expect(materials).toHaveCount(0);
          expect(host.receiptSource(receipts.at(-1)!).packet.context.artifacts[0].revision).toBe(
            150,
          );
          expect(host.counts().allocations).toBe(0);
        }
        const beforeLoss = host.counts();
        const receiptsBeforeLoss = receipts.length;

        // Lose either the canonical reply or a completed source-save reply.
        // Then reopen the real stores and replay the actual host recovery object,
        // with the source unavailable and the browser past the old deadline.
        const uncertain = await request('create', 'native');
        await uncertain.getByRole('checkbox', { name: /Use the approved acoustic plan/ }).check();
        await uncertain
          .getByRole('button', { name: 'Review selected source', exact: true })
          .click();
        await expect(
          uncertain.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toBeVisible();
        const prepared = previews.at(-1)!;
        const originalDeadline = reviews.at(-1)!.expiresAt;
        if (responseLoss === 'source') host.loseNextSaveResponse();
        else host.loseNextCanonicalResponse();
        await uncertain.getByRole('button', { name: 'Allow Once', exact: true }).click();
        await expect(uncertain.getByRole('alert')).toContainText('Save is unconfirmed');
        const savedBeforeRestart = host.counts();
        expect(savedBeforeRestart.canonicalCreates).toBe(beforeLoss.canonicalCreates + 1);
        expect(savedBeforeRestart.sources.total).toBe(
          beforeLoss.sources.total + (responseLoss === 'source' ? 1 : 0),
        );
        host.restartOwners();
        expect(host.hideOriginalSource()).toBe(true);
        const replay = host.recoveryRequests();
        expect(replay).toHaveLength(1);
        expect(replay[0]).toMatchObject({ reviewKind: 'telos_source', recoveryOnly: true });
        // Finish the next profile poll before unloading this document. WebKit
        // otherwise reports its intercepted fetch on reload as a pageerror.
        await waitForNewFixtureReads(page, ['/api/symposium/profile-proposals'], () =>
          page.clock.fastForward(121_000),
        );
        expect(await page.evaluate(() => Date.now())).toBeGreaterThan(originalDeadline);
        recoveryReadUnavailable = true;
        const previewCountBeforeRecovery = previews.length;
        await navigateWithServiceHealth(page, () => page.reload());
        const recoveryCard = page.getByRole('region', { name: 'Save recovery', exact: true });
        await expect(recoveryCard.getByRole('alert')).toContainText(
          'The original save is still unconfirmed',
        );
        await expect(recoveryCard.getByRole('alert')).not.toContainText(
          /deny|ask again|new request/i,
        );
        await expect(
          recoveryCard.getByRole('button', { name: 'Dismiss', exact: true }),
        ).toBeEnabled();
        await expect(
          recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }),
        ).toBeDisabled();
        await expect(
          recoveryCard.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toHaveCount(0);
        expect(host.counts().canonicalCreates).toBe(savedBeforeRestart.canonicalCreates);
        recoveryReadUnavailable = false;
        await recoveryCard.getByRole('button', { name: 'Retry recovery', exact: true }).click();
        await expect(
          recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }),
        ).toBeEnabled();
        await expect(
          recoveryCard.getByRole('button', { name: 'Allow Once', exact: true }),
        ).toHaveCount(0);
        await expect(
          recoveryCard.getByRole('button', { name: 'Allow for session', exact: true }),
        ).toHaveCount(0);
        await expect(recoveryCard.getByRole('timer')).toHaveCount(0);
        await expect(
          recoveryCard.getByRole('group', { name: 'Select the agreed exchange' }),
        ).toHaveCount(0);
        await expect(
          recoveryCard.getByRole('group', { name: 'Select retained materials' }),
        ).toHaveCount(0);
        await expect(
          recoveryCard.getByRole('button', { name: 'Review selected source', exact: true }),
        ).toHaveCount(0);
        expect(previews.length).toBe(previewCountBeforeRecovery);
        await expect(
          recoveryCard.getByRole('region', { name: 'Reviewed source', exact: true }),
        ).toContainText('Use the approved acoustic plan.');
        await expect(
          recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }),
        ).toBeInViewport();
        await page.screenshot({ path: info.outputPath(`source-approval-recovery-${theme}.png`) });
        const beforeHiddenRetry = host.retainedOwnerCounts();
        await recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }).click();
        if (responseLoss === 'canonical') {
          // Canonical creation has committed, but this source save is unfinished.
          // Hiding its source cannot grant another creator/artifact/link write.
          await expect(recoveryCard.getByRole('alert')).toContainText('no longer authorized');
          await expect(recoveryCard.getByRole('alert')).not.toContainText(
            /new request|ask again|review a new/i,
          );
          await expect(
            recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }),
          ).toBeEnabled();
          await expect(
            recoveryCard.getByRole('link', { name: 'Open saved item', exact: true }),
          ).toHaveCount(0);
          expect(host.retainedOwnerCounts()).toEqual(beforeHiddenRetry);
          expect(receipts).toHaveLength(receiptsBeforeLoss);
          expect(previews.length).toBe(previewCountBeforeRecovery);
          expect(host.recoveryRequests()).toHaveLength(1);
          await page.screenshot({
            path: info.outputPath(`source-approval-recovery-denied-${theme}.png`),
          });
          expect(host.restoreOriginalSourceAccess()).toBe(true);
          // The existing button retries the same immutable attempt without a
          // reload, new tool request, preview, selection or approval intent.
          await expect(
            recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }),
          ).toBeEnabled();
          await expect(
            recoveryCard.getByRole('region', { name: 'Reviewed source', exact: true }),
          ).toContainText('Use the approved acoustic plan.');
          expect(previews.length).toBe(previewCountBeforeRecovery);
          await page.screenshot({
            path: info.outputPath(`source-approval-recovery-restored-${theme}.png`),
          });
          await recoveryCard.getByRole('button', { name: 'Retry same save', exact: true }).click();
        }
        await expect(
          recoveryCard.getByRole('link', { name: 'Open saved item', exact: true }),
        ).toBeVisible();
        expect(receipts).toHaveLength(receiptsBeforeLoss + 1);
        const recovered = receipts.at(-1)!;
        if (responseLoss === 'canonical')
          expect(approvalRequests.at(-1)).toEqual(approvalRequests.at(-2));
        expect(host.receiptSource(recovered).packet).toEqual(prepared.preview.packet);
        expect(host.receiptSource(recovered).available).toBe(responseLoss === 'canonical');
        expect(host.counts().sources.total).toBe(beforeLoss.sources.total + 1);
        expect(host.counts().canonicalCreates).toBe(savedBeforeRestart.canonicalCreates);
        expect(recovered.canonicalCreation).toMatchObject({
          created: responseLoss === 'source',
          delivery: { state: 'retained' },
        });
        expect(host.counts().allocations).toBe(0);
        expect(host.toolResult()).toBeNull();
        await recoveryCard.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(recoveryCard).toHaveCount(0);
        expect(host.recoveryRequests()).toEqual([]);
        expect(host.counts().sources.total).toBe(beforeLoss.sources.total + 1);
        expect(host.counts().canonicalCreates).toBe(savedBeforeRestart.canonicalCreates);
        expect(host.receiptSource(recovered).packet).toEqual(prepared.preview.packet);
        expect(externalFetches).toEqual([]);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      } finally {
        data?.close();
        globalThis.fetch = originalFetch;
      }
    });
