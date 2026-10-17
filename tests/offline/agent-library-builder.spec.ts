import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ordinaryRuntimeInventoryFixture } from '../../frontend/src/test-utils/ordinary-runtime-inventory-fixture';
import { OrdinaryRuntimeFirstCommandSchema } from '../../packages/protocol/src/local-codex-first-command';
import { profileBuilderDefinition } from '../../packages/protocol/src/profile-builder';

test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-library-builder.tsx')],
  bundle: true,
  write: false,
  outfile: '/tmp/agent-library-builder.js',
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
const definition = {
  name: 'Bob',
  descriptor: 'The architect',
  role: 'reviewer',
  instructions: 'Challenge assumptions. Compare viable options.',
  expectedOutput: 'Decision brief',
  acceptanceCriteria: ['Cite evidence'],
  modelPolicyRole: 'reviewer',
};

const preparationId = '11111111-1111-4111-8111-111111111111';
const sessionId = 'builder-session';
const runtimeInventory = {
  ...ordinaryRuntimeInventoryFixture(),
  agentProfiles: [
    ...ordinaryRuntimeInventoryFixture().agentProfiles,
    {
      kind: 'builtin' as const,
      profileId: 'mitzo-profile-builder',
      revision: 1,
      definition: profileBuilderDefinition,
      contentHash: createHash('sha256')
        .update(JSON.stringify(profileBuilderDefinition))
        .digest('hex'),
    },
  ],
};
async function offline(
  page: Page,
  theme: 'light' | 'dark',
  unavailable = false,
  allowDispatch = false,
) {
  const files = (await bundle).outputFiles;
  const unexpected: string[] = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    const clipboard = { text: '' };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboard.text = text;
        },
        readText: async () => clipboard.text,
      },
    });
  });
  const commands: Array<ReturnType<typeof OrdinaryRuntimeFirstCommandSchema.parse>> = [];
  const proposalSaves: Record<string, unknown>[] = [];
  let proposalSaved = false;
  const controlPosts = [
    '/api/chat/switch',
    '/api/chat/reconnect',
    '/api/chat/probe',
    '/api/chat/session-event-applied',
    '/api/chat/reconnect-snapshot-applied',
    '/api/chat/suspend',
  ];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.origin !== 'https://mitzo-ui.test') {
      unexpected.push(url.href);
      return route.abort();
    }
    if (path === '/fixture.js' || path === '/fixture.css')
      return route.fulfill({
        contentType: path.endsWith('.js') ? 'text/javascript' : 'text/css',
        body: files.find((file) => file.path.endsWith(path.endsWith('.js') ? '.js' : '.css'))!.text,
      });
    if (path.endsWith('.png') || path.endsWith('.svg'))
      return route.fulfill({ body: await readFile(resolve('frontend/public', path.slice(1))) });
    if (path.startsWith('/api/')) {
      if (route.request().method() === 'POST' && controlPosts.includes(path))
        return route.fulfill({ json: { ok: true, applied: true } });
      if (allowDispatch && route.request().method() === 'POST') {
        if (path === '/api/symposium/profile-proposals/offline-builder-proposal/save') {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          proposalSaves.push(body);
          if (proposalSaves.length === 1)
            return route.fulfill({
              status: 503,
              json: { error: 'Offline profile save unavailable' },
            });
          proposalSaved = true;
          return route.fulfill({ json: { profileId: body.profileId, revision: 1 } });
        }
        if (path === '/api/repository-workspaces/preview')
          return route.fulfill({
            json: {
              id: preparationId,
              repository: 'owner/repository',
              baseBranch: 'main',
              baseOid: 'a'.repeat(40),
              featureBranch: 'builder-fixture',
              state: 'preview',
            },
          });
        if (path === `/api/repository-workspaces/${preparationId}/prepare`)
          return route.fulfill({
            json: {
              id: preparationId,
              repository: 'owner/repository',
              baseBranch: 'main',
              baseOid: 'a'.repeat(40),
              featureBranch: 'builder-fixture',
              state: 'ready',
            },
          });
        if (path === '/api/chat/runtime/send' || path === '/api/chat/local-codex/send') {
          const command = OrdinaryRuntimeFirstCommandSchema.parse(route.request().postDataJSON());
          commands.push(command);
          expect(route.request().headers()['x-connection-id']).toBe('offline-builder');
          return route.fulfill({
            status: 202,
            json: {
              ok: true,
              clientMsgId: command.clientMsgId,
              sessionId,
              dispatched: true,
              state: 'consumed',
            },
          });
        }
      }
      if (path.endsWith('/advice') || route.request().method() !== 'GET') {
        unexpected.push(`${route.request().method()} ${path}`);
        return route.fulfill({
          status: 405,
          json: { error: 'No inference or writes during setup' },
        });
      }
      if (['/api/chat/runtime/capabilities', '/api/chat/local-codex/capabilities'].includes(path))
        return route.fulfill(
          unavailable
            ? { status: 503, json: { error: 'Offline runtime unavailable' } }
            : { json: runtimeInventory },
        );
      const data: Record<string, unknown> = {
        '/api/repository-workspaces/catalog': {
          available: true,
          repositories: [
            {
              connectionId: 'github',
              repository: 'owner/repository',
              label: 'Offline GitHub fixture',
            },
          ],
        },
        '/api/agent-library': {
          drafts: [],
          versions: [
            {
              profileId: 'bob',
              revision: 3,
              definition,
              contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
            },
          ],
        },
        '/api/agent-library/tools': { tools: [] },
        '/api/agent-tasks': [],
        '/api/accounts': [],
        '/api/terminals/accounts': [],
        '/api/terminals/subscriptions': { enabled: false, accounts: [] },
        '/api/config': { quickActions: [], contextBlocks: {} },
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/service-health': { services: [], checkedAt: 0 },
        '/api/tasks/loop': { state: 'idle' },
        '/api/home/preferences': { revision: 1, names: {}, pins: [] },
        [`/api/sessions/${sessionId}/meta`]: {
          sessionId,
          sessionType: 'chat',
          mode: 'agent',
          runtimeCommandScope: 'first-command-only',
          runtimeBinding: {
            version: 2,
            account: ordinaryRuntimeInventoryFixture().accounts[0].account,
            harness: { implementation: 'codex' },
            execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
          },
          agentProfile: runtimeInventory.agentProfiles.find(
            (profile) => profile.profileId === 'mitzo-profile-builder',
          ),
          repositoryWorkspaceId: preparationId,
          accountBinding: {
            ...ordinaryRuntimeInventoryFixture().accounts[0].account,
            accountLabel: 'Personal ChatGPT',
            model: 'luna-fixture',
          },
          modelSelection: {
            model: 'luna-fixture',
            reasoningEffort: 'high',
            models: ordinaryRuntimeInventoryFixture().accounts[0].models,
          },
        },
        [`/api/sessions/${sessionId}/messages`]: commands.length
          ? [
              {
                messageId: commands[0].clientMsgId,
                role: 'user',
                blocks: [
                  { blockId: 'user-text', blockType: 'text', content: commands[0].payload.text },
                ],
                sourceSnapshots: commands[0].payload.sourceSnapshots,
                timestamp: 1,
              },
            ]
          : [],
        '/api/symposium/profile-proposals':
          allowDispatch && commands.length && !proposalSaved
            ? [
                {
                  proposalId: 'offline-builder-proposal',
                  suggestedProfileId: null,
                  state: 'pending',
                  definition: {
                    ...definition,
                    name: 'Bob refined',
                    instructions: 'Compare options and cite decision evidence.',
                  },
                },
              ]
            : [],
        [`/api/sessions/${sessionId}/symposium/status`]: { sessionId, config: null, seats: [] },
      };
      return route.fulfill({ json: data[path] ?? [] });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html data-theme="${theme}" data-accent="teal" data-font="georgia"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`,
    });
  });
  return { unexpected, errors, commands, proposalSaves };
}

async function openSettings(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return page.getByRole('region', { name: 'Agent settings', exact: true });
}

async function reviewSource(page: Page, name: string, screenshotPath?: string) {
  await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
  const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
  await expect(resources).toBeVisible();
  await resources
    .getByRole('button', { name: new RegExp(`^Agent Library context.*${name}`) })
    .click();
  await expect(resources.getByRole('heading', { name: 'Instructions', exact: true })).toBeVisible();
  await resources
    .getByRole('button', { name: `Copy injected ${name} context`, exact: true })
    .click();
  const snapshot = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as {
    source: Record<string, unknown>;
    definition: typeof definition;
  };
  if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(resources).toBeHidden();
  return snapshot;
}

for (const theme of ['light', 'dark'] as const) {
  test(`Library refinement uses ordinary Builder chat and retains both drafts (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const fixture = await offline(page, theme);
    await page.goto('/agent-library');
    await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
    await page.getByLabel('Agent name').fill('Working Bob');
    await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
    const unsavedInstructions = 'Preserve exact whitespace.\n  Compare two viable options.  ';
    await page
      .getByRole('textbox', { name: 'Behavior and instructions', exact: true })
      .fill(unsavedInstructions);
    await page.getByRole('tab', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Choose specific tools', exact: true }).click();
    await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
    await expect(page).toHaveURL(/\/chat\?/);
    const chatUrl = page.url();
    expect(new URL(chatUrl).searchParams.get('draft')).toBeTruthy();
    await expect(page.getByRole('region', { name: 'Agent advisor', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Ask agent advisor', exact: true })).toHaveCount(
      0,
    );
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await expect(composer).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Agent Library', exact: true })).toBeVisible();
    const snapshot = await reviewSource(
      page,
      'Working Bob',
      info.outputPath(`ordinary-builder-source-${theme}.png`),
    );
    expect(snapshot.definition).toEqual({
      ...definition,
      name: 'Working Bob',
      instructions: unsavedInstructions,
      tools: [],
    });
    expect(snapshot.source).toMatchObject({
      kind: 'draft',
      profileId: 'bob',
      baseRevision: 3,
      draftVersion: null,
      expectedVersion: 0,
    });
    const panel = await openSettings(page);
    await expect(panel.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(
      JSON.stringify(['builtin', 'mitzo-profile-builder', 1]),
    );
    for (const label of ['Account', 'Model', 'Thinking level'])
      await expect(panel.getByRole('combobox', { name: label, exact: true })).toBeVisible();
    await expect(panel.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue('');
    for (const control of await panel.getByRole('combobox').all())
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await panel.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
    await panel.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
    await expect(panel.getByRole('group', { name: 'Run on', exact: true })).toBeVisible();
    await expect(panel.getByText('Runs with Codex', { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-settings-${theme}.png`),
      animations: 'disabled',
    });
    await panel.getByRole('combobox', { name: 'Model', exact: true }).press('Escape');
    await composer.fill('Keep the exact unsaved instructions and improve the acceptance criteria.');
    await composer.focus();
    await expect(composer).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
    await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
    await page.getByRole('tab', { name: 'Instructions', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Behavior and instructions', exact: true }),
    ).toHaveValue(unsavedInstructions);
    await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
    await expect(page).toHaveURL(chatUrl);
    await expect(composer).toHaveValue(
      'Keep the exact unsaved instructions and improve the acceptance criteria.',
    );
    await page.reload();
    await expect(composer).toHaveValue(
      'Keep the exact unsaved instructions and improve the acceptance criteria.',
    );
    await expect(page.getByRole('link', { name: 'Open Agent Library', exact: true })).toBeVisible();
    expect(await reviewSource(page, 'Working Bob')).toEqual(snapshot);
    const restoredSettings = await openSettings(page);
    await expect(
      restoredSettings.getByRole('combobox', { name: 'Account', exact: true }),
    ).toHaveValue('personal');
    await expect(
      restoredSettings.getByRole('combobox', { name: 'Thinking level', exact: true }),
    ).toHaveValue('high');
    await restoredSettings.getByRole('combobox', { name: 'Model', exact: true }).press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test('Library creation keeps normal setup explicit when runtime choices are unavailable', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'light', true);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Create with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await expect(composer).toHaveValue('Help me create an agent.');
  await expect(page.getByRole('link', { name: 'Open Agent Library', exact: true })).toBeVisible();
  const source = await reviewSource(page, 'New agent');
  expect(source.definition.name).toBe('');
  expect(source.source).toMatchObject({ kind: 'draft', baseRevision: 0, draftVersion: null });
  const panel = await openSettings(page);
  await expect(panel.getByRole('alert')).toHaveText(
    'Execution choices are unavailable. Refresh to retry.',
  );
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Ask agent advisor', exact: true })).toHaveCount(
    0,
  );
  await composer.fill('Retain this creation question until I can configure ordinary execution.');
  await page.screenshot({
    path: info.outputPath('ordinary-builder-unavailable.png'),
    animations: 'disabled',
  });
  await page.goBack();
  await expect(page.getByLabel('Agent name')).toHaveValue('');
  await page.goForward();
  await expect(composer).toHaveValue(
    'Retain this creation question until I can configure ordinary execution.',
  );
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Library published refinement pins the selected revision without copying another profile', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'dark');
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const publishedUrl = page.url();
  const source = await reviewSource(page, 'Bob', info.outputPath('ordinary-builder-published.png'));
  expect(source.definition).toEqual(definition);
  expect(source.source).toEqual({
    kind: 'published',
    profileId: 'bob',
    revision: 3,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  });
  await page.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Create with Agent Builder', exact: true }).click();
  await expect(page).not.toHaveURL(publishedUrl);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
    'Help me create an agent.',
  );
  const newSource = await reviewSource(page, 'New agent');
  expect(newSource.definition.name).toBe('');
  expect(newSource.source.kind).toBe('draft');
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Library Builder sends one ordinary command with exact reviewed context and opens its proposal', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'dark', false, true);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByLabel('Agent name').fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const snapshot = await reviewSource(page, 'Working Bob');
  const panel = await openSettings(page);
  await panel.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
  await panel.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
  await panel.getByRole('button', { name: 'Local Mac', exact: true }).click();
  expect(fixture.commands).toEqual([]);
  await panel.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'GitHub repository', exact: true })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare repository', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await composer.fill('Propose clearer acceptance criteria for this exact draft.');
  const currentPanel = await openSettings(page);
  await currentPanel.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  const command = fixture.commands[0];
  expect(command).toMatchObject({
    runOn: 'local',
    repositoryWorkspaceId: preparationId,
    runtime: {
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'routing-r1' },
      harness: 'codex',
      targetId: 'mac',
    },
    selection: {
      agent: { kind: 'builtin', profileId: 'mitzo-profile-builder', revision: 1 },
      model: 'luna-fixture',
      thinking: 'high',
    },
    payload: { text: 'Propose clearer acceptance criteria for this exact draft.' },
  });
  expect(command.payload.sourceSnapshots).toHaveLength(1);
  expect(JSON.parse(command.payload.sourceSnapshots![0].content)).toEqual(snapshot);
  expect(command.payload.sourceSnapshots![0].revision).toBe(
    createHash('sha256').update(command.payload.sourceSnapshots![0].content).digest('hex'),
  );
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  expect(fixture.errors).toEqual([]);
  await expect(
    page.getByText('Propose clearer acceptance criteria for this exact draft.', { exact: true }),
  ).toHaveCount(1);
  const proposal = page.getByRole('complementary', {
    name: 'Reusable profile drafts',
    exact: true,
  });
  await expect(proposal.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Bob refined',
  );
  await expect(proposal).toContainText('Nothing is saved as a profile yet.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.proposalSaves).toEqual([]);
  await proposal
    .getByRole('button', { name: 'Save reusable profile', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('ordinary-builder-proposal.png'),
    animations: 'disabled',
  });
  const save = proposal.getByRole('button', { name: 'Save reusable profile', exact: true });
  await save.click();
  await expect(proposal.getByRole('alert')).toHaveText('Offline profile save unavailable');
  await expect(proposal.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Bob refined',
  );
  await expect(proposal.getByRole('status')).toHaveCount(0);
  await save.click();
  await expect(proposal.getByRole('status')).toContainText(
    'Saved Bob refined to your Agent Library.',
  );
  expect(fixture.proposalSaves).toHaveLength(2);
  expect(fixture.proposalSaves[1]).toEqual(fixture.proposalSaves[0]);
  expect(fixture.proposalSaves[1]).toMatchObject({
    sessionId,
    expectedRevision: 0,
    definition: {
      name: 'Bob refined',
      instructions: 'Compare options and cite decision evidence.',
    },
  });
  await page.screenshot({
    path: info.outputPath('ordinary-builder-saved-proposal.png'),
    animations: 'disabled',
  });
  await proposal.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await expect(
    page.getByText('Propose clearer acceptance criteria for this exact draft.', { exact: true }),
  ).toBeVisible();
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
