import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ordinaryRuntimeInventoryFixture } from '../../frontend/src/test-utils/ordinary-runtime-inventory-fixture';
import { OrdinaryRuntimeFirstCommandSchema } from '../../packages/protocol/src/local-codex-first-command';
import {
  PROFILE_BUILDER_REVISION,
  profileBuilderDefinition,
} from '../../packages/protocol/src/profile-builder';
import {
  AgentTaskDefinitionSchema,
  type AgentTaskRecord,
} from '../../packages/protocol/src/agent-tasks';
import { V2SendMessage } from '../../packages/protocol/src/ws-schemas-v2';

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
      revision: PROFILE_BUILDER_REVISION,
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
  taskAuthoring: 'create' | 'edit' | null = null,
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
  const legacyCommands: Array<ReturnType<typeof V2SendMessage.parse>> = [];
  const proposalSaves: Record<string, unknown>[] = [];
  const lifecycle = {
    legacy: false,
    acceptLegacy: false,
    legacyAccepted: 0,
    commandState: 'consumed' as 'reserved' | 'consumed',
    metadata: 'visible' as
      'visible' | 'hidden' | 'unavailable' | 'malformed' | 'not-found' | 'unclassified',
    metadataReads: 0,
  };
  const task = {
    definition: AgentTaskDefinitionSchema.parse({
      name: 'Morning review',
      objective: 'Review the accepted report.',
      profile: {
        profileId: 'bob',
        revision: 3,
        contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      },
      execution: {
        account: {
          accountId: 'task-only-account',
          provider: 'openai-codex',
          profileRevision: 'task-r1',
        },
        harness: 'codex',
        targetId: 'task-only-target',
        model: 'luna-task-fixture',
        reasoningEffort: 'low',
        mode: 'ask',
        authorityRefs: ['reviewed-task-authority'],
      },
      workspace: { workspaceId: 'task-only-workspace', sourceRefs: ['report-r3'] },
      schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Dublin', state: 'paused' },
      notificationPolicy: 'results',
      outputPolicy: 'session',
    }),
    expectedRevision: taskAuthoring === 'edit' ? 3 : 0,
    saves: [] as Record<string, unknown>[],
    saved: null as AgentTaskRecord | null,
    failNext: true,
    revoked: false,
    holdSave: false,
    releaseSave: null as (() => void) | null,
  };
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
        if (path === '/api/chat/send' && lifecycle.legacy) {
          const command = V2SendMessage.strict().parse(route.request().postDataJSON());
          legacyCommands.push(command);
          if (!lifecycle.acceptLegacy)
            return route.fulfill({
              status: 503,
              json: { error: 'Offline receipt unavailable; original command retained' },
            });
          await route.fulfill({
            status: 202,
            json: { accepted: true, clientMsgId: command.clientMsgId, sessionId },
          });
          lifecycle.legacyAccepted++;
          return;
        }
        if (
          taskAuthoring &&
          path === '/api/symposium/profile-proposals/offline-task-proposal/save'
        ) {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          task.saves.push(body);
          if (task.holdSave)
            await new Promise<void>((resolve) => {
              task.releaseSave = resolve;
            });
          if (task.revoked)
            return route.fulfill({
              status: 403,
              json: { error: 'Interactive operator authority was revoked' },
            });
          if (task.failNext) {
            task.failNext = false;
            return route.fulfill({
              status: 503,
              json: { error: 'Offline task owner unavailable' },
            });
          }
          const savedDefinition = AgentTaskDefinitionSchema.parse(body.definition);
          task.saved = {
            taskId: 'morning-review',
            revision: task.expectedRevision + 1,
            definition: savedDefinition,
            configuration:
              savedDefinition.objective.trim() &&
              savedDefinition.execution &&
              savedDefinition.workspace
                ? { state: 'blocked', reason: 'admission-unavailable' }
                : { state: 'draft' },
            deleted: false,
            createdAt: '2026-10-17T10:00:00Z',
            updatedAt: '2026-10-17T10:00:00Z',
          };
          return route.fulfill({ json: task.saved });
        }
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
              dispatched: lifecycle.commandState === 'consumed',
              state: lifecycle.commandState,
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
          lifecycle.legacy
            ? { status: 503, json: { code: 'entry_disabled' } }
            : unavailable
              ? { status: 503, json: { error: 'Offline runtime unavailable' } }
              : { json: runtimeInventory },
        );
      if (path === `/api/sessions/${sessionId}/meta`) {
        lifecycle.metadataReads++;
        if (lifecycle.metadata === 'not-found')
          return route.fulfill({ status: 404, json: { error: 'Conversation not found' } });
        if (lifecycle.metadata === 'unclassified') return route.fulfill({ json: { sessionId } });
        if (lifecycle.metadata === 'unavailable')
          return route.fulfill({
            status: 503,
            json: { error: 'Offline conversation metadata unavailable' },
          });
        if (lifecycle.metadata === 'malformed')
          return route.fulfill({ json: { sessionId: 'unrelated-conversation', isHidden: false } });
      }
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
        '/api/agent-tasks': task.saved ? [task.saved] : [],
        '/api/accounts': lifecycle.legacy
          ? [
              {
                id: 'legacy-account',
                label: 'Offline legacy account',
                models: [
                  { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
                ],
              },
            ]
          : [],
        '/api/terminals/accounts': [],
        '/api/terminals/subscriptions': { enabled: false, accounts: [] },
        '/api/config': { quickActions: [], contextBlocks: {} },
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/service-health': { services: [], checkedAt: 0 },
        '/api/tasks/loop': { state: 'idle' },
        '/api/home/preferences': { revision: 1, names: {}, pins: [] },
        [`/api/sessions/${sessionId}/meta`]: {
          sessionId,
          isHidden: lifecycle.metadata === 'hidden',
          sessionType: 'chat',
          mode: 'agent',
          runtimeCommandScope: taskAuthoring ? 'conversation' : 'first-command-only',
          runtimeBinding: lifecycle.legacy
            ? null
            : {
                version: 2,
                account: ordinaryRuntimeInventoryFixture().accounts[0].account,
                harness: { implementation: 'codex' },
                execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
              },
          agentProfile: runtimeInventory.agentProfiles.find(
            (profile) => profile.profileId === 'mitzo-profile-builder',
          ),
          repositoryWorkspaceId: lifecycle.legacy ? undefined : preparationId,
          accountBinding: {
            ...ordinaryRuntimeInventoryFixture().accounts[0].account,
            accountLabel: 'Personal ChatGPT',
            model: 'luna-fixture',
            ...(lifecycle.legacy
              ? { accountId: 'legacy-account', accountLabel: 'Offline legacy account' }
              : {}),
          },
          modelSelection: {
            model: 'luna-fixture',
            reasoningEffort: 'high',
            models: ordinaryRuntimeInventoryFixture().accounts[0].models,
          },
        },
        [`/api/sessions/${sessionId}/messages`]:
          commands.length || legacyCommands.length
            ? [
                {
                  messageId: (commands[0] ?? legacyCommands[0]).clientMsgId,
                  role: 'user',
                  blocks: [
                    {
                      blockId: 'user-text',
                      blockType: 'text',
                      content: commands[0]?.payload.text ?? legacyCommands[0].prompt,
                    },
                  ],
                  sourceSnapshots:
                    commands[0]?.payload.sourceSnapshots ?? legacyCommands[0].sourceSnapshots,
                  timestamp: 1,
                },
              ]
            : [],
        '/api/symposium/profile-proposals':
          taskAuthoring && commands.length
            ? [
                {
                  kind: 'task',
                  proposalId: 'offline-task-proposal',
                  taskId: 'morning-review',
                  expectedRevision: task.expectedRevision,
                  definition: task.definition,
                  state: task.saved ? 'saved' : 'pending',
                  savedTask: task.saved,
                },
              ]
            : allowDispatch && commands.length && !proposalSaved
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
  return { unexpected, errors, commands, legacyCommands, proposalSaves, lifecycle, task };
}

