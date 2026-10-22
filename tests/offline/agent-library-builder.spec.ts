import { expect, test, type Page } from '@playwright/test';
import { chooseSetting, openChatSetting, settingRow, settingsHome } from '../support/chat-settings';
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
    readStatus: 200,
    holdSave: false,
    releaseSave: null as (() => void) | null,
  };
  let proposalSaved = false;
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
      if (path === '/api/telos/work/links' && route.request().method() === 'POST') {
        // Existing Resources association lookup is a read; it grants no work mutation.
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: sessionId,
        });
        return route.fulfill({ json: [] });
      }
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
      if (path === '/api/symposium/profile-proposals' && task.readStatus !== 200)
        return route.fulfill({
          status: task.readStatus,
          json: { error: 'Offline task review unavailable' },
        });
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
                ...(taskAuthoring
                  ? [
                      {
                        messageId: 'ordinary-task-authoring-result',
                        role: 'assistant',
                        timestamp: 2,
                        blocks: [
                          {
                            blockId: 'task-read-call',
                            blockType: 'tool_use',
                            content: '',
                            toolName: 'AgentReadTasks',
                            toolResult: JSON.stringify({ tasks: [] }),
                          },
                          {
                            blockId: 'task-propose-call',
                            blockType: 'tool_use',
                            content: '',
                            toolName: 'AgentProposeTask',
                            toolResult: JSON.stringify({
                              proposalId: 'offline-task-proposal',
                              status: 'awaiting_user_review',
                              taskId: 'morning-review',
                              expectedRevision: task.expectedRevision,
                            }),
                          },
                        ],
                      },
                    ]
                  : []),
              ]
            : [],
        '/api/symposium/profile-proposals':
          taskAuthoring && commands.length
            ? [
                {
                  kind: 'task',
                  sessionId,
                  createdAt: 1,
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
  return settingsHome(page);
}

async function prepareFirstCommand(page: Page, prompt: string) {
  const panel = await openSettings(page);
  await chooseSetting(page, 'Account', 'personal');
  await chooseSetting(page, 'Thinking', 'high');
  await openChatSetting(page, 'execution');
  await panel.getByRole('button', { name: 'Local Mac', exact: true }).click();
  await openChatSetting(page, 'repository');
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

async function editableProfileName(page: Page) {
  const field = page.getByLabel('Agent name', { exact: true });
  const edit = page.getByText('Edit profile', { exact: true });
  await expect(field.or(edit).first()).toBeVisible();
  if (!(await field.isVisible())) await edit.click();
  return field;
}

async function openTaskReview(page: Page, expectedRevision: number, screenshotPath?: string) {
  await expect(page.getByRole('region', { name: 'Task editor', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Agent task proposal', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveCount(0);
  const activity = page.getByRole('button', { name: 'Activity: AgentProposeTask', exact: true });
  await expect(activity).toBeVisible();
  if ((await activity.getAttribute('aria-expanded')) !== 'true') await activity.click();
  await page.getByRole('button', { name: 'AgentProposeTask', exact: true }).click();
  const review = page.getByRole('link', { name: 'Review task in Library', exact: true });
  if (screenshotPath) {
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  }
  const url = new URL((await review.getAttribute('href'))!, page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    proposal: 'offline-task-proposal',
    session: sessionId,
    task: 'morning-review',
    revision: String(expectedRevision),
  });
  await review.click();
  await expect(page).toHaveURL(url.href);
  return page.getByRole('region', { name: 'Task editor', exact: true });
}

test('ordinary task result keeps chat native, reviews in Library and returns to the exact Builder conversation', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, isMobile ? 'dark' : 'light', false, true, 'create');
  await page.goto('/agent-library');
  await expect(page.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible();
  const collections = page.getByRole('tablist', { name: 'Library collections', exact: true });
  const collectionBounds = await Promise.all(
    (await collections.getByRole('tab').all()).map((tab) => tab.boundingBox()),
  );
  expect(collectionBounds).toHaveLength(2);
  expect(Math.abs(collectionBounds[0]!.y - collectionBounds[1]!.y)).toBeLessThan(1);
  await page.screenshot({
    path: info.outputPath('library-published-profile.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const source = await reviewSource(page, 'Bob');
  await prepareFirstCommand(page, 'Propose a paused task using this exact profile.');
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  const originalChat = page.url();
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await composer.fill('Keep discussing the reviewed task.');
  const builderSettings = await openSettings(page);
  await chooseSetting(page, 'Thinking', 'low');
  await builderSettings.getByRole('button', { name: 'Done', exact: true }).click();
  expect(fixture.task.saves).toEqual([]);
  expect(fixture.commands).toHaveLength(1);
  const editor = await openTaskReview(
    page,
    0,
    info.outputPath('ordinary-builder-native-task-result.png'),
  );
  await expect(editor.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Morning review',
  );
  await expect(editor).toContainText('Bob · Profile r3');
  await expect(
    editor.getByRole('textbox', { name: 'Workspace reference', exact: true }),
  ).toHaveCount(0);
  const advanced = editor.getByText('Workspace and notifications', { exact: true });
  await advanced.focus();
  await advanced.press('Enter');
  await expect(
    editor.getByRole('textbox', { name: 'Workspace reference', exact: true }),
  ).toHaveValue(fixture.task.definition.workspace!.workspaceId);
  await advanced.press('Space');
  await expect(
    editor.getByRole('textbox', { name: 'Workspace reference', exact: true }),
  ).toHaveCount(0);
  await expect(advanced).toBeFocused();
  await editor
    .getByRole('textbox', { name: 'Task name', exact: true })
    .fill('Reviewed morning task');
  await page.screenshot({
    path: info.outputPath('library-task-proposal-review.png'),
    animations: 'disabled',
  });
  const largerText = await page.addStyleTag({ content: 'html { font-size:125% !important; }' });
  await editor.getByRole('button', { name: 'Save task', exact: true }).scrollIntoViewIfNeeded();
  await expect(editor.getByRole('button', { name: 'Save task', exact: true })).toBeInViewport();
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const controlHeights = await editor
    .locator('input,select,textarea,button,summary')
    .filter({ visible: true })
    .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  expect(controlHeights.length).toBeGreaterThan(0);
  for (const height of controlHeights) expect(height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: info.outputPath('library-task-large-text.png'),
    animations: 'disabled',
  });
  await largerText.evaluate((element) => (element as HTMLStyleElement).remove());
  await page.getByRole('link', { name: 'Back to Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(originalChat);
  await expect(composer).toHaveValue('Keep discussing the reviewed task.');
  expect(await reviewSource(page, 'Bob')).toEqual(source);
  await openTaskReview(page, 0);
  await expect(editor.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Reviewed morning task',
  );
  expect(fixture.task.saves).toEqual([]);
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('ordinary task save recovers its exact receipt across reload and restores the Builder draft', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, isMobile ? 'dark' : 'light', false, true, 'create');
  await page.goto('/agent-library');
  await expect(page.getByRole('heading', { name: 'Bob', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const source = await reviewSource(page, 'Bob');
  await prepareFirstCommand(page, 'Propose a paused task using this exact profile.');
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  const originalChat = page.url();
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await composer.fill('Keep discussing the reviewed task.');
  const builderSettings = await openSettings(page);
  await chooseSetting(page, 'Thinking', 'low');
  await builderSettings.getByRole('button', { name: 'Done', exact: true }).click();
  const editor = await openTaskReview(page, 0);
  await expect(editor.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Morning review',
  );
  await editor
    .getByRole('textbox', { name: 'Task name', exact: true })
    .fill('Reviewed morning task');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Offline task owner unavailable');
  const originalSave = fixture.task.saves[0];
  expect((originalSave.definition as typeof fixture.task.definition).execution).toEqual(
    fixture.task.definition.execution,
  );
  await page.reload();
  await expect(editor.getByRole('textbox', { name: 'Task name', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry task save', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved Reviewed morning task' }),
  ).toContainText('revision 1');
  expect(fixture.task.saves[1]).toEqual(originalSave);
  await page.reload();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved Reviewed morning task' }),
  ).toContainText('revision 1');
  await page.screenshot({
    path: info.outputPath('library-task-exact-receipt.png'),
    animations: 'disabled',
  });
  await page.getByRole('link', { name: 'Back to Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(originalChat);
  await expect(composer).toHaveValue('Keep discussing the reviewed task.');
  await page.screenshot({
    path: info.outputPath('ordinary-builder-task-return.png'),
    animations: 'disabled',
  });
  expect(await reviewSource(page, 'Bob')).toEqual(source);
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`Library refinement uses ordinary Builder chat and retains both drafts (${theme})`, async ({
    page,
    isMobile,
  }, info) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    const fixture = await offline(page, theme);
    await page.goto('/agent-library');
    await expect(await editableProfileName(page)).toHaveValue('Bob');
    await (await editableProfileName(page)).fill('Working Bob');
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
    await openChatSetting(page, 'agent');
    await expect(panel.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(
      JSON.stringify(['builtin', 'mitzo-profile-builder', PROFILE_BUILDER_REVISION]),
    );
    await settingsHome(page);
    for (const field of ['Account', 'Model', 'Thinking'] as const) {
      const row = settingRow(panel, field);
      await expect(row).toBeVisible();
      // Allow only subpixel arithmetic noise; retain the 44px layout target.
      expect(
        await row.evaluate((element) => (element as HTMLElement).offsetHeight),
      ).toBeGreaterThanOrEqual(44);
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 0.0001);
    }
    await expect(settingRow(panel, 'Account')).toHaveAttribute('data-value', '');
    await chooseSetting(page, 'Account', 'personal');
    await chooseSetting(page, 'Thinking', 'high');
    await openChatSetting(page, 'execution');
    await expect(panel.getByRole('group', { name: 'Run on', exact: true })).toBeVisible();
    await expect(panel.getByText('Runs with Codex', { exact: true })).toBeVisible();
    await settingsHome(page);
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-settings-${theme}.png`),
      animations: 'disabled',
    });
    await panel.press('Escape');
    await composer.fill('Keep the exact unsaved instructions and improve the acceptance criteria.');
    await composer.focus();
    await expect(composer).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`ordinary-builder-${theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
    await expect(await editableProfileName(page)).toHaveValue('Working Bob');
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
    await expect(settingRow(restoredSettings, 'Account')).toHaveAttribute('data-value', 'personal');
    await expect(settingRow(restoredSettings, 'Thinking')).toHaveAttribute('data-value', 'high');
    await restoredSettings.press('Escape');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Create with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await expect(composer).toHaveValue('Help me create an agent.');
  await expect(page.getByRole('link', { name: 'Open Agent Library', exact: true })).toBeVisible();
  const source = await reviewSource(page, 'New agent');
  expect(source.definition.name).toBe('');
  expect(source.source).toMatchObject({ kind: 'draft', baseRevision: 0, draftVersion: null });
  const panel = await openSettings(page);
  await openChatSetting(page, 'execution');
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
  await expect(await editableProfileName(page)).toHaveValue('');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await (await editableProfileName(page)).fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const snapshot = await reviewSource(page, 'Working Bob');
  const panel = await openSettings(page);
  await chooseSetting(page, 'Account', 'personal');
  await chooseSetting(page, 'Thinking', 'high');
  await openChatSetting(page, 'execution');
  await panel.getByRole('button', { name: 'Local Mac', exact: true }).click();
  expect(fixture.commands).toEqual([]);
  await openChatSetting(page, 'repository');
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
  await expect(await editableProfileName(page)).toHaveValue('Working Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await (await editableProfileName(page)).fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const originalDraft = new URL(page.url()).searchParams.get('draft');
  const source = await reviewSource(page, 'Working Bob');
  await prepareFirstCommand(page, 'Refine the original reviewed profile.');
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await page
    .locator('.telos-chat-context')
    .getByRole('link', { name: 'Open Agent Library', exact: true })
    .click();
  await expect(await editableProfileName(page)).toHaveValue('Working Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await (await editableProfileName(page)).fill('Working Bob');
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
    await expect(await editableProfileName(page)).toHaveValue('Working Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await (await editableProfileName(page)).fill('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  const originalDraft = new URL(page.url()).searchParams.get('draft');
  const source = await reviewSource(page, 'Working Bob');
  const settings = await openSettings(page);
  await chooseSetting(page, 'Account', 'legacy-account');
  await chooseSetting(page, 'Thinking', 'high');
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
  await expect(await editableProfileName(page)).toHaveValue('Working Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\?/);
  expect(new URL(page.url()).searchParams.get('draft')).toBe(originalDraft);
  expect(await reviewSource(page, 'Working Bob')).toEqual(source);
  const reopenedSettings = await openSettings(page);
  await chooseSetting(page, 'Account', 'legacy-account');
  await chooseSetting(page, 'Thinking', 'high');
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
  await expect(await editableProfileName(page)).toHaveValue('Working Bob');
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await (await editableProfileName(page)).fill('Working Bob');
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
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  fixture.lifecycle.commandState = 'consumed';
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/chat?draft=${oldDraft}`);
  const recover = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  await expect(recover).toHaveCount(0);
  expect(fixture.commands[1]).toEqual(fixture.commands[0]);
  await page.evaluate((url) => {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, freshUrl);
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

test('ordinary Builder reviews a new Local Mac task using its retained route without changing execution intent', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, isMobile ? 'dark' : 'light', false, true, 'create');
  fixture.task.definition.execution = {
    ...fixture.task.definition.execution!,
    account: runtimeInventory.accounts[0].account,
    targetId: 'mac',
    model: 'luna-fixture',
  };
  fixture.task.failNext = false;
  const execution = structuredClone(fixture.task.definition.execution);
  await page.goto('/agent-library');
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await prepareFirstCommand(page, 'Propose a paused task on this Mac.');
  await openTaskReview(page, 0);
  const proposal = page.getByRole('region', { name: 'Task proposal review', exact: true });
  const taskSettings = proposal.getByRole('button', { name: /^Agent settings,/ });
  await expect(taskSettings).toHaveAccessibleName(/Local Mac/);
  await taskSettings.click();
  await expect(proposal.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'luna-fixture',
  );
  await expect(proposal.getByRole('option', { name: 'Luna fixture', exact: true })).toBeEnabled();
  await expect(proposal.getByRole('button', { name: 'Local Mac', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(proposal.getByText('Runs with Codex', { exact: true })).toBeVisible();
  await proposal.getByRole('button', { name: 'Done', exact: true }).click();
  expect(fixture.task.saves).toEqual([]);
  expect(fixture.commands).toHaveLength(1);
  await taskSettings.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('ordinary-builder-new-local-task.png'),
    animations: 'disabled',
  });
  await proposal.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved Morning review' })).toContainText(
    'task morning-review · revision 1',
  );
  expect(fixture.task.saved?.definition.execution).toEqual(execution);
  expect(fixture.task.saved?.definition.schedule?.state).toBe('paused');
  expect(fixture.task.saves).toHaveLength(1);
  expect(fixture.commands).toHaveLength(1);
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
    await expect(await editableProfileName(page)).toHaveValue('Bob');
    await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
    await prepareFirstCommand(page, 'Prepare a paused morning task for review.');
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
    // The Builder used its own ordinary account/model/thinking/target. Task intent
    // deliberately names unavailable selections and remains inspectable verbatim.
    expect(fixture.commands[0].selection.thinking).toBe('high');
    expect(fixture.task.definition.execution?.reasoningEffort).toBe('low');
    const builderSettings = await openSettings(page);
    await chooseSetting(page, 'Thinking', 'low');
    await expect(settingRow(builderSettings, 'Thinking')).toHaveAttribute('data-value', 'low');
    await chooseSetting(page, 'Thinking', 'high');
    await expect(settingRow(builderSettings, 'Thinking')).toHaveAttribute('data-value', 'high');
    await builderSettings.getByRole('button', { name: 'Done', exact: true }).click();
    await openTaskReview(page, operation === 'edit' ? 3 : 0);
    const proposal = page.getByRole('region', { name: 'Task proposal review', exact: true });
    await expect(proposal.getByLabel('Task name', { exact: true })).toHaveValue('Morning review');
    await expect(proposal).toContainText(
      operation === 'create' ? 'Nothing is saved as a task yet.' : 'at revision 3',
    );
    await expect(
      proposal.getByRole('combobox', { name: 'Agent profile', exact: true }),
    ).toHaveValue(`bob:3:${fixture.task.definition.profile.contentHash}`);
    await expect(proposal.getByRole('button', { name: /^Agent settings,/ })).toHaveAccessibleName(
      /Low/,
    );
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
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await prepareFirstCommand(page, 'Review this task before saving.');
  await openTaskReview(page, 0);
  const proposal = page.getByRole('region', { name: 'Task proposal review', exact: true });
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
  fixture.task.readStatus = 503;
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText('Offline task review unavailable');
  await expect(proposal).toHaveCount(0);
  expect(fixture.task.saves).toHaveLength(2);
  fixture.task.readStatus = 200;
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

test('Library keeps a new task draft independent after leaving an older saved task link', async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const fixture = await offline(page, isMobile ? 'dark' : 'light', false, true, 'create');
  fixture.task.failNext = false;
  await page.goto('/agent-library');
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
  await prepareFirstCommand(
    page,
    'Propose a paused task before assigning another independent draft.',
  );
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  const originalChat = page.url();
  await openTaskReview(page, 0);
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  const receipt = page.getByRole('status').filter({ hasText: 'Saved Morning review' });
  await expect(receipt).toContainText('revision 1');
  await receipt.getByRole('link', { name: 'Open Library task', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Morning review',
  );
  const originalSaved = structuredClone(fixture.task.saved);
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await page.getByRole('button', { name: 'Assign task', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Task name', exact: true })
    .fill('Independent unsaved task');
  await page
    .getByRole('textbox', { name: 'Objective', exact: true })
    .fill('Retain this unfinished objective while I return to the Builder.');
  const retained = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!),
  );
  expect(retained.taskId).not.toBe(originalSaved!.taskId);
  expect(retained.expectedRevision).toBe(0);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Task settings: Morning review', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Independent unsaved task',
  );
  await expect(page).toHaveURL('https://mitzo-ui.test/agent-library');
  await page.goto(originalChat);
  await page.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
    'Independent unsaved task',
  );
  await expect(page.getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue(
    'Retain this unfinished objective while I return to the Builder.',
  );
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('mitzo-agent-task-working-copy')!)),
  ).toEqual(retained);
  expect(fixture.task.saved).toEqual(originalSaved);
  expect(fixture.task.saves).toHaveLength(1);
  expect(fixture.commands).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  await page.getByRole('button', { name: 'Save task', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath('library-independent-new-task-draft.png'),
    animations: 'disabled',
  });
});
