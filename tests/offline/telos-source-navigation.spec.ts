import { expect, test } from '@playwright/test';
import { openChatSetting, settingRow, settingsHome } from '../support/chat-settings';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { telosSourceBrowserData } from '../fixtures/telos-source-data';
test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-source-navigation.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-source.js',
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
const sourceCases = (['dark', 'light'] as const).flatMap((theme) =>
  (['ready', 'unavailable', 'historical-activity'] as const).map((sourceStatus) => ({
    theme,
    sourceStatus,
  })),
);
for (const { theme, sourceStatus } of sourceCases)
  test(`retained source ${sourceStatus === 'ready' ? 'anchors visible assistant text and returns to its item' : sourceStatus === 'unavailable' ? 'failure releases ordinary restore, send and stream following' : 'historical blank public text preserves activity and ordinary following'} (${theme})`, async ({
    page,
  }, info) => {
    const data = await telosSourceBrowserData({
      assistantBoundary: true,
      historicalBlankActivity: sourceStatus === 'historical-activity',
    });
    const files = (await compiled).outputFiles;
    const errors: string[] = [];
    const transcripts: string[] = [];
    const unexpected: string[] = [];
    let sourceReads = 0;
    let releaseSourceFailure!: () => void;
    const sourceFailureBarrier = new Promise<void>((resolve) => {
      releaseSourceFailure = resolve;
    });
    const account = {
      id: 'offline-source-account',
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
      modelSelection: { model: 'luna-fixture', reasoningEffort: 'high', models: account.models },
      branch: 'offline/studio-planning',
      numTurns: data.messages.length,
    };
    page.on('pageerror', (e) => errors.push(e.message));
    const mobile = info.project.name.startsWith('mobile');
    await page.setViewportSize({ width: mobile ? 320 : 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mitzo-ui.test') return route.abort();
      const path = url.pathname;
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
      if (path === '/api/telos/work/links') {
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: 'planning',
        });
        return route.fulfill({ json: [{ ...data.work.links[0], itemId: 'studio' }] });
      }
      expect(route.request().method()).toBe('GET');
      if (path === '/api/telos/work/items/studio/record')
        return route.fulfill({ json: data.record });
      if (path === '/api/telos/work/items/studio') return route.fulfill({ json: data.work });
      if (path === '/api/telos/work/items/studio/sources/' + data.source.snapshot.snapshotId) {
        // The item opener first verifies the target; fail the later chat-owned read.
        if (++sourceReads === 1 || sourceStatus !== 'unavailable')
          return route.fulfill({ json: data.source });
        await sourceFailureBarrier;
        return route.fulfill({ status: 503, json: { error: 'Retained source unavailable' } });
      }
      if (path === '/api/telos/items/studio/artifacts')
        return route.fulfill({ json: { artifacts: data.outputs, limit: 100 } });
      if (path === '/api/todos')
        return route.fulfill({
          json: {
            items: [
              {
                id: 'studio',
                summary: 'Home studio',
                children: [],
                profile: 'personal',
                status: 'active',
                starred: false,
                urgency: 0,
                ageDays: 0,
                parentId: null,
                childCount: 0,
                completedChildCount: 0,
                sources: [],
                goalId: null,
                intent: 'Record clearly',
                rationale: 'Make music',
                acceptanceCriteria: ['Ready'],
                contextHints: {
                  repos: [],
                  paths: [],
                  issues: [],
                  docIds: [],
                  people: [],
                  jiraKeys: [],
                  keywords: [],
                  taskHint: '',
                },
              },
            ],
            profiles: ['personal'],
          },
        });
      if (path === '/api/sessions/planning/messages') {
        expect(url.searchParams.get('transcript')).toBe('1');
        transcripts.push(path);
        return route.fulfill({
          json: { messages: data.messages, current: null, currents: [], cursor: data.cursor },
        });
      }
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
      if (path === '/api/home/briefing-chats' || path === '/api/skills')
        return route.fulfill({ json: [] });
      if (path === '/api/home/preferences')
        return route.fulfill({
          json: { revision: 0, names: { briefing: 'Briefing', terminal: 'Terminal' }, pins: [] },
        });
      if (path === '/api/symposium/profile-proposals') return route.fulfill({ json: [] });
      if (path === '/api/chat/web-search-consent/planning')
        return route.fulfill({
          json: { ok: true, grant: 'denied', revision: 1, updatedAt: 1792144800000 },
        });
      if (path === '/api/agent-library')
        return route.fulfill({ json: { drafts: [], versions: [] } });
      if (path === '/api/sessions/planning/compactions')
        return route.fulfill({ json: { records: [], truncated: false } });
      if (path === '/api/chat/runtime/capabilities')
        return route.fulfill({ status: 503, json: { code: 'entry_disabled' } });
      if (path === '/api/service-health')
        return route.fulfill({ json: { services: [], checkedAt: 1792144800000 } });
      if (['/api/config', '/api/version'].includes(path)) return route.fulfill({ json: {} });
      if (path.startsWith('/api/')) {
        unexpected.push(path);
        return route.fulfill({
          status: 404,
          json: { error: 'Unavailable in offline source fixture' },
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'blue' : 'mint'}" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}.chat-page{min-height:0}.workspace-work{padding:var(--page-gutter)}.todo-detail-source-content>span{display:block}</style><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.goto('/todos/studio');
    await expect(page.getByText('0 saved files')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`telos-item-sources-${theme}.png`) });
    await page.getByRole('button', { name: 'Open original chat' }).click();
    await expect(page).toHaveURL(new RegExp('/chat/planning\\?telosItem=studio&telosSource='));
    if (sourceStatus !== 'ready') {
      if (sourceStatus === 'unavailable')
        await expect(page.getByText('Opening original exchange…', { exact: true })).toBeVisible();
      await expect(page.getByText('Studio discussion 60:', { exact: false })).toBeAttached();
      const scroll = page.locator('.chat-messages');
      if (sourceStatus === 'unavailable') {
        releaseSourceFailure();
        await expect(
          page.getByText('Original exchange unavailable', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText('Use the approved acoustic plan.', { exact: true }),
        ).toBeAttached();
      } else {
        // This is a retained pre-fix packet, not a new capture admitted by the
        // corrected guard. The real reader verifies its exact bytes and links.
        expect(data.source.packet.version).toBe(1);
        expect(
          data.source.packet.context.messages[0].blocks.every((block) => !block.content.trim()),
        ).toBe(true);
        await expect(page.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /Activity:.*Read/ })).toBeAttached();
      }
      await expect(page.locator('[data-telos-source-anchor="true"]')).toHaveCount(0);
      const distanceFromBottom = () =>
        scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      await expect.poll(distanceFromBottom).toBeLessThan(3);
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll'));
      });
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-stream-reply')));
      await expect(
        page.getByText('Later reply from the offline transport.', { exact: true }),
      ).toBeAttached();
      expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-finish-reply')));
      await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll'));
      });
      await page
        .getByRole('textbox', { name: 'Message Mitzo' })
        .fill('Continue the ordinary chat.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.fixtureSends.length)).toBe(1);
      expect(await page.evaluate(() => window.fixtureSends[0])).toMatchObject({
        type: 'send',
        sessionId: 'planning',
        prompt: 'Continue the ordinary chat.',
      });
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-stream-reply')));
      const heightBefore = await scroll.evaluate((el) => el.scrollHeight);
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('fixture-continue-reply', {
            detail: '\n\nFollowing the ordinary reply after source failure. '.repeat(200),
          }),
        ),
      );
      await expect
        .poll(() => scroll.evaluate((el) => el.scrollHeight))
        .toBeGreaterThan(heightBefore);
      await expect.poll(distanceFromBottom).toBeLessThan(3);
      if (sourceStatus === 'historical-activity')
        await expect(page.getByRole('button', { name: /Activity:.*Read/ })).toBeAttached();
      await expect(page).toHaveURL(new RegExp('/chat/planning\\?telosItem=studio&telosSource='));
      await page.screenshot({
        path: info.outputPath(`telos-source-${sourceStatus}-following-${theme}.png`),
      });
      expect(transcripts).toHaveLength(1);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
      return;
    }
    const anchor = page.locator('[data-telos-source-anchor="true"]');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toContainText('Use the approved acoustic plan.');
    await expect(anchor).toBeInViewport();
    await expect(page.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
    await expect(page.getByText('Studio discussion 60:', { exact: false })).toBeAttached();
    expect(transcripts).toHaveLength(1);
    const scroll = page.locator('.chat-messages');
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const input = page.getByRole('textbox', { name: 'Message Mitzo' });
    await input.fill('Keep my draft');
    await page.getByRole('button', { name: /Workspace controls, Settings/ }).click();
    const settings = page.getByRole('region', { name: 'Agent settings', exact: true });
    await expect(settingRow(settings, 'Account')).toContainText(account.label);
    await openChatSetting(page, 'account');
    await expect(settings.locator('.chat-account-binding')).toHaveText(account.label);
    await openChatSetting(page, 'model');
    await expect(settings.locator('[data-setting-value="luna-fixture"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settingsHome(page);
    await expect(settingRow(settings, 'Model')).toHaveAttribute('data-value', 'luna-fixture');
    await expect(settingRow(settings, 'Thinking')).toHaveAttribute('data-value', 'high');
    await openChatSetting(page, 'thinking');
    await expect(settings.locator('[data-setting-value="high"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await settingsHome(page);
    await page.screenshot({ path: info.outputPath(`telos-source-settings-${theme}.png`) });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(input).toHaveValue('Keep my draft');
    await page.getByRole('button', { name: 'Open session tray' }).click();
    const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
    await expect(resources.getByRole('link', { name: 'Home studio', exact: true })).toBeVisible();
    await resources.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(input).toHaveValue('Keep my draft');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-stream-reply')));
    await expect(
      page.getByText('Later reply from the offline transport.', { exact: true }),
    ).toBeAttached();
    await expect(anchor).toBeInViewport();
    await expect(input).toHaveValue('Keep my draft');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-finish-reply')));
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();

    const height = await page.locator('.telos-chat-context').boundingBox();
    expect(height!.height).toBeLessThan(90);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`telos-source-${theme}.png`) });
    await page.getByRole('link', { name: 'Home studio', exact: true }).click();
    await expect(page).toHaveURL(/\/todos\/studio$/);
    await expect(page.getByRole('button', { name: 'Open original chat' })).toBeVisible();
    await page.getByRole('button', { name: 'Open original chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue('Keep my draft');
    await expect(page.locator('[data-telos-source-anchor="true"]')).toBeInViewport();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
