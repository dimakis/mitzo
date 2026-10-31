import { expect, test, type Page } from '@playwright/test';
import { chooseSetting, settingsHome } from '../support/chat-settings';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
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

// Diagnostic-only copy: original accepted business/error assertions retained.
const diagnostic = new WeakMap<Page, Record<string, unknown>[]>();
test.beforeEach(async ({ page }) => {
  const rows: Record<string, unknown>[] = [];
  diagnostic.set(page, rows);
  const log = (kind: string, detail: Record<string, unknown> = {}) =>
    rows.push({ kind, nodeEpoch: Date.now(), ...detail });
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('__S7_HEALTH_DIAG__')) {
      try {
        log('browser', JSON.parse(text.slice('__S7_HEALTH_DIAG__'.length)));
      } catch {
        log('diagnostic-decode-failure');
      }
    }
  });
  page.on('pageerror', (error) => log('pageerror', { message: error.message, stack: error.stack }));
  page.on('request', (request) => {
    if (request.isNavigationRequest() || new URL(request.url()).pathname === '/api/service-health')
      log('request', { url: request.url(), navigation: request.isNavigationRequest() });
  });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/api/service-health')
      log('requestfailed', { url: request.url(), failure: request.failure() });
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/service-health') return;
    log('response', { url: response.url(), status: response.status() });
    void response.finished().then(
      (error) => log('response-finished', { failure: error?.message ?? null }),
      (error: unknown) => log('response-finish-rejected', { failure: String(error) }),
    );
  });
  await page.addInitScript(() => {
    const documentId = crypto.randomUUID();
    const log = (kind: string, detail: Record<string, unknown> = {}) =>
      console.debug(
        '__S7_HEALTH_DIAG__' +
          JSON.stringify({
            kind,
            documentId,
            epoch: Date.now(),
            time: performance.now(),
            origin: performance.timeOrigin,
            url: location.href,
            visibility: document.visibilityState,
            ...detail,
          }),
      );
    log('document-init');
    for (const name of ['pagehide', 'pageshow', 'beforeunload', 'unload', 'visibilitychange'])
      window.addEventListener(name, (event) =>
        log(name, { persisted: 'persisted' in event ? event.persisted : undefined }),
      );
    window.addEventListener('error', (event) => log('windowerror', { message: event.message }));
    window.addEventListener('unhandledrejection', (event) =>
      log('unhandledrejection', { reason: String(event.reason) }),
    );
    window.addEventListener('rejectionhandled', () => log('rejectionhandled'));
    window.addEventListener('fixture-health-diagnostic', (event) => {
      const { kind, ...detail } = (event as CustomEvent).detail;
      log(kind, detail);
    });
    const native = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        location.href,
      );
      if (url.pathname === '/api/service-health') {
        log('fetch-start', { signalAborted: init?.signal?.aborted ?? false });
        init?.signal?.addEventListener('abort', () => log('fetch-abort'), { once: true });
      }
      // Return the exact native promise; no diagnostic rejection handler.
      return Reflect.apply(native, this, [input, init]);
    };
  });
});
test.afterEach(async ({ page }, info) => {
  console.log('__S7_HEALTH_DIAG_RESULT__' + JSON.stringify(diagnostic.get(page)));
  await writeFile(
    info.outputPath('health-navigation-diagnostic.json'),
    JSON.stringify(diagnostic.get(page), null, 2),
  );
});

test.use({ baseURL: 'https://mitzo-ui.test' });
const bundle = build({
  entryPoints: [resolve('tests/fixtures/agent-library-builder.tsx')],
  bundle: true,

  plugins: [
    {
      name: 'passive-health-diagnostic',
      setup(builder) {
        builder.onLoad({ filter: /\/(useServiceHealth|api-json-read)\.ts$/ }, async ({ path }) => {
          let code = await readFile(path, 'utf8');
          if (path.endsWith('/useServiceHealth.ts')) {
            const replacements = [
              [
                'const poll = async (nativeForeground = false) => {',
                'const poll = async (nativeForeground = false) => { __s7HealthLog({kind:"poll-entry",active,blocked,receivedSse,pending:Boolean(pending)});',
              ],
              [
                '} catch {\n        /* Retain the last observed health while the server is unreachable. */',
                '} catch (error) { __s7HealthLog({kind:"poll-caught",error:String(error)});\n        /* Retain the last observed health while the server is unreachable. */',
              ],
              [
                'const startup = setTimeout(() => void poll(), SSE_FALLBACK_DELAY_MS);',
                'const startup = setTimeout(() => { __s7HealthLog({kind:"startup-fired"}); void poll(); }, SSE_FALLBACK_DELAY_MS);',
              ],
              ['stopHealth = () => {', 'stopHealth = () => { __s7HealthLog({kind:"owner-stop"});'],
            ];
            for (const [from, to] of replacements) {
              if (!code.includes(from)) throw Error('Diagnostic source anchor differs');
              code = code.replace(from, to);
            }
          } else {
            const from = '  } finally {\n    clearTimeout(timeout);';
            if (!code.includes(from)) throw Error('Diagnostic helper anchor differs');
            code = code.replace(
              from,
              '  } catch (error) { if (path === "/api/service-health") __s7HealthLog({kind:"helper-caught",error:String(error)}); throw error; } finally {\n    clearTimeout(timeout);',
            );
          }
          // Catch only telemetry delivery failures; application errors keep
          // their original catch/rethrow path even if the document is disposed.
          const logger =
            'const __s7HealthLog = (detail: Record<string, unknown>) => { try { globalThis.dispatchEvent(new CustomEvent("fixture-health-diagnostic", { detail })); } catch { /* diagnostic delivery only */ } };\n';
          return { contents: logger + code, loader: 'ts' };
        });
      },
    },
  ],

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
      if (path === '/api/telos/work/links' && route.request().method() === 'POST') {
        // Existing Resources association lookup is a read; it grants no work mutation.
        expect(route.request().postDataJSON()).toEqual({
          namespace: 'mitzo',
          conversationId: sessionId,
        });
        return route.fulfill({ json: [] });
      }
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
