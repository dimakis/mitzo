import { disabledLocalCapabilities } from '../support/disabled-local-capabilities';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { AgentLibraryCatalog, AgentLibraryDraft, AgentLibraryVersion } from '@mitzo/protocol';

test.use({ baseURL: 'https://mitzo-ui.test' });
test('edits and publishes named agents while preserving Agents navigation', async ({
  page,
  isMobile,
}, testInfo) => {
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
  let catalogMode: 'content' | 'empty' | 'error' | 'loading' = 'content';
  let releaseCatalog: (() => void) | undefined;
  let previewError = false;
  let adviceError = false;
  let adviceCalls = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (await disabledLocalCapabilities(route, url)) return;
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
      if (url.pathname === '/api/agent-library/advice') {
        adviceCalls++;
        const body = route.request().postDataJSON();
        expect(body.accountId).toBe('work-advisor');
        expect(body.model).toBe('luna-fixture');
        expect(body.draft).toContain('Bob');
        if (adviceError)
          return route.fulfill({ status: 409, json: { error: 'Advisor unavailable' } });
        return route.fulfill({
          json: {
            text: 'Make the expected output a decision brief with evidence and tradeoffs.',
            proposal: { ...definition, name: 'Ada', descriptor: 'The research partner' },
          },
        });
      }
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
        '/api/terminals/accounts': [
          {
            id: 'work-advisor',
            label: 'Work advisor',
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        ],
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
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The architect');
  await page.getByRole('button', { name: 'Create with advisor', exact: true }).click();
  await expect(page).toHaveURL(/\/agent-library$/);
  const advisor = page.getByRole('region', { name: 'Agent advisor', exact: true });
  await expect(advisor.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
  await advisor.getByLabel('Ask agent advisor').fill('Help me refine this agent');
  await expect(advisor.getByRole('button', { name: 'Ask advisor', exact: true })).toBeDisabled();
  await advisor
    .getByRole('button', { name: 'Use Work advisor · Luna fixture', exact: true })
    .click();
  await advisor.getByRole('button', { name: 'Ask advisor', exact: true }).click();
  await expect(advisor.getByRole('log')).toContainText('decision brief with evidence');
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  await page.screenshot({
    path: testInfo.outputPath('agent-creation-advisor.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await advisor.getByRole('button', { name: 'Use suggested profile' }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Ada');
  await page.getByRole('button', { name: 'Discard unsaved edits', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Bob');
  adviceError = true;
  await advisor.getByLabel('Ask agent advisor').fill('Try another approach');
  await advisor.getByRole('button', { name: 'Ask advisor', exact: true }).click();
  await expect(advisor.getByRole('alert')).toContainText('Advisor unavailable');
  await expect(advisor.getByLabel('Ask agent advisor')).toHaveValue('Try another approach');
  await advisor.getByRole('button', { name: 'Agent advisor', exact: true }).click();
  await expect(advisor.getByLabel('Ask agent advisor')).toBeHidden();
  await advisor.getByRole('button', { name: 'Agent advisor', exact: true }).click();
  await expect(advisor.getByLabel('Ask agent advisor')).toHaveValue('Try another approach');
  await advisor.getByRole('button', { name: 'Agent advisor', exact: true }).click();
  expect(adviceCalls).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('agent-library.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
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
  await page.getByLabel('Agent name').fill('Robert');
  await page.getByLabel('Descriptor').fill('The systems architect');
  await expect(page.getByRole('link', { name: 'Use in chat', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: isMobile ? 'More' : 'Today', exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await expect(page.getByLabel('Descriptor')).toHaveValue('The systems architect');
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Read', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Identity', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Use in chat', exact: true })).toHaveAttribute(
    'href',
    '/chat?agentProfile=bob&profileRevision=4',
  );
  await page.getByLabel('Agent name').fill('Working Robert');
  catalog.versions.unshift({
    ...catalog.versions[0],
    revision: 5,
    definition: { ...catalog.versions[0].definition, name: 'Remote Robert' },
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('Working Robert');
  await expect(page.getByLabel('Agent name')).toBeEnabled();
  await page.getByRole('button', { name: 'Discard unsaved edits', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('Remote Robert');
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
      await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
      await page.getByRole('button', { name: 'Tool library', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search tool library', exact: true }).fill('Read');
      await page.getByText('Profiles using this tool', { exact: true }).click();
      await expect(page.getByRole('region', { name: 'Tool library', exact: true })).toContainText(
        'Robert',
      );
      await page.screenshot({
        path: testInfo.outputPath(`tool-library-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Agent library', exact: true }).click();
      await page.getByRole('tab', { name: 'Tools', exact: true }).click();
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
      await page.getByRole('button', { name: 'Create with advisor', exact: true }).click();
      await expect(page.getByLabel('Ask agent advisor')).toBeVisible();
      await page.getByLabel('Ask agent advisor').focus();
      await expect(page.getByLabel('Ask agent advisor')).toBeFocused();
      const advisorBounds = await page.locator('.agent-creation-advisor').boundingBox();
      const editorBounds = await page.locator('.agent-library-detail').boundingBox();
      expect(advisorBounds!.y + advisorBounds!.height).toBeLessThanOrEqual(editorBounds!.y + 1);
      await page
        .locator('.agent-creation-advisor')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({
        path: testInfo.outputPath(`agent-advisor-${theme}-${accent}-${font}.png`),
        animations: 'disabled',
      });
      if (isMobile) {
        await expect(page.locator('.mobile-workspace-masthead')).toBeVisible();
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
      await page
        .getByRole('button', { name: 'Use as reviewer', exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole('button', { name: 'Use as reviewer', exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`agent-library-${theme}-${accent}-${font}.png`),
        fullPage: true,
      });
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
  const savedIdentity = {
    name: catalog.versions[0].definition.name,
    description: catalog.versions[0].definition.description,
  };
  catalog.versions[0].definition.name = 'B'.repeat(80);
  catalog.versions[0].definition.description = 'Compare designs and document evidence. '.repeat(10);
  await page.reload();
  await expect(page.getByLabel('Agent name')).toHaveValue('B'.repeat(80));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Use as reviewer', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Use as reviewer', exact: true })).toBeInViewport();
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
  Object.assign(catalog.versions[0].definition, savedIdentity);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
  });
  catalogMode = 'empty';
  await page.reload();
  await expect(page.getByText('Create your first agent, or start with the advisor.')).toBeVisible();
  catalogMode = 'error';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Offline Library unavailable');
  catalogMode = 'loading';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status').filter({ hasText: 'Loading Agent Library' })).toHaveText(
    'Loading Agent Library…',
  );
  await expect.poll(() => typeof releaseCatalog).toBe('function');
  catalogMode = 'content';
  releaseCatalog!();
  await expect(page.getByLabel('Agent name')).toHaveValue('Robert');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  await expect(page.getByLabel('Agent name')).toHaveValue('');
  await expect(page.getByLabel('Ask agent advisor')).toBeVisible();
  await page
    .locator('.agent-creation-advisor')
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: testInfo.outputPath('agent-creation-new.png'),
    animations: 'disabled',
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.goto('/chat');
  const settings = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await settings.getAttribute('aria-expanded')) !== 'true') await settings.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
  const profilePicker = page.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(profilePicker).toBeVisible();
  await expect(profilePicker).toBeEnabled();
  expect(
    await profilePicker.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await profilePicker.focus();
  await expect(profilePicker).toBeFocused();
  expect(errors).toEqual([]);
});
