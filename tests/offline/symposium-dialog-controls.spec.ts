import { expect, test } from '@playwright/test';
import { build, type OutputFile } from 'esbuild';
import { resolve } from 'node:path';
import { chatStorageBootstrap } from '../support/chat-storage-bootstrap';
import { sharedConversationView } from '../fixtures/symposium-shared-conversation-data';

let files: OutputFile[];
test.beforeAll(async () => {
  files = (
    await build({
      entryPoints: [resolve('tests/fixtures/symposium-composer.tsx')],
      plugins: [chatStorageBootstrap()],
      bundle: true,
      write: false,
      outfile: '/tmp/symposium-dialog-controls.js',
      jsx: 'automatic',
      minify: true,
      external: ['/*.png', '/*.svg'],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
      alias: {
        '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
        '@mitzo/client': resolve('packages/client/src/index.ts'),
        '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
      },
    })
  ).outputFiles!;
});

// Real shared-conversation and compact-settings composition, intercepted external
// boundaries only. This verifies rendering, not live joining or provider dispatch.
for (const theme of ['dark', 'light'])
  test(`Add agent retains its own visible pickers inside chat settings (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    const view = sharedConversationView();
    const account = {
      accountId: 'offline-account',
      provider: 'openai-codex',
      profileRevision: 'r1',
    };
    const models = [{ id: 'offline-model', label: 'Offline model', reasoningEfforts: ['high'] }];
    const errors: string[] = [],
      mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') mutations.push(path);
      if (path === '/api/auth/check')
        return route.fulfill({ json: { ok: true, authSessionId: 'offline-dialog-login' } });
      if (path === '/api/events')
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
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
      if (path === '/api/accounts')
        return route.fulfill({
          json: [{ id: account.accountId, label: 'Offline account', models }],
        });
      if (path === '/api/agent-library')
        return route.fulfill({
          json: {
            drafts: [],
            versions: [
              {
                profileId: 'reviewer',
                revision: 1,
                definition: {
                  name: 'Reviewer',
                  descriptor: 'Independent review',
                  role: 'agent',
                  instructions: 'Review the plan.',
                  expectedOutput: 'Findings',
                  acceptanceCriteria: ['Evidence'],
                  modelPolicyRole: 'agent',
                },
              },
            ],
          },
        });
      if (path === '/api/chat/runtime/capabilities')
        return route.fulfill({
          json: {
            version: 1,
            authority: 'configuration-only',
            defaultLocation: 'openshell',
            capabilityRevision: 'r1',
            accounts: [
              {
                account,
                label: 'Offline account',
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
                harness: 'codex',
              },
            ],
            routes: [
              {
                account,
                targetId: 'local-mac',
                location: 'local',
                harness: 'codex',
                modes: ['agent'],
                models,
              },
            ],
            locations: [{ location: 'local', status: 'configured' }],
            agentProfiles: [],
          },
        });
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
      if (path.startsWith('/api/')) return route.fulfill({ json: [] });
      const file = files.find((f) => path.endsWith(f.path.endsWith('.css') ? '.css' : '.js'));
      if (file)
        return route.fulfill({
          body: file.text,
          contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        });
      if (path !== '/') return route.abort();
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-theme="${theme}" data-accent="${theme === 'dark' ? 'mint' : 'teal'}" data-font="${theme === 'dark' ? 'georgia' : 'system'}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
    await page.goto('/');
    const opener = page.getByRole('button', { name: /^Agents, / });
    await opener.click();
    await page.getByRole('button', { name: 'Add agent', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add agent', exact: true });
    await dialog.getByRole('textbox', { name: 'Name in this chat' }).fill('Bob');
    await dialog.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Review the plan.');
    await dialog.getByRole('button', { name: /^Agent,/ }).click();
    const reviewer = dialog.getByRole('button', {
      name: 'Reviewer · Independent review · r1',
      exact: true,
    });
    await reviewer.click();
    await expect(reviewer).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.getByRole('button', { name: /^Account, Offline account$/ }).click();
    await dialog.getByRole('button', { name: 'Offline account', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.getByRole('button', { name: /^Model, Offline model$/ }).click();
    await dialog.getByRole('button', { name: 'Offline model', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^Thinking,/ })).toBeVisible();
    await expect(
      dialog.getByText('Choose a repository in Where it runs.', { exact: true }),
    ).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Review joining brief' })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`fresh-setup-fields-${theme}.png`) });
    await dialog.getByRole('button', { name: /^Where it runs,/ }).click();
    await expect(dialog.getByRole('radio', { name: 'Mac host' })).toBeChecked();
    const repositorySection = dialog.getByRole('region', { name: 'Repository for new chat' });
    const expectRepositoryLayout = async () => {
      await expect
        .poll(() => repositorySection.evaluate((el) => el.scrollHeight <= el.clientHeight))
        .toBe(true);
      await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    };
    const addRepository = dialog.getByRole('button', { name: 'Add repository', exact: true });
    await addRepository.scrollIntoViewIfNeeded();
    await expectRepositoryLayout();
    await addRepository.click();
    const repository = dialog.getByLabel('Local repository');
    await expect(repository).toBeVisible();
    await repository.selectOption('local:local/project');
    const prepare = dialog.getByRole('button', { name: 'Use repository', exact: true });
    await expect(prepare).toBeEnabled();
    await prepare.scrollIntoViewIfNeeded();
    await expect(prepare).toBeInViewport({ ratio: 1 });
    await expect(repository).toBeInViewport({ ratio: 1 });
    await expectRepositoryLayout();
    expect(
      await dialog
        .locator('.conversation-agents-body')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`fresh-setup-repository-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add agent', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Name in this chat' })).toHaveValue('Bob');
    await expect(dialog.getByRole('button', { name: /^Agent, Reviewer/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close Agents' }).click();
    await expect(opener).toBeFocused();
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
    await expect(page.getByRole('textbox', { name: 'Source setting' })).toHaveValue(
      'Original chat',
    );
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
