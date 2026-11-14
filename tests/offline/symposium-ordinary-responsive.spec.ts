import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';
import {
  sharedConversationView,
  sharedReply,
} from '../fixtures/symposium-shared-conversation-data';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';

// Render the production ResponsiveChatView route with ordinary session metadata.
// Canned HTTP is presentation evidence only; actual authenticated application
// acceptance is tests/integration/symposium-ordinary-acceptance.test.tsx.
const output = build({
  entryPoints: [resolve('tests/fixtures/symposium-ordinary-responsive.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  external: ['/*.png', '/*.svg'],
  write: false,
  outfile: '/tmp/mitzo-ordinary-responsive.js',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/client': resolve('packages/client/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/harness': resolve('packages/harness/src/index.ts'),
  },
});
const approvedPath = 'docs/design/approved/symposium/fresh-agent-review.html';
const approvedSha = '175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc';

for (const theme of ['light', 'dark'] as const)
  test(`ordinary responsive composition and approved reference (${theme})`, async ({
    page,
    context,
  }, info) => {
    const files = (await output).outputFiles!;
    const approved = await readFile(approvedPath);
    expect(createHash('sha256').update(approved).digest('hex')).toBe(approvedSha);
    const buildIdentity = {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      branch:
        execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim() ||
        'detached HEAD',
      build: 'esbuild production bundle',
      bundleSha256: files.map((file) => ({
        path: file.path,
        sha256: createHash('sha256').update(file.contents).digest('hex'),
      })),
      project: info.project.name,
      approvedPath,
      approvedSha,
      route: '/chat/architect',
      plannedViewports: [320, 390, 1280].map((width) => ({ width, height: 844 })),
      theme,
    };
    // Preserve identity even when a geometry assertion prevents the final manifest.
    await info.attach('ordinary-responsive-build', {
      body: JSON.stringify(buildIdentity, null, 2),
      contentType: 'application/json',
    });
    const inventory = multiRuntimeInventoryFixture({ nativeLocalApi: true });
    const account = inventory.accounts[0].account;
    const meta = {
      sessionId: 'architect',
      sessionType: 'chat',
      mode: 'agent',
      repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
      runtimeBinding: {
        version: 2,
        account,
        harness: { implementation: 'codex' },
        execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
      },
      runtimeCommandScope: 'conversation',
      agentProfile: inventory.agentProfiles[0],
      modelSelection: { model: 'luna-fixture', reasoningEffort: 'low' },
    };
    const history = Array.from({ length: 60 }, (_, index) => ({
      messageId: `ordinary-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      timestamp: index,
      blocks: [
        {
          blockId: `text-${index}`,
          blockType: 'text',
          content: `Retained ordinary history ${index}: reviewed design context remains available in this conversation.`,
        },
      ],
    }));
    const view = sharedConversationView();
    view.participantSessionIds = ['architect', 'reviewer'];
    view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
    view.policies = view.policies.slice(0, 2);
    view.messages = [sharedReply];
    const errors: string[] = [];
    const writes: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (url.hostname !== 'mitzo-ui.test') return route.abort();
      if (path.startsWith('/api/') && route.request().method() !== 'GET') {
        // Ordinary view bookkeeping is handled by the existing offline transport.
        writes.push(path);
        return route.fulfill({ json: [] });
      }
      if (path.includes('/source-setup'))
        return route.fulfill({
          json: {
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
      if (path.endsWith('/conversation')) return route.fulfill({ json: view });
      if (path.endsWith('/progress'))
        return route.fulfill({
          json: {
            collaborationId: view.collaborationId,
            membershipRevision: 1,
            replies: [],
            refusals: [],
          },
        });
      if (path.includes('/recipients/'))
        return route.fulfill({
          json: {
            collaborationId: view.collaborationId,
            sessionId: path.split('/').at(-1),
            membershipRevision: 1,
            policySequence: 0,
            ready: true,
            reason: null,
          },
        });
      if (path.endsWith('/symposium/status'))
        return route.fulfill({ json: { sessionId: 'architect', config: null, seats: [] } });
      if (path.endsWith('/meta')) return route.fulfill({ json: meta });
      if (path === '/api/sessions/architect/messages')
        return route.fulfill({
          json: url.searchParams.has('transcript')
            ? { messages: history, current: null, currents: [], cursor: 1 }
            : history,
        });
      if (path.startsWith('/api/')) {
        const fixtures: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true, authSessionId: 'offline-responsive-operator' },
          '/api/chat/runtime/capabilities': inventory,
          '/api/config': { quickActions: [], contextBlocks: {} },
          '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
          '/api/service-health': { services: [], checkedAt: 0 },
          '/api/tasks/loop': { state: 'idle' },
          '/api/version': {
            version: 'offline-render',
            branch: 'fixture',
            hash: 'a'.repeat(40),
            updateAvailable: false,
          },
          '/api/home/preferences': {
            revision: 1,
            names: { briefing: 'Jeeves', terminal: 'Minion' },
            pins: [],
          },
        };
        return route.fulfill({ json: fixtures[path] ?? [] });
      }
      if (/\.(png|svg)$/.test(path)) {
        try {
          return route.fulfill({
            body: await readFile(resolve('frontend/public', path.slice(1))),
            contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          });
        } catch {
          return route.fulfill({ status: 404, body: '' });
        }
      }
      const file = files.find((file) => path.endsWith(file.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="mint" data-font="system"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    const observations: unknown[] = [];
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/chat/architect');
      const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
      await expect(input).toBeVisible();
      await expect(page.locator('.chat-messages')).toHaveCount(1);
      await expect(page.getByText('Retained ordinary history 59:', { exact: false })).toHaveCount(
        1,
      );
      await expect(page.getByText(sharedReply.text, { exact: true })).toHaveCount(1);
      await input.fill('Keyboard draft retained in ordinary responsive chat');
      await input.focus();
      await page.keyboard.press('Tab');
      const keyboardFocus = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
      }));
      expect(keyboardFocus.tag).not.toBe('BODY');
      const agents = page.getByRole('button', { name: /^Agents,/ });
      await agents.click();
      await expect(page.getByRole('dialog', { name: 'Agents', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close Agents', exact: true }).click();
      await expect(agents).toBeFocused();
      await expect(input).toHaveValue('Keyboard draft retained in ordinary responsive chat');
      const geometry = await page.locator('.chat-messages').evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        overflowY: getComputedStyle(node).overflowY,
      }));
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
      expect(['auto', 'scroll']).toContain(geometry.overflowY);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await expect(input).toBeInViewport();
      const normalNameWidth = await agents
        .locator('.conversation-participant-names')
        .evaluate((node) => node.getBoundingClientRect().width);
      await page.screenshot({ path: info.outputPath(`ordinary-responsive-${width}-${theme}.png`) });
      await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
      await expect(input).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`ordinary-responsive-large-${width}-${theme}.png`),
      });
      observations.push({
        width,
        height: 844,
        theme,
        geometry,
        keyboardFocus,
        route: '/chat/architect',
        ordinarySessionType: meta.sessionType,
      });
      const reference = await context.newPage();
      await reference.route('**/*', (route) => route.abort());
      await reference.setViewportSize({ width, height: 844 });
      await reference.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await reference.setContent(approved.toString('utf8'));
      // The artifact declares iOS/Web carousel panels. Its preview host normally
      // selects one; standalone setContent has no carousel host. Select only the
      // declared panel, without changing reference bytes or product styles.
      const approvedVariant = width < 768 ? 'iOS' : 'Web';
      await reference.locator('[data-variant]').evaluateAll((panels, selected) => {
        for (const panel of panels)
          (panel as HTMLElement).hidden = (panel as HTMLElement).dataset.variant !== selected;
      }, approvedVariant);
      // The approved artifact opens Add agent by default. Retain that original
      // state, then use its own Close control to compare the conversation state.
      const approvedProduct = reference.locator(`[data-variant="${approvedVariant}"] .product`);
      await approvedProduct.screenshot({
        path: info.outputPath(`approved-fresh-setup-${width}-${theme}.png`),
      });
      await approvedProduct.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await approvedProduct.screenshot({
        path: info.outputPath(`approved-reference-${width}-${theme}.png`),
      });
      observations.push({
        approvedConversationViewport: { width, height: 844 },
        approvedVariant,
        productBounds: await approvedProduct.boundingBox(),
        sourceBytesUnchanged: true,
      });
      await reference.close();
      // Retain both render artifacts before asserting the approved visible-name
      // contract, so a failure remains an inspectable visual comparison.
      await expect(agents.locator('.conversation-participant-names')).toBeVisible();
      const participantGeometry = await agents.evaluate((button) => {
        const measure = (node: Element) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            className: node.className,
            label: node.getAttribute('aria-label'),
            width: box.width,
            left: box.left,
            right: box.right,
            minWidth: style.minWidth,
            maxWidth: style.maxWidth,
            flex: style.flex,
            gap: style.gap,
            padding: style.padding,
            overflow: style.overflow,
            fontSize: style.fontSize,
          };
        };
        const names = button.querySelector('.conversation-participant-names')!;
        const box = names.getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        const header = button.closest('.workspace-controls');
        return {
          width: box.width,
          left: box.left,
          right: box.right,
          buttonWidth: buttonBox.width,
          text: names.textContent,
          textScale: getComputedStyle(document.documentElement).fontSize,
          ancestors: [names, names.parentElement!, button, button.parentElement!].map(measure),
          actions: [...(header?.querySelectorAll('button,a') ?? [])].map(measure),
          counts: [
            ...button.querySelectorAll(
              '.conversation-participant-count,.conversation-participant-wide-count',
            ),
          ]
            .map(measure)
            .filter((node) => node.width > 0),
        };
      });
      observations.push({ width, theme, normalNameWidth, participantGeometry });
      await writeFile(
        info.outputPath(`ordinary-responsive-checkpoint-${width}.json`),
        JSON.stringify({ ...buildIdentity, observations }, null, 2),
      );
      expect.soft(normalNameWidth).toBeGreaterThanOrEqual(64);
      expect.soft(participantGeometry.width).toBeGreaterThanOrEqual(64);
      expect.soft(participantGeometry.left).toBeGreaterThanOrEqual(0);
      expect.soft(participantGeometry.right).toBeLessThanOrEqual(width);
      for (const count of participantGeometry.counts)
        expect.soft(count.right).toBeLessThanOrEqual(width);
      if (width < 768) {
        await expect
          .soft(page.getByRole('button', { name: 'Links & access', exact: true }))
          .toBeInViewport({ ratio: 1 });
        await expect
          .soft(page.getByRole('button', { name: 'New chat', exact: true }))
          .toBeInViewport({ ratio: 1 });
        await expect
          .soft(page.getByRole('link', { name: 'Back to chats', exact: true }))
          .toBeInViewport({ ratio: 1 });
      }
    }
    expect(writes.filter((path) => path.endsWith('/messages') || path.endsWith('/joins'))).toEqual(
      [],
    );
    expect(errors).toEqual([]);
    const manifest = {
      ...buildIdentity,
      observations,
      boundary:
        'Production ResponsiveChatView + ordinary metadata; deterministic presentation transport, independent real application acceptance required. Paired reference screenshots require visual review; structural checks are not pixel parity.',
    };
    await writeFile(
      info.outputPath('ordinary-responsive-manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
    await info.attach('ordinary-responsive-manifest', {
      body: JSON.stringify(manifest, null, 2),
      contentType: 'application/json',
    });
  });