async function openSettings(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return page.getByRole('region', { name: 'Agent settings', exact: true });
}

async function prepareFirstCommand(page: Page, prompt: string) {
  const panel = await openSettings(page);
  await panel.getByRole('combobox', { name: 'Account', exact: true }).selectOption('personal');
  await panel.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('high');
  await panel.getByRole('button', { name: 'Local Mac', exact: true }).click();
  await panel.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'GitHub repository', exact: true })
    .selectOption('github:owner/repository');
  await page.getByRole('button', { name: 'Preview repository', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Mitzo', exact: true }).fill(prompt);
  const currentPanel = await openSettings(page);
  await currentPanel.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
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
      JSON.stringify(['builtin', 'mitzo-profile-builder', PROFILE_BUILDER_REVISION]),
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
      agent: {
        kind: 'builtin',
        profileId: 'mitzo-profile-builder',
        revision: PROFILE_BUILDER_REVISION,
      },
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

test('Library starts fresh ordinary setup after the assigned conversation is confirmed hidden', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'dark', false, true);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByLabel('Agent name').fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const originalDraft = new URL(page.url()).searchParams.get('draft');
  const source = await reviewSource(page, 'Working Bob');
  await prepareFirstCommand(page, 'Refine the original reviewed profile.');
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await page
    .locator('.telos-chat-context')
    .getByRole('link', { name: 'Open Agent Library', exact: true })
    .click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
  fixture.lifecycle.metadata = 'hidden';
  const readsBefore = fixture.lifecycle.metadataReads;
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  expect(fixture.lifecycle.metadataReads).toBeGreaterThan(readsBefore);
  expect(new URL(page.url()).searchParams.get('draft')).not.toBe(originalDraft);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
    'Help me refine this agent.',
  );
  expect(await reviewSource(page, 'Working Bob')).toEqual(source);
  await page.screenshot({
    path: info.outputPath('ordinary-builder-hidden-fresh-setup.png'),
    animations: 'disabled',
  });
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Library retains its assigned conversation through uncertain metadata and retries the same handoff', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'light', false, true);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByLabel('Agent name').fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await prepareFirstCommand(
    page,
    'Retain this exact conversation while its metadata is unavailable.',
  );
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await page
    .locator('.telos-chat-context')
    .getByRole('link', { name: 'Open Agent Library', exact: true })
    .click();
  for (const uncertainty of ['unavailable', 'malformed', 'not-found', 'unclassified'] as const) {
    fixture.lifecycle.metadata = uncertainty;
    const readsBefore = fixture.lifecycle.metadataReads;
    await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/retained|retry|could not/i);
    await expect(page).toHaveURL(/\/agent-library$/);
    expect(fixture.lifecycle.metadataReads).toBeGreaterThan(readsBefore);
    await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
    expect(fixture.commands).toHaveLength(1);
  }
  await page.screenshot({
    path: info.outputPath('ordinary-builder-metadata-recovery.png'),
    animations: 'disabled',
  });
  fixture.lifecycle.metadata = 'visible';
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await expect(
    page.getByText('Retain this exact conversation while its metadata is unavailable.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Library recovers the original uncertain command after its ordinary draft is discarded', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'dark', false, true);
  fixture.lifecycle.legacy = true;
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByLabel('Agent name').fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const originalDraft = new URL(page.url()).searchParams.get('draft');
  const source = await reviewSource(page, 'Working Bob');
  const settings = await openSettings(page);
  await settings
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption('legacy-account');
  await settings
    .getByRole('combobox', { name: 'Thinking level', exact: true })
    .selectOption('high');
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  const originalPrompt = 'Recover this exact reviewed command after its response is lost.';
  await page.getByRole('textbox', { name: 'Message Mitzo', exact: true }).fill(originalPrompt);
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
  await expect.poll(() => fixture.legacyCommands.length).toBeGreaterThan(0);
  const originalCommand = fixture.legacyCommands[0];
  expect(originalCommand).toMatchObject({
    sessionId: null,
    accountId: 'legacy-account',
    model: 'luna-fixture',
    reasoningEffort: 'high',
    prompt: originalPrompt,
    agentProfile: {
      kind: 'builtin',
      profileId: 'mitzo-profile-builder',
      revision: PROFILE_BUILDER_REVISION,
    },
  });
  expect(JSON.parse(originalCommand.sourceSnapshots![0].content)).toEqual(source);

  // Use the real saved-draft collection and discard confirmation. The reviewed
  // outbox remains uncertain; no source mapping or storage is modified by tests.
  await page.goto('/sessions/drafts');
  const draft = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: originalPrompt, exact: true }) });
  await draft.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(draft).toHaveCount(0);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  expect(new URL(page.url()).searchParams.get('draft')).toBe(originalDraft);
  expect(await reviewSource(page, 'Working Bob')).toEqual(source);
  const reopenedSettings = await openSettings(page);
  await reopenedSettings
    .getByRole('combobox', { name: 'Account', exact: true })
    .selectOption('legacy-account');
  await reopenedSettings
    .getByRole('combobox', { name: 'Thinking level', exact: true })
    .selectOption('high');
  await reopenedSettings.getByRole('button', { name: 'Done', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Mitzo', exact: true })
    .fill('A second command must wait for the original receipt.');
  await page.getByRole('button', { name: /^(Send message|Start session)$/, exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The reviewed conversation identity could not be retained.' }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('ordinary-builder-discarded-uncertain-draft.png'),
    animations: 'disabled',
  });

  fixture.lifecycle.acceptLegacy = true;
  await expect.poll(() => fixture.lifecycle.legacyAccepted, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await expect(page.getByText(originalPrompt, { exact: true })).toBeVisible();
  expect(fixture.legacyCommands.length).toBeGreaterThan(1);
  for (const retry of fixture.legacyCommands) expect(retry).toEqual(originalCommand);
  expect(fixture.commands).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('Library keeps fresh setup when a hidden conversation receives its delayed original command receipt', async ({
  page,
  isMobile,
}) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'light', false, true);
  fixture.lifecycle.commandState = 'reserved';
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByLabel('Agent name').fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const oldDraft = new URL(page.url()).searchParams.get('draft');
  await prepareFirstCommand(page, 'Keep this original reserved command identity.');
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await page
    .locator('.telos-chat-context')
    .getByRole('link', { name: 'Open Agent Library', exact: true })
    .click();
  fixture.lifecycle.metadata = 'hidden';
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  const freshUrl = page.url();
  expect(new URL(freshUrl).searchParams.get('draft')).not.toBe(oldDraft);
  fixture.lifecycle.commandState = 'consumed';
  const recoverySettings = await openSettings(page);
  await recoverySettings.getByText('More settings', { exact: true }).click();
  const recover = page.getByRole('button', { name: 'Recover original Local command', exact: true });
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  await expect(recover).toBeDisabled();
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  await recoverySettings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(freshUrl);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
    'Help me refine this agent.',
  );
  await page
    .locator('.telos-chat-context')
    .getByRole('link', { name: 'Open Agent Library', exact: true })
    .click();
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(freshUrl);
  expect(fixture.commands).toHaveLength(2);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const operation of ['create', 'edit'] as const) {
  test(`ordinary Builder ${operation}s a paused task through explicit review and recovers its exact saved receipt`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const fixture = await offline(
      page,
      operation === 'create' ? 'dark' : 'light',
      false,
      true,
      operation,
    );
    await page.goto('/agent-library');
    await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
    await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
    await prepareFirstCommand(page, 'Prepare a paused morning task for review.');
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
    const proposal = page.getByRole('region', { name: 'Agent task proposal', exact: true });
    await expect(proposal.getByLabel('Task name', { exact: true })).toHaveValue('Morning review');
    await expect(proposal).toContainText(
      operation === 'create' ? 'Nothing is saved as a task yet.' : 'at revision 3',
    );
    await expect(proposal).toContainText(fixture.task.definition.profile.contentHash);
    expect(fixture.task.saves).toEqual([]);
    // The Builder used its own ordinary account/model/thinking/target. Task intent
    // deliberately names unavailable selections and remains inspectable verbatim.
    expect(fixture.commands[0].selection.thinking).toBe('high');
    expect(fixture.task.definition.execution?.reasoningEffort).toBe('low');
    const builderSettings = await openSettings(page);
    await builderSettings
      .getByRole('combobox', { name: 'Thinking level', exact: true })
      .selectOption('low');
    await builderSettings
      .getByRole('combobox', { name: 'Thinking level', exact: true })
      .selectOption('high');
    await builderSettings.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(proposal.locator('pre')).toContainText('"reasoningEffort": "low"');
    await expect(proposal.locator('pre')).toContainText('task-only-account');
    expect(fixture.task.saves).toEqual([]);
    expect(fixture.commands).toHaveLength(1);
    await proposal.locator(':scope > p').first().scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-task-${operation}-top.png`),
      animations: 'disabled',
    });
    await proposal.getByLabel('Task name', { exact: true }).fill('Reviewed morning task');
    await proposal.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('cron');
    await proposal.getByLabel('Cron expression', { exact: true }).fill('tomorrow');
    await proposal.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(proposal.getByRole('alert')).toContainText('five-field cron');
    expect(fixture.task.saves).toEqual([]);
    await proposal.getByLabel('Cron expression', { exact: true }).fill('30 8 * * 1-5');
    await proposal.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(proposal.getByRole('alert')).toHaveText('Offline task owner unavailable');
    expect(fixture.task.saves).toHaveLength(1);
    const originalSave = fixture.task.saves[0];
    expect(originalSave).toMatchObject({
      sessionId,
      kind: 'task',
      taskId: 'morning-review',
      expectedRevision: operation === 'edit' ? 3 : 0,
    });
    expect((originalSave.definition as typeof fixture.task.definition).execution).toEqual(
      fixture.task.definition.execution,
    );
    await proposal.getByRole('alert').scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        proposal.evaluate((element) => ({
          card: element.scrollWidth <= element.clientWidth,
          area: element.parentElement!.scrollWidth <= element.parentElement!.clientWidth,
        })),
      )
      .toEqual({ card: true, area: true });
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-task-${operation}-review.png`),
      animations: 'disabled',
    });
    await page.reload();
    await expect(proposal.getByLabel('Task name', { exact: true })).toHaveValue(
      'Reviewed morning task',
    );
    await proposal.getByRole('button', { name: 'Retry task save', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved Reviewed morning task' }),
    ).toContainText(`task morning-review · revision ${operation === 'edit' ? 4 : 1}`);
    expect(fixture.task.saves[1]).toEqual(originalSave);
    expect(fixture.task.saved?.definition.execution).toEqual(fixture.task.definition.execution);
    expect(fixture.task.saved?.definition.schedule).toEqual({
      cron: '30 8 * * 1-5',
      timezone: 'Europe/Dublin',
      state: 'paused',
    });
    expect(fixture.task.saved?.configuration).toEqual({
      state: 'blocked',
      reason: 'admission-unavailable',
    });
    await page.reload();
    const receipt = page.getByRole('status').filter({ hasText: 'Saved Reviewed morning task' });
    await expect(receipt).toContainText('Schedule paused.');
    await expect(receipt).toContainText('Saving does not start work.');
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-task-${operation}-receipt.png`),
      animations: 'disabled',
    });
    await receipt.getByRole('link', { name: 'Open Library task', exact: true }).click();
    await expect(page).toHaveURL(/\/agent-library\?task=morning-review$/);
    await expect(page.getByLabel('Task name', { exact: true })).toHaveValue(
      'Reviewed morning task',
    );
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.proposalSaves).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test('ordinary Builder cancels a task save wait, retains exact retry through operator revocation', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, 'light', false, true, 'create');
  await page.goto('/agent-library');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await prepareFirstCommand(page, 'Review this task before saving.');
  const proposal = page.getByRole('region', { name: 'Agent task proposal', exact: true });
  await expect(proposal.getByLabel('Task name', { exact: true })).toHaveValue('Morning review');
  fixture.task.failNext = false;
  fixture.task.holdSave = true;
  await proposal.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect.poll(() => fixture.task.saves.length).toBe(1);
  await proposal.getByRole('button', { name: 'Cancel save wait', exact: true }).click();
  await expect(proposal.getByRole('alert')).toContainText('outcome is unconfirmed');
  await expect(proposal.getByRole('textbox', { name: 'Objective', exact: true })).toBeDisabled();
  fixture.task.revoked = true;
  fixture.task.holdSave = false;
  fixture.task.releaseSave?.();
  await proposal.getByRole('button', { name: 'Retry task save', exact: true }).click();
  await expect(proposal.getByRole('alert')).toContainText(
    'Interactive operator authority was revoked',
  );
  await expect(proposal.getByRole('textbox', { name: 'Objective', exact: true })).toBeDisabled();
  await expect(
    proposal.getByRole('button', { name: 'Discard task proposal', exact: true }),
  ).toBeDisabled();
  expect(fixture.task.saves[1]).toEqual(fixture.task.saves[0]);
  expect(fixture.task.saved).toBeNull();
  await page.screenshot({
    path: info.outputPath('ordinary-builder-task-revocation.png'),
    animations: 'disabled',
  });
  fixture.lifecycle.metadata = 'unavailable';
  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: 'Conversation settings are unavailable' }),
  ).toBeVisible();
  await expect(proposal).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  expect(fixture.task.saves).toHaveLength(2);
  fixture.lifecycle.metadata = 'visible';
  fixture.task.revoked = false;
  await page.reload();
  await expect(
    proposal.getByRole('button', { name: 'Retry task save', exact: true }),
  ).toBeEnabled();
  await proposal.getByRole('button', { name: 'Retry task save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Morning review' })).toContainText(
    'revision 1',
  );
  expect(fixture.task.saves[2]).toEqual(fixture.task.saves[0]);
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
