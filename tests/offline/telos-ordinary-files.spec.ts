import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { test, expect, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
test.use({ baseURL: 'https://mitzo-ui.test' });
const compiled = build({
  entryPoints: [resolve('tests/fixtures/telos-ordinary-chat.tsx')],
  plugins: [chatStorageBootstrap()],
  bundle: true,
  write: false,
  outfile: '/tmp/telos-ordinary-files.js',
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
const sourceText = (source: Locator) =>
  source.evaluate((element) =>
    element instanceof HTMLTextAreaElement
      ? element.value
      : Array.from(element.querySelectorAll('.cm-line'), (line) => line.textContent).join('\n'),
  );
for (const theme of ['dark', 'light'] as const)
  test(`ordinary chat files retain scope, edits, conflict recovery and download (${theme})`, async ({
    page,
  }, info) => {
    const files = (await compiled).outputFiles,
      inventory = localInventoryFixture();
    inventory.agentProfiles[0].definition.name = 'People-work helper';
    inventory.agentProfiles[0].contentHash = sha256Hex(
      JSON.stringify(inventory.agentProfiles[0].definition),
    );
    const messageText = 'Recording plan: [Open recording plan](recording-plan.md).';
    const output = {
      outputId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'ordinary-bound',
      title: 'Recording plan output',
      revision: 1,
      kind: 'inline_draft',
      durability: 'reference_registered',
      label: 'In conversation',
      sourceAvailability: 'available',
      source: {
        sessionId: 'ordinary-bound',
        messageId: 'file-reference',
        blockId: 'text',
        messageEndSeq: 3,
        sha256: sha256Hex(messageText),
      },
      provenance: null,
      createdAt: 1792350000000,
    };
    const writes: Record<string, unknown>[] = [],
      reads: string[] = [],
      forbidden: string[] = [],
      errors: string[] = [];
    let content = '# Recording plan\n\nOriginal notes.',
      reserved = false;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.setViewportSize({
      width: info.project.name.startsWith('mobile') ? 320 : 1280,
      height: 900,
    });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
    await page.addInitScript(() => {
      localStorage.setItem('mitzo:transport', 'sse');
      class OfflineEvents extends EventTarget {
        readyState = 1;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor(url: string) {
          super();
          if (url.includes('/api/chat/events'))
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent('welcome', {
                    data: JSON.stringify({ connectionId: 'ordinary-files-sse' }),
                  }),
                ),
              0,
            );
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = OfflineEvents as unknown as typeof EventSource;
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname,
        method = route.request().method();
      if (url.origin !== 'https://mitzo-ui.test') {
        forbidden.push(url.href);
        return route.abort();
      }
      const file = files.find(
        (file) => path === (file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js'),
      );
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (/^\/[a-z0-9-]+\.(png|svg)$/.test(path))
        return route.fulfill({
          body: await readFile(resolve('frontend/public', path.slice(1))),
          contentType: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        });
      if (path === '/api/chat/runtime/capabilities') return route.fulfill({ json: inventory });
      if (path === '/api/sessions/ordinary-bound/meta')
        return route.fulfill({
          json: {
            sessionId: 'ordinary-bound',
            sessionType: 'chat',
            isHidden: false,
            mode: 'agent',
            ordinaryWorkspaceId: '11111111-1111-4111-8111-111111111111',
            runtimeCommandScope: 'conversation',
            runtimeBinding: {
              version: 2,
              account: inventory.accounts[0].account,
              harness: { implementation: 'codex' },
              execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
            },
            agentProfile: inventory.agentProfiles[0],
            accountBinding: {
              ...inventory.accounts[0].account,
              accountLabel: 'Personal ChatGPT',
              model: 'luna-fixture',
            },
            modelSelection: {
              model: 'luna-fixture',
              reasoningEffort: 'low',
              models: inventory.accounts[0].models,
            },
          },
        });
      if (path.startsWith('/api/files')) {
        const session = url.searchParams.get('sessionId');
        if (path === '/api/files/write') {
          const body = route.request().postDataJSON();
          expect(method).toBe('PUT');
          expect(body.sessionId).toBe('ordinary-bound');
          expect(body.path).toBe('/private/ordinary-task/recording-plan.md');
          writes.push(body);
          if (body.expectedContent !== content)
            return route.fulfill({
              status: 409,
              json: { error: 'File changed elsewhere. Your draft is preserved.' },
            });
          content = body.content;
          return route.fulfill({ json: { ok: true } });
        }
        expect(session).toBe('ordinary-bound');
        reads.push(path);
        if (reserved)
          return route.fulfill({
            status: 409,
            json: { error: 'Send the first message before opening conversation files.' },
          });
        if (path === '/api/files/roots')
          return route.fulfill({
            json: [{ label: 'Conversation files', path: '/private/ordinary-task' }],
          });
        if (path === '/api/files/read')
          return route.fulfill({
            json: { path: '/private/ordinary-task/recording-plan.md', content, ext: '.md' },
          });
        if (path === '/api/files/download')
          return route.fulfill({
            body: content,
            contentType: 'text/markdown',
            headers: { 'Content-Disposition': 'attachment; filename="recording-plan.md"' },
          });
        if (path === '/api/files')
          return route.fulfill({
            json: {
              dir: '/private/ordinary-task',
              root: '/private/ordinary-task',
              entries: [{ name: 'recording-plan.md', isDir: false }],
            },
          });
        forbidden.push(path);
        return route.fulfill({ status: 404, json: { error: 'Unknown file route' } });
      }
      if (path.startsWith('/api/git/')) {
        forbidden.push(path);
        return route.fulfill({
          status: 409,
          json: { error: 'No repository belongs to this chat' },
        });
      }
      if (path === '/api/sessions/ordinary-bound/outputs')
        return route.fulfill({ json: { outputs: [output] } });
      if (path === '/api/sessions/ordinary-bound/outputs/' + output.outputId)
        return route.fulfill({ json: { output, content: messageText } });
      if (path.endsWith('/messages'))
        return route.fulfill({
          json: {
            messages: [
              {
                messageId: 'file-reference',
                role: 'assistant',
                blocks: [
                  {
                    blockId: 'text',
                    blockType: 'text',
                    content: messageText,
                  },
                ],
              },
            ],
            current: null,
            currents: [],
          },
        });
      if (path.endsWith('/symposium/status'))
        return route.fulfill({
          json: { sessionId: 'ordinary-bound', config: null, seats: [], deliveries: [] },
        });
      if (path === '/api/chat/suspend') return route.fulfill({ json: { ok: true } });
      if (path === '/api/telos/work/links') {
        expect(method).toBe('POST');
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: 'ordinary-bound',
        });
        return route.fulfill({ json: [] });
      }
      if (path.startsWith('/api/')) {
        if (
          method !== 'GET' &&
          ![
            '/api/chat/switch',
            '/api/chat/unwatch',
            '/api/chat/reconnect',
            '/api/chat/session-event-applied',
            '/api/chat/reconnect-snapshot-applied',
            '/api/chat/probe',
            '/api/telemetry/v1/traces',
          ].includes(path)
        )
          forbidden.push(path);
        const data: Record<string, unknown> = {
          '/api/auth/check': { authenticated: true },
          '/api/config': { quickActions: [], contextBlocks: {} },
          '/api/accounts': [],
          '/api/agent-library': { drafts: [], versions: inventory.agentProfiles },
          '/api/service-health': { services: [], checkedAt: 0 },
          '/api/home/preferences': {
            revision: 1,
            names: { briefing: 'Jeeves', terminal: 'Minion' },
            pins: [],
          },
          '/api/sessions': { sessions: [], hasMore: false },
          '/api/tasks/loop': { state: 'idle' },
          '/api/telos/work/conversations/ordinary-bound': { links: [] },
        };
        return route.fulfill({ json: method === 'GET' ? (data[path] ?? []) : { ok: true } });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'light' ? 'teal' : 'mint'}" data-font="${theme === 'light' ? 'georgia' : 'system'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}html{font-size:${theme === 'light' ? '160%' : '100%'}}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
      });
    });
    await page.goto('/chat/ordinary-bound');
    expect(await page.evaluate(() => innerWidth)).toBe(
      info.project.name.startsWith('mobile') ? 320 : 1280,
    );
    const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
    await expect(composer).toHaveValue('Write the recording plan.');
    await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Recording plan output In conversation · Source available',
        exact: true,
      })
      .click();
    await expect(page.getByRole('dialog')).toContainText(messageText);
    await page.getByRole('button', { name: 'Back to Resources', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('link', { name: 'Open recording plan', exact: true }).click();
    await expect(page).toHaveURL(/\/files\?/);
    expect(new URL(page.url()).searchParams.get('sessionId')).toBe('ordinary-bound');
    await expect(page.getByRole('heading', { name: 'Recording plan', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Document source' });
    await source.fill('# Private recording edits');
    content = '# Updated outside the editor';
    await page.reload();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect.poll(() => sourceText(source)).toBe('# Private recording edits');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.document-editor-status')).toContainText('File changed elsewhere.');
    await expect.poll(() => sourceText(source)).toBe('# Private recording edits');
    await page.getByRole('button', { name: 'Review latest version', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Latest saved version' })).toContainText(
      '# Updated outside the editor',
    );
    await page.getByRole('button', { name: 'Keep my draft for next save', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.document-editor-status')).toContainText('All changes saved');
    expect(writes).toHaveLength(2);
    expect(writes[0].expectedContent).toBe('# Recording plan\n\nOriginal notes.');
    expect(writes[1].expectedContent).toBe('# Updated outside the editor');
    expect(content).toBe('# Private recording edits');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'File options', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download file', exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe('recording-plan.md');
    await page.screenshot({
      path: info.outputPath(`role-ordinary-files-view-${theme}.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/ordinary-bound$/);
    await expect(composer).toHaveValue('Write the recording plan.');
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('fixture-navigate', { detail: '/files?sessionId=ordinary-bound' }),
      ),
    );
    await expect(
      page.getByRole('button', { name: 'recording-plan.md', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Conversation files', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Worktrees', exact: true })).toHaveCount(0);
    await expect(page.locator('.viewer-header-branch')).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath(`role-ordinary-files-roots-${theme}.png`),
      fullPage: true,
    });
    reserved = true;
    await page.reload();
    await expect(
      page.getByText('Send the first message before opening conversation files.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Worktrees', exact: true })).toHaveCount(0);
    expect(reads).toContain('/api/files/download');
    expect(errors).toEqual([]);
    expect(forbidden).toEqual([]);
  });
