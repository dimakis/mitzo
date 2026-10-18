import { editProfile, openProfileTools, openToolLibrary } from '../support/agent-library';
import { expect, test, type Page } from '@playwright/test';
import { openChatSetting, settingRow, settingsHome } from '../support/chat-settings';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROFILE_BUILDER_REVISION,
  type AgentLibraryCatalog,
  type AgentLibraryDraft,
  type AgentLibraryVersion,
} from '@mitzo/protocol';

test.use({ baseURL: 'https://mitzo-ui.test' });
async function editableProfileName(page: Page) {
  const field = page.getByLabel('Agent name', { exact: true });
  const edit = page.getByText('Edit profile', { exact: true });
  await expect(field.or(edit).first()).toBeVisible();
  if (!(await field.isVisible())) await edit.click();
  return field;
}
async function libraryOptions(page: Page) {
  const summary = page.getByText('Library options', { exact: true });
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click();
}
async function taskAdvanced(page: Page) {
  const summary = page.getByText('Workspace and notifications', { exact: true });
  if (!(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)))
    await summary.click();
}

test('edits and publishes named agents while preserving Agents navigation', async ({
  page,
  isMobile,
}, testInfo) => {
  // This full-app journey captures four appearance combinations and large-text states.
  // CI WebKit reached the final chat checks at 30s; allow a bounded journey budget.
  test.setTimeout(60_000);
  const definition = {
    name: 'Bob',
    descriptor: 'The architect',
    description: 'Challenge designs and make tradeoffs explicit.',
    role: 'reviewer',
    instructions: 'Challenge assumptions. Compare viable options.',
    expectedOutput: 'Decision brief',
    acceptanceCriteria: ['Cite evidence'],
    modelPolicyRole: 'reviewer',
  };
  const catalog: AgentLibraryCatalog = {
    drafts: [],
    versions: [{ profileId: 'bob', revision: 3, definition, contentHash: 'a'.repeat(64) }],
  };
  const errors: string[] = [];
  const inferenceRequests: string[] = [];
  let catalogMode: 'content' | 'empty' | 'error' | 'loading' = 'content';
  let releaseCatalog: (() => void) | undefined;
  let previewError = false;
  let taskSaveError = true;
  let holdTaskSave = false;
  let releaseTaskSave: (() => void) | undefined;
  let releaseTaskList: (() => void) | undefined;
  const tasks: import('@mitzo/protocol').AgentTaskRecord[] = [
    {
      taskId: 'other-task',
      revision: 1,
      definition: {
        name: 'Other saved task',
        objective: 'Independent task',
        profile: { profileId: 'bob', revision: 3, contentHash: 'a'.repeat(64) },
        execution: null,
        workspace: null,
        schedule: null,
        notificationPolicy: 'results',
        outputPolicy: 'session',
      },
      configuration: { state: 'draft' },
      deleted: false,
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    },
  ];
  const taskWrites: unknown[] = [];
  const account = { accountId: 'task-account', provider: 'openai', profileRevision: 'r1' };
  const taskInventory = {
    version: 1,
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    capabilityRevision: 'task-capabilities',
    accounts: [
      {
        account,
        label: 'Task account',
        models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] }],
        modelDiscovery: { source: 'configured', stale: false },
      },
    ],
    targets: [
      {
        targetId: 'task-shell',
        targetRevision: 't1',
        label: 'OpenShell',
        location: 'openshell',
        harness: 'responses',
      },
      {
        targetId: 'task-mac',
        targetRevision: 't1',
        label: 'Local Mac',
        location: 'local',
        harness: 'responses',
      },
    ],
    routes: ['task-shell', 'task-mac'].map((targetId) => ({
      account,
      targetId,
      harness: 'responses',
      modes: ['agent'],
    })),
    locations: [
      { location: 'openshell', status: 'configured' },
      { location: 'local', status: 'configured' },
    ],
    agentProfiles: [],
  };
  const subscription = {
    accountId: 'subscription',
    provider: 'openai-codex',
    profileRevision: 'r2',
  };
  taskInventory.accounts.push({
    ...taskInventory.accounts[0],
    account: subscription,
    label: 'Subscription',
  });
  taskInventory.targets.push({
    targetId: 'task-mac',
    targetRevision: 't2',
    label: 'OpenShell Codex',
    location: 'openshell',
    harness: 'codex',
  });
  taskInventory.routes.push({
    account: subscription,
    targetId: 'task-mac',
    harness: 'codex',
    modes: ['agent'],
  });
  page.on('dialog', (dialog) => dialog.accept());
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (
      url.pathname === '/api/agent-library/advice' ||
      /^\/api\/chat\/(?:send|(?:runtime|local-codex)\/(?:send|continue))$/.test(url.pathname)
    ) {
      inferenceRequests.push(url.pathname);
      return route.fulfill({ status: 405, json: { error: 'Setup must not dispatch inference' } });
    }
    if (
      ['/api/chat/runtime/capabilities', '/api/chat/local-codex/capabilities'].includes(
        url.pathname,
      )
    )
      return route.fulfill({ json: taskInventory });
    if (url.pathname === '/api/agent-tasks') {
      if (route.request().method() === 'GET') {
        const snapshot = structuredClone(tasks);
        if (holdTaskSave && releaseTaskSave)
          await new Promise<void>((resolve) => {
            releaseTaskList = resolve;
          });
        return route.fulfill({ json: snapshot });
      }
      const body = route.request().postDataJSON();
      taskWrites.push(body);
      if (taskSaveError)
        return route.fulfill({ status: 503, json: { error: 'Task save unavailable' } });
      expect(body.expectedRevision).toBe(0);
      const saved = {
        taskId: body.taskId,
        revision: 1,
        definition: body.definition,
        configuration: { state: 'blocked' as const, reason: 'admission-unavailable' as const },
        deleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.unshift(saved);
      if (holdTaskSave)
        await new Promise<void>((resolve) => {
          releaseTaskSave = resolve;
        });
      return route.fulfill({ json: saved });
    }
    if (url.pathname.startsWith('/api/agent-tasks/') && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      taskWrites.push(body);
      expect(body.expectedRevision).toBe(1);
      expect(body.definition.workspace.workspaceId).toBe('workspace-after-return');
      tasks[0] = { ...tasks[0], revision: 2, definition: body.definition };
      return route.fulfill({ json: tasks[0] });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/agent-library/tools')
        return route.fulfill({
          json: {
            tools: [
              {
                id: 'mitzo:Read',
                version: 1,
                name: 'Read',
                description: 'Read a UTF-8 workspace file.',
                source: 'Workspace',
                required: false,
                behavior: 'read',
                routes: ['local-api'],
                requirement: 'Workspace permissions apply.',
              },
              {
                id: 'mitzo:ConnectionRequest',
                version: 1,
                name: 'ConnectionRequest',
                description: 'Make a connection request.',
                source: 'Connections',
                required: false,
                behavior: 'mixed',
                routes: ['local-api'],
                requirement:
                  'No active service connection is configured. Set one up in Connections; each new session still requires approval.',
              },
              {
                id: 'mitzo:AskUserQuestion',
                version: 1,
                name: 'AskUserQuestion',
                description: 'Ask a structured question.',
                source: 'Platform',
                required: true,
                behavior: 'interaction',
                routes: ['local-api'],
                requirement: 'Questions grant no access.',
              },
            ],
          },
        });
      if (url.pathname === '/api/agent-library') {
        if (catalogMode === 'loading')
          await new Promise<void>((resolve) => {
            releaseCatalog = resolve;
          });
        if (catalogMode === 'error')
          return route.fulfill({ status: 503, json: { error: 'Offline Library unavailable' } });
        return route.fulfill({
          json: catalogMode === 'empty' ? { drafts: [], versions: [] } : catalog,
        });
      }
      if (url.pathname.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      if (url.pathname === '/api/agent-library/preview') {
        if (previewError)
          return route.fulfill({
            status: 503,
            json: { error: 'Selected context source is unavailable' },
          });
        const definition = route.request().postDataJSON().definition;
        const recipe = definition.contextRecipe;
        const profilePrompt = `# Agent profile: ${definition.name}\n${definition.instructions}`;
        if (!recipe) return route.fulfill({ json: { profilePrompt, contextResolved: false } });
        const paths =
          recipe.source === 'workspace' ? ['AGENTS.md', ...recipe.files] : ['preset-notes.md'];
        const context = {
          type: 'boot_context',
          source: 'contexgin',
          sourceCount: paths.length,
          tokenCount: 120,
          tokenBudget: recipe.source === 'workspace' ? recipe.tokenBudget : 5000,
          sources: paths.map((path: string) => ({ path, kind: 'reference' })),
          included: [],
          trimmed: [],
          fullMarkdown: '# Compiled architecture context\nUse immutable context bundles.',
        };
        return route.fulfill({
          json: {
            profilePrompt,
            assembledPrompt: `${profilePrompt}\n\n${context.fullMarkdown}`,
            contextResolved: true,
            previewScope:
              recipe.source === 'workspace' ? 'configured-workspace' : 'contexgin-preset',
            compiledContext: {
              source: recipe.source,
              compilerRevision: 'offline-fixture',
              recipeHash: 'a'.repeat(64),
              payloadHash: 'b'.repeat(64),
              ...(recipe.source === 'workspace' ? { workspaceIdentity: 'c'.repeat(64) } : {}),
              context,
            },
          },
        });
      }
      if (url.pathname === '/api/agent-library/drafts') {
        const body = route.request().postDataJSON();
        const draft: AgentLibraryDraft = {
          profileId: body.profileId,
          version: 1,
          baseRevision: body.expectedRevision,
          definition: body.definition,
        };
        catalog.drafts = [draft];
        return route.fulfill({ json: draft });
      }
      if (url.pathname === '/api/agent-library/publish') {
        const draft = catalog.drafts[0];
        const version: AgentLibraryVersion = {
          profileId: draft.profileId,
          revision: draft.baseRevision + 1,
          definition: draft.definition,
          contentHash: 'b'.repeat(64),
        };
        catalog.drafts = [];
        catalog.versions.unshift(version);
        return route.fulfill({ json: version });
      }
      if (/^\/api\/agent-library\/.+\/\d+\/export$/.test(url.pathname))
        return route.fulfill({ json: catalog.versions[0] });
      if (route.request().method() !== 'GET')
        return route.fulfill({
          status: 405,
          json: { error: 'Offline fixture: no model or runtime execution' },
        });
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/agent-library': catalog,
        '/api/config': { quickActions: [], models: [], mcpServers: [] },
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/accounts': [],
        '/api/agent-tasks': [],
        '/api/terminals/accounts': [],
        '/api/terminals/subscriptions': { enabled: false, accounts: [] },
        '/api/service-health': { services: [], checkedAt: Date.now() },
      };
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    const mime: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    try {
      return route.fulfill({
        body: await readFile(path),
        contentType: mime[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
  await page.goto('/agent-library');
  await expect(page.getByRole('heading', { name: 'Agent Library', exact: true })).toBeVisible();
  await expect(await editableProfileName(page)).toHaveValue('Bob');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The architect');
  await expect(page.getByRole('tab', { name: 'Profiles', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Tasks & schedules', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Use in Symposium/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Assign task', exact: true }).click();
  await taskAdvanced(page);
  for (const label of ['Agent profile', 'Schedule', 'Notifications']) {
    expect(
      await page
        .getByRole('combobox', { name: label, exact: true })
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(44);
  }
  await page.getByLabel('Task name', { exact: true }).fill('Retained task');
  await page
    .getByRole('textbox', { name: 'Objective', exact: true })
    .fill('Review the queue without losing this input');
  await page.getByRole('combobox', { name: 'Schedule', exact: true }).selectOption('cron');
  await page.getByLabel('Cron expression', { exact: true }).fill('');
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await page.getByRole('tab', { name: 'Tasks & schedules', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue(
    'Review the queue without losing this input',
  );
  await page.reload();
  await expect(page.getByLabel('Cron expression', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('agent-task-recovery.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('Cron expression', { exact: true }).fill('0 7 * * 1-5');
  await page.getByLabel('Timezone', { exact: true }).fill('Europe/Dublin');
  const taskSettings = page.getByRole('button', { name: /^Agent settings/ });
  await taskSettings.click();
  const taskPanel = page.getByRole('region', { name: 'Agent settings', exact: true });
  await taskPanel.getByLabel('Account', { exact: true }).selectOption('task-account');
  await taskPanel.getByLabel('Thinking level', { exact: true }).selectOption('high');
  await taskPanel.getByRole('button', { name: 'Local Mac', exact: true }).click();
  await expect(taskPanel.getByText('Runs with Mitzo Responses')).toBeVisible();
  await taskPanel.getByLabel('Model', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(taskSettings).toBeFocused();
  await taskAdvanced(page);
  await page.getByLabel('Workspace reference').fill('workspace-fixture');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Task save unavailable');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue(
    'Review the queue without losing this input',
  );
  taskSaveError = false;
  holdTaskSave = true;
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect.poll(() => !!releaseTaskSave).toBe(true);
  await page.getByRole('link', { name: isMobile ? 'More' : 'Today', exact: true }).click();
  await expect(page).toHaveURL(isMobile ? /\/more$/ : /mitzo-ui\.test\/$/);
  await expect(page.getByRole('region', { name: 'Task editor', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Task name', { exact: true })).toHaveValue('Retained task');
  await taskAdvanced(page);
  await page.getByLabel('Workspace reference').fill('workspace-after-return');
  releaseTaskSave!();
  await expect(
    page.getByText('Earlier task changes saved. Newer input is retained.'),
  ).toBeVisible();
  await taskAdvanced(page);
  await expect(page.getByLabel('Workspace reference')).toHaveValue('workspace-after-return');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByText('Task saved. Execution is not available yet.')).toBeVisible();
  await expect.poll(() => !!releaseTaskList).toBe(true);
  holdTaskSave = false;
  releaseTaskList!();
  await expect(
    page.getByRole('button', { name: 'Task settings: Other saved task', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Task settings: Retained task', exact: true }),
  ).toBeVisible();
  expect(taskWrites).toHaveLength(3);
  expect(taskWrites[1]).toEqual(taskWrites[0]);
  expect(tasks[0].definition).toMatchObject({
    profile: { profileId: 'bob', revision: 3, contentHash: 'a'.repeat(64) },
    execution: {
      account,
      model: 'luna-fixture',
      reasoningEffort: 'high',
      targetId: 'task-mac',
      harness: 'responses',
    },
    schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/Dublin', state: 'paused' },
  });
  await page.getByRole('button', { name: 'Close task editor', exact: true }).click();
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();

  // Builder entry and ordinary chat lifecycle are exercised by the actual-page
  // agent-library-builder fixture; this journey owns catalog/editor/task behavior.
  await expect(
    page.getByRole('button', { name: 'Create with Agent Builder', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent advisor', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('agent-library.png'), fullPage: true });
  await openProfileTools(page);
  await expect(page.getByText(/Legacy behavior: this profile/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose specific tools', exact: true }).click();
  await expect(page.getByText(/No optional tools selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Add tools', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search tools', exact: true }).fill('read');
  await page.getByRole('button', { name: 'Add Read', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search tools', exact: true }).fill('connection');
  await expect(page.getByText(/No active service connection is configured/)).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search tools', exact: true }).press('Escape');
  await expect(page.getByRole('button', { name: 'Add tools', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Remove Read', exact: true }).click();
  await page.getByRole('button', { name: 'Add tools', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search tools', exact: true }).fill('read');
  await page.getByRole('button', { name: 'Add Read', exact: true }).click();
  await page.getByRole('button', { name: 'Done adding tools', exact: true }).click();
  await page.getByRole('tab', { name: 'Context', exact: true }).click();
  await expect(page.getByText(/local chats and supported OpenShell sandboxes/)).toBeVisible();
  await page.getByLabel('Compile chat context').check();
  await page
    .getByRole('textbox', { name: 'Documents (one per line)', exact: true })
    .fill(' docs/architecture.md \n');
  await page.getByLabel('Token budget', { exact: true }).fill('4000');
  await page
    .getByRole('textbox', { name: 'Required sections (one per line)', exact: true })
    .fill(' docs/architecture.md \n');
  await page.getByRole('tab', { name: 'Prompt preview', exact: true }).click();
  await page.getByRole('button', { name: 'Compile preview', exact: true }).click();
  await expect(page.locator('.agent-library-prompt')).toContainText(
    'Compiled architecture context',
  );
  await expect(page.locator('.agent-library-context-preview')).toContainText(
    'configured sample workspace',
  );
  await page.getByText('Sources and trimming', { exact: true }).click();
  await expect(page.locator('.agent-library-context-preview')).toContainText(
    'docs/architecture.md',
  );
  previewError = true;
  await page.getByRole('button', { name: 'Compile preview', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Selected context source is unavailable');
  await expect(page.locator('.agent-library-prompt')).toHaveCount(0);
  previewError = false;
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await (await editableProfileName(page)).fill('Robert');
  await page.getByLabel('Descriptor').fill('The systems architect');
  await expect(page.getByRole('link', { name: 'Use in session', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: isMobile ? 'More' : 'Today', exact: true }).click();
  await page.goBack();
  await expect(await editableProfileName(page)).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  await page.reload();
  await expect(await editableProfileName(page)).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  await openProfileTools(page);
  await expect(page.getByRole('button', { name: 'Remove Read', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Use in session', exact: true })).toHaveAttribute(
    'href',
    '/chat?agentProfile=bob&profileRevision=4',
  );
  await (await editableProfileName(page)).fill('Working Robert');
  catalog.versions.unshift({
    ...catalog.versions[0],
    revision: 5,
    definition: { ...catalog.versions[0].definition, name: 'Remote Robert' },
  });
  await page.reload();
  await expect(await editableProfileName(page)).toHaveValue('Working Robert');
  await expect(await editableProfileName(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Discard unsaved edits', exact: true }).click();
  await expect(await editableProfileName(page)).toHaveValue('Remote Robert');
  catalog.versions.shift();
  await page.reload();
  await page.getByRole('button', { name: 'Export profile', exact: true }).click();
  await expect(page.getByLabel('Portable profile export')).toContainText('The systems architect');
  await expect(page.getByLabel('Portable profile export')).toContainText('contextRecipe');
  await expect(page.getByLabel('Portable profile export')).toContainText('mitzo:Read');
  await expect(page.getByLabel('Portable profile export')).not.toContainText('payloadHash');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (isMobile) {
    await expect(page.getByRole('link', { name: 'More', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.getByRole('link', { name: 'More', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Agent taskboard', exact: true })).toHaveAttribute(
      'href',
      '/tasks',
    );
    await expect(page.getByRole('link', { name: 'Agent Library', exact: true })).toHaveAttribute(
      'href',
      '/agent-library',
    );
  } else {
    await expect(page.getByRole('link', { name: 'Agents', exact: true })).toHaveAttribute(
      'href',
      '/tasks',
    );
  }
  tasks[0] = { ...tasks[0], revision: tasks[0].revision + 1 };
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
  for (const theme of ['light', 'dark']) {
    for (const [accent, font] of [
      ['lavender', 'system'],
      ['teal', 'georgia'],
    ]) {
      await page.evaluate(
        ({ theme, accent, font }) => {
          localStorage.setItem('mitzo-theme', theme);
          localStorage.setItem('mitzo-accent', accent);
          localStorage.setItem('mitzo-font', font);
        },
        { theme, accent, font },
      );
      await page.goto('/agent-library');
      await expect(await editableProfileName(page)).toHaveValue('Robert');
      await openToolLibrary(page);
      await page.getByRole('searchbox', { name: 'Search tool library', exact: true }).fill('Read');
      await page
        .getByRole('article')
        .filter({ has: page.getByRole('heading', { name: 'Read', exact: true }) })
        .locator('.tool-library-details > summary')
        .click();
      await page.getByText('Profiles using this tool', { exact: true }).click();
      await expect(page.getByRole('region', { name: 'Tool library', exact: true })).toContainText(
        'Robert',
      );
      await page.screenshot({
        path: testInfo.outputPath(`tool-library-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Agent library', exact: true }).click();
      await openProfileTools(page);
      await page.getByRole('button', { name: 'Add tools', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search tools', exact: true }).fill('Connection');
      await page.getByRole('searchbox', { name: 'Search tools', exact: true }).focus();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`agent-tools-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      await page.getByRole('searchbox', { name: 'Search tools', exact: true }).press('Escape');
      await page.getByRole('tab', { name: 'Identity', exact: true }).click();
      await page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }).click();
      await expect(page).toHaveURL(/\/chat\?/);
      const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
      await expect(composer).toHaveValue('Help me refine this agent.');
      const chatSettings = page.getByRole('button', { name: /^Workspace controls,/ });
      if ((await chatSettings.getAttribute('aria-expanded')) !== 'true') await chatSettings.click();
      const chatPanel = page.getByRole('region', { name: 'Agent settings', exact: true });
      await openChatSetting(page, 'agent');
      await expect(chatPanel.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(
        JSON.stringify(['builtin', 'mitzo-profile-builder', PROFILE_BUILDER_REVISION]),
      );
      await settingsHome(page);
      for (const field of ['Account', 'Model', 'Thinking'] as const) {
        const row = settingRow(chatPanel, field);
        await expect(row).toBeVisible();
        // Allow only subpixel arithmetic noise; retain the 44px layout target.
        expect(
          await row.evaluate((element) => (element as HTMLElement).offsetHeight),
        ).toBeGreaterThanOrEqual(44);
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 0.0001);
      }
      await chatPanel.press('Escape');
      await expect(chatSettings).toBeFocused();
      await composer.focus();
      await expect(composer).toBeFocused();
      await expect(composer).toBeInViewport();
      // The shared mobile composer has a shallow 32px text line inside its
      // rounded input surface; validate that complete surface's touch geometry.
      const composerSurface = page.locator('.chat-input-row').filter({ has: composer });
      await expect(composerSurface).toBeInViewport();
      expect((await composerSurface.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(inferenceRequests).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`agent-builder-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      await page.getByRole('link', { name: 'Open Agent Library', exact: true }).click();
      await expect(await editableProfileName(page)).toHaveValue('Robert');
      await expect(page.getByRole('region', { name: 'Agent advisor', exact: true })).toHaveCount(0);
      if (isMobile) {
        await expect(page.locator('.mobile-workspace-masthead')).toBeVisible();
        await libraryOptions(page);
        expect(
          await page
            .getByLabel('Search agents')
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(224);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .getByLabel('Agent name')
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      if (font === 'georgia')
        expect(
          await page
            .getByLabel('Agent name')
            .evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('Georgia');
      await page.getByRole('button', { name: 'Assign task', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Assign task', exact: true })).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`agent-library-${theme}-${accent}-${font}.png`),
        fullPage: true,
      });
      await page.getByRole('tab', { name: 'Tasks & schedules', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Task settings: Retained task' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Task settings: Retained task' }).click();
      if (theme === 'light' && accent === 'lavender') {
        await expect(
          page.getByText('A newer saved task revision is available. Your input is retained.'),
        ).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Objective', exact: true })).toHaveValue(
          'Review the queue without losing this input',
        );
        await page.getByRole('button', { name: 'Reload saved task', exact: true }).click();
      }

      await expect(page.getByRole('combobox', { name: 'Agent profile', exact: true })).toHaveValue(
        `bob:3:${'a'.repeat(64)}`,
      );
      await page.getByRole('button', { name: /^Agent settings/ }).click();
      const settings = page.getByRole('region', { name: 'Agent settings', exact: true });
      await expect(settings.getByLabel('Account', { exact: true })).toHaveValue('task-account');
      await expect(settings.getByLabel('Thinking level', { exact: true })).toHaveValue('high');
      await expect(
        settings.getByRole('button', { name: 'Local Mac', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await settings.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`agent-task-settings-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await settings.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: 'Close task editor', exact: true }).click();
      await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
      await editProfile(page);
      await page.getByRole('tab', { name: 'Context', exact: true }).click();
      const contextSource = page.getByRole('combobox', { name: 'Context source', exact: true });
      expect(
        await contextSource.evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await contextSource.focus();
      await expect(contextSource).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`agent-context-editor-${theme}-${accent}-${font}.png`),
        fullPage: true,
      });
      await page.getByRole('tab', { name: 'Prompt preview', exact: true }).click();
      await page.getByRole('button', { name: 'Compile preview', exact: true }).click();
      await expect(page.locator('.agent-library-prompt')).toContainText(
        'Compiled architecture context',
      );
      await page.getByText('Sources and trimming', { exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: testInfo.outputPath(`agent-context-preview-${theme}-${accent}-${font}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  // A separate published profile keeps its immutable bytes and preserves the
  // original selection retained by the ordinary Builder handoff. Published
  // state is needed here because Assign task is unavailable for dirty profiles.
  const longDefinition = {
    ...catalog.versions[0].definition,
    name: 'B'.repeat(80),
    description: 'Compare designs and document evidence. '.repeat(10),
  };
  catalog.versions.unshift({
    profileId: 'long-name-layout',
    revision: 1,
    definition: longDefinition,
    contentHash: createHash('sha256').update(JSON.stringify(longDefinition)).digest('hex'),
  });
  // Leave the retained task deep link before returning to profile layout checks.
  await page.goto('/agent-library');
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await page
    .getByRole('region', { name: 'Saved agents', exact: true })
    .getByRole('button')
    .filter({ hasText: 'B'.repeat(80) })
    .click();
  await expect(await editableProfileName(page)).toHaveValue('B'.repeat(80));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Assign task', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Assign task', exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('agent-library-large-text.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'Context', exact: true }).click();
  expect(
    await page
      .getByRole('combobox', { name: 'Context source', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('agent-context-large-text.png'),
    fullPage: true,
  });
  catalog.versions = catalog.versions.filter((version) => version.profileId !== 'long-name-layout');
  await page.reload();
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await expect(await editableProfileName(page)).toHaveValue('Robert');
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  catalogMode = 'empty';
  await page.reload();
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await expect(page.getByText('Create your first agent with Agent Builder.')).toBeVisible();
  catalogMode = 'error';
  await page.reload();
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Offline Library unavailable');
  catalogMode = 'loading';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading Agent Library' })).toHaveText(
    'Loading Agent Library…',
  );
  await expect.poll(() => typeof releaseCatalog).toBe('function');
  catalogMode = 'content';
  releaseCatalog!();
  await expect(await editableProfileName(page)).toHaveValue('Robert');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await expect(await editableProfileName(page)).toHaveValue('');
  await expect(page.getByLabel('Ask agent advisor')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Refine with Agent Builder', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('agent-creation-new.png'),
    animations: 'disabled',
  });
  await page.goto('/chat');
  const settings = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
  await openChatSetting(page, 'agent');
  const profilePicker = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(profilePicker).toBeVisible();
  await expect(profilePicker).toBeEnabled();
  const pickerGeometry = await profilePicker.evaluate((element) => ({
    layout: (element as HTMLSelectElement).offsetHeight,
    rendered: element.getBoundingClientRect().height,
  }));
  // Fractional motion offsets can yield 43.999969px for a 44px control in Chromium.
  // Require the full layout target and agreement within floating-point precision.
  expect(pickerGeometry.layout).toBeGreaterThanOrEqual(44);
  expect(pickerGeometry.rendered).toBeCloseTo(pickerGeometry.layout, 3);
  await profilePicker.focus();
  await expect(profilePicker).toBeFocused();
  expect(inferenceRequests).toEqual([]);
  expect(errors).toEqual([]);
});
