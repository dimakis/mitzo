import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

// Serve the real production build, but intercept every transport: these checks
// never start a backend, deploy Mitzo, or call a provider/model.
test.use({ baseURL: 'https://mitzo-ui.test' });
const message = 'What is the story with my morning briefing? We need to fix it';
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const account = {
  id: 'work-account',
  label: 'Work OpenAI API',
  models: [
    {
      id: 'luna-fixture',
      label: 'Luna fixture',
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'luna-alternate',
      label: 'Luna alternate fixture',
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'low',
    },
  ],
};
function savedDraft(id = 'briefing-draft', text = message) {
  return {
    version: 1,
    id,
    text,
    images: [{ data: image, preview: `data:image/png;base64,${image}`, mediaType: 'image/png' }],
    contextBlocks: ['Review guidance'],
    updatedAt: 1791792000000,
    settings: {
      selection: { accountId: account.id, model: 'luna-alternate', reasoningEffort: 'high' },
      mode: 'ask',
      isolation: false,
      search: 'cwd=%2Fworkspace&extraTools=Files',
      summary: {
        profile: account.label,
        model: 'Luna alternate fixture',
        thinking: 'Thinking: high',
      },
    },
  };
}
async function seed(page: Page, values: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem('draft-fixture-seeded')) return;
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    sessionStorage.setItem('draft-fixture-seeded', '1');
  }, values);
}
async function offline(page: Page) {
  const errors: string[] = [];
  const mutations: string[] = [];
  let state: 'current' | 'available' | 'error' | 'loading' = 'available';
  let configured = true;
  let release: (() => void) | undefined;
  let checkFailed = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('mitzo:transport', 'ws');
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.cssText = 'height:100dvh;overflow:hidden';
    });
  });
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/version/check' && route.request().method() === 'POST') {
        mutations.push(url.pathname);
        return route.fulfill({
          status: checkFailed ? 503 : 200,
          json: checkFailed ? { error: 'Offline check failed' } : { updateAvailable: false },
        });
      }
      if (route.request().method() !== 'GET') {
        mutations.push(url.pathname);
        return route.fulfill({
          status: 405,
          json: { error: 'Offline fixture prohibits provider execution' },
        });
      }
      if (url.pathname === '/api/version') {
        if (state === 'loading')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return route.fulfill({
          status: state === 'error' ? 503 : 200,
          json:
            state === 'error'
              ? { error: 'Offline unavailable' }
              : {
                  updateAvailable: state === 'available',
                  commit: 'a'.repeat(40),
                  hash: 'offline-build',
                },
        });
      }
      if (url.pathname.endsWith('/events'))
        return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
      const fixtures: Record<string, unknown> = {
        '/api/auth/check': { authenticated: true },
        '/api/config': {
          quickActions: configured
            ? [
                {
                  label: 'Deploy Mitzo',
                  prompt: 'Review the accepted update before applying it',
                  cwd: '/workspace',
                  extraTools: 'Files',
                },
              ]
            : [],
          contextBlocks: { 'Review guidance': { path: '/workspace/review.md', sizeBytes: 400 } },
          models: [],
          mcpServers: [],
        },
        '/api/accounts': [
          { ...account, id: 'personal-account', label: 'Personal OpenAI API' },
          account,
        ],
        '/api/skills': [],
        '/api/agent-library': { drafts: [], versions: [] },
        '/api/repository-workspaces/catalog': { available: true, repositories: [] },
        '/api/sessions': { sessions: [], hasMore: false },
        '/api/notifications': { items: [], needsYou: 0, unread: 0, total: 0, hasMore: false },
        '/api/service-health': { services: [], checkedAt: Date.now() },
        '/api/home/preferences': {
          revision: 1,
          showDailyQuote: false,
          names: { briefing: 'Jeeves', terminal: 'Minion' },
          pins: [],
        },
        '/api/git/info': { branch: 'main', repoPath: '/workspace', worktrees: [] },
      };
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    }
    const root = resolve('frontend/dist');
    const path = resolve(
      root,
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html',
    );
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
  return {
    errors,
    mutations,
    state: (next: typeof state) => {
      state = next;
    },
    configured: (next: boolean) => {
      configured = next;
    },
    failCheck: () => {
      checkFailed = true;
    },
    release: () => release,
  };
}
async function workspace(page: Page) {
  const toggle = page.getByRole('button', { name: /^Workspace controls/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('drafts: Chats has a dedicated Drafts destination and New chat opens blank', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page);
  await seed(page, {
    'mitzo-chat-draft:briefing-draft': JSON.stringify(savedDraft()),
    'mitzo-theme': 'dark',
    'mitzo-accent': 'mint',
    'mitzo-font': 'georgia',
  });
  await page.goto('/sessions');
  await expect(page.getByRole('link', { name: /Drafts/ })).toBeVisible();
  await expect(page.getByText(/Update available.*Deploy Mitzo/)).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('chats-drafts-shortcut.png'),
    animations: 'disabled',
  });
  await page.getByRole('link', { name: /Drafts/ }).click();
  await expect(page.getByRole('heading', { name: /^Drafts(?: \d+)?$/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /What is the story with my morning briefing/ }),
  ).toContainText('Thinking: high');
  await page.getByRole('link', { name: /New chat/, exact: false }).click();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue('');
  expect(fixture.mutations).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('drafts: restore all settings, attachments and context, edit, leave, and reopen', async ({
  page,
  isMobile,
}, testInfo) => {
  const fixture = await offline(page);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  await seed(page, { 'mitzo-chat-draft:briefing-draft': JSON.stringify(savedDraft()) });
  await page.goto('/sessions/drafts');
  await page.getByRole('link', { name: /What is the story with my morning briefing/ }).click();
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  await expect(input).toHaveValue(message);
  await workspace(page);
  await expect(page.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue(
    account.id,
  );
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'luna-alternate',
  );
  await expect(page.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue('high');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByAltText('Attachment 1')).toBeVisible();
  await input.fill('Fix the morning briefing with this saved context');
  await page.getByRole('combobox', { name: 'Thinking', exact: true }).selectOption('low');
  await expect
    .poll(async () =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('mitzo-chat-draft:briefing-draft') || '{}'),
      ),
    )
    .toMatchObject({
      text: 'Fix the morning briefing with this saved context',
      settings: { selection: { reasoningEffort: 'low' }, isolation: false, mode: 'ask' },
      contextBlocks: ['Review guidance'],
      images: [expect.objectContaining({ mediaType: 'image/png' })],
    });
  await input.focus();
  await expect(input).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('draft-restored-editable.png'),
    animations: 'disabled',
  });
  await page.goto('/sessions/drafts');
  await page
    .getByRole('link', { name: /Fix the morning briefing with this saved context/ })
    .click();
  await expect(input).toHaveValue('Fix the morning briefing with this saved context');
  await workspace(page);
  await expect(page.getByRole('combobox', { name: 'Thinking', exact: true })).toHaveValue('low');
  await expect(page.getByAltText('Attachment 1')).toBeVisible();
  await layout(page);
  expect(fixture.mutations).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('drafts: unsent new input saves separately and legacy input migrates without capturing New chat', async ({
  page,
}) => {
  const fixture = await offline(page);
  await seed(page, {
    'mitzo-draft-new': 'Existing legacy briefing draft',
    'mitzo-default-account-model': JSON.stringify({
      accountId: account.id,
      model: 'luna-fixture',
      reasoningEffort: 'medium',
    }),
  });
  await page.goto('/chat');
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  await expect(input).toHaveValue('');
  await input.fill('A separate new message');
  await page.goto('/sessions/drafts');
  await expect(page.getByRole('link', { name: /Existing legacy briefing draft/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /A separate new message/ })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mitzo-draft-new'))).toBeNull();
  await page.getByRole('link', { name: /New chat/ }).click();
  await expect(input).toHaveValue('');
  expect(fixture.mutations).toEqual([]);
});

test('drafts: discard is labelled, cancellable with focus restored, and missing links explain recovery', async ({
  page,
}) => {
  const fixture = await offline(page);
  await seed(page, { 'mitzo-chat-draft:briefing-draft': JSON.stringify(savedDraft()) });
  await page.goto('/sessions/drafts');
  const discard = page.getByRole('button', { name: 'Discard draft', exact: true });
  await discard.click();
  await expect(page.getByRole('dialog', { name: 'Discard this draft?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(discard).toBeFocused();
  await discard.click();
  await page.getByRole('button', { name: 'Keep draft' }).click();
  await expect(discard).toBeFocused();
  await discard.click();
  await page.getByRole('button', { name: 'Confirm discard' }).click();
  await expect(page.getByText('No drafts yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  await page.goto('/chat?draft=briefing-draft');
  await expect(page.getByRole('alert')).toContainText(
    /draft.*(unavailable|found|available|missing)/i,
  );
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  for (const selection of [
    { accountId: 'removed-account', model: 'luna-fixture', reasoningEffort: 'medium' },
    { accountId: account.id, model: 'removed-model', reasoningEffort: 'medium' },
  ]) {
    const draft = savedDraft('unavailable-reference');
    draft.settings.selection = selection;
    await page.evaluate(
      (draft) =>
        localStorage.setItem('mitzo-chat-draft:unavailable-reference', JSON.stringify(draft)),
      draft,
    );
    await page.goto('/chat?draft=unavailable-reference');
    await workspace(page);
    await expect(page.getByRole('alert')).toContainText('Selected account or model is unavailable');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('mitzo-chat-draft:unavailable-reference')!).settings
            .selection,
      ),
    ).toEqual(selection);
  }
  expect(fixture.mutations).toEqual([]);
});

test('updates: Settings owns available/current/loading/error/missing-action states without automatic deployment', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: /Updates/ }).click();
  await expect(page.getByRole('heading', { name: 'A new Mitzo is ready' })).toBeVisible();
  const review = page.getByRole('link', { name: 'Review update' });
  const url = new URL((await review.getAttribute('href'))!, 'https://mitzo-ui.test');
  expect(url.pathname).toBe('/chat');
  expect(url.searchParams.get('prompt')).toBe('Review the accepted update before applying it');
  expect(url.searchParams.get('cwd')).toBe('/workspace');
  expect(url.searchParams.get('extraTools')).toBe('Files');
  expect(fixture.mutations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('updates-available.png'),
    animations: 'disabled',
  });
  await review.click();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(
    'Review the accepted update before applying it',
  );
  // Let the new chat's account-bound catalog finish before leaving. Safari
  // reports an intercepted request aborted during navigation as a page error.
  await expect(
    page.getByText('Assign a GitHub connection with repository access to this AI account in'),
  ).toBeVisible();
  expect(fixture.mutations).toEqual([]);
  await page.goto('/settings/updates');
  await expect(page.getByRole('heading', { name: 'A new Mitzo is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('heading', { name: 'You’re up to date' })).toBeVisible();
  fixture.failCheck();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t check for updates');
  fixture.configured(false);
  await page.reload();
  await expect(
    page.getByText('An update action hasn’t been configured for this installation.'),
  ).toBeVisible();
  await expect(review).toBeHidden();
  fixture.state('error');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Couldn’t load update information');
  fixture.state('loading');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Loading update information…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('updates-loading.png'),
    animations: 'disabled',
  });
  await expect.poll(() => typeof fixture.release()).toBe('function');
  fixture.state('current');
  fixture.release()!();
  await expect(page.getByRole('heading', { name: 'You’re up to date' })).toBeVisible();
  expect(fixture.mutations).toEqual(['/api/version/check', '/api/version/check']);
  expect(fixture.errors).toEqual([]);
});

test('drafts and updates: narrow/mobile and desktop appearance, scrolling and keyboard targets', async ({
  page,
  isMobile,
}, testInfo) => {
  const fixture = await offline(page);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 844 });
  const drafts = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `mitzo-chat-draft:appearance-${index}`,
      JSON.stringify({
        ...savedDraft(
          `appearance-${index}`,
          index
            ? `Saved planning message ${index}`
            : `${message} with a long title for narrow displays`,
        ),
        updatedAt: 1791792000000 - index * 1000,
      }),
    ]),
  );
  await seed(page, drafts);
  for (const [theme, accent, font] of [
    ['dark', 'mint', 'georgia'],
    ['light', 'teal', 'system'],
  ]) {
    await page.goto('/sessions/drafts');
    await page.evaluate(
      ({ theme, accent, font }) => {
        localStorage.setItem('mitzo-theme', theme);
        localStorage.setItem('mitzo-accent', accent);
        localStorage.setItem('mitzo-font', font);
      },
      { theme, accent, font },
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Drafts(?: \d+)?$/ })).toBeVisible();
    await layout(page);
    const first = page.locator('.saved-draft-open').first();
    await first.focus();
    await page.keyboard.press('Tab');
    // Mobile WebKit follows Safari's link-tab preference; establish keyboard
    // modality, then inspect the focused link's visible shared outline.
    await first.focus();
    await expect(first).toBeFocused();
    expect(await first.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );
    await page.screenshot({
      path: testInfo.outputPath(`drafts-${theme}-${accent}-${font}.png`),
      animations: 'disabled',
    });
    const discard = page.getByRole('button', { name: 'Discard draft', exact: true }).last();
    await discard.scrollIntoViewIfNeeded();
    await expect(discard).toBeInViewport();
    expect((await discard.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`drafts-final-item-${theme}.png`),
      animations: 'disabled',
    });
    await page.goto('/settings/updates');
    await expect(page.getByRole('heading', { name: 'A new Mitzo is ready' })).toBeVisible();
    const check = page.getByRole('button', { name: 'Check for updates' });
    await check.scrollIntoViewIfNeeded();
    await check.focus();
    await expect(check).toBeFocused();
    expect((await check.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await layout(page);
    await page.screenshot({
      path: testInfo.outputPath(`updates-${theme}-${accent}-${font}.png`),
      animations: 'disabled',
    });
    await page.locator('.updates-page').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({
      path: testInfo.outputPath(`updates-top-${theme}-${accent}-${font}.png`),
      animations: 'disabled',
    });
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  await layout(page);
  const largeCheck = page.getByRole('button', { name: 'Check for updates' });
  await largeCheck.scrollIntoViewIfNeeded();
  await expect(largeCheck).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('updates-large-text.png'),
    animations: 'disabled',
  });
  expect(fixture.errors).toEqual([]);
});

test('drafts: clearing text removes stale draft and prompt URLs while leaving the composer editable after reload', async ({
  page,
}) => {
  const fixture = await offline(page);
  const draft = {
    ...savedDraft('cleared-draft', 'A text-only draft'),
    images: [],
    contextBlocks: [],
  };
  await seed(page, { 'mitzo-chat-draft:cleared-draft': JSON.stringify(draft) });
  await page.goto('/chat?draft=cleared-draft&prompt=Original%20launch%20prompt');
  const input = page.getByRole('textbox', { name: 'Message Mitzo' });
  await expect(input).toHaveValue('A text-only draft');
  await expect(
    page.getByText('Assign a GitHub connection with repository access to this AI account in'),
  ).toBeVisible();
  await input.fill('');
  await expect.poll(() => new URL(page.url()).searchParams.get('draft')).toBeNull();
  expect(new URL(page.url()).searchParams.get('prompt')).toBeNull();
  expect(new URL(page.url()).searchParams.get('cwd')).toBe('/workspace');
  expect(new URL(page.url()).searchParams.get('extraTools')).toBe('Files');
  await input.fill('Refill the same editable draft');
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('mitzo-chat-draft:cleared-draft') || '{}'),
      ),
    )
    .toMatchObject({
      text: 'Refill the same editable draft',
      settings: { selection: draft.settings.selection, mode: 'ask', isolation: false },
    });
  await input.fill('');
  await expect.poll(() => new URL(page.url()).searchParams.get('draft')).toBeNull();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mitzo-chat-draft:cleared-draft')))
    .toBeNull();
  await page.reload();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await input.fill('A new editable message after reload');
  await expect(input).toHaveValue('A new editable message after reload');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith('mitzo-chat-draft:'))
            .map((key) => JSON.parse(localStorage.getItem(key)!))
            .filter((draft) => draft.text === 'A new editable message after reload').length,
      ),
    )
    .toBe(1);
  expect(fixture.mutations).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('drafts: preparation-only receipts survive reopen and failed cleanup, then discard only after server confirmation', async ({
  page,
}, testInfo) => {
  const fixture = await offline(page);
  const preparationId = '11111111-1111-4111-8111-111111111111';
  const base = savedDraft('preparation-only', '');
  const draft = {
    ...base,
    images: [],
    contextBlocks: [],
    settings: { ...base.settings, repositoryWorkspaceId: preparationId },
  };
  const receipt = {
    id: preparationId,
    repository: 'offline/mitzo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'draft/briefing',
    state: 'ready',
  };
  let allowDiscard = false;
  let holdDiscard = false;
  let releaseDiscard: (() => void) | undefined;
  const deletes: string[] = [];
  await page.route(`**/api/repository-workspaces/${preparationId}*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('accountId')).toBe(account.id);
    expect(url.searchParams.get('model')).toBe('luna-alternate');
    if (route.request().method() === 'GET') return route.fulfill({ json: receipt });
    if (route.request().method() === 'DELETE') {
      deletes.push(url.pathname);
      if (holdDiscard)
        await new Promise<void>((resolve) => {
          releaseDiscard = resolve;
        });
      return route.fulfill({
        status: allowDiscard ? 200 : 503,
        json: allowDiscard
          ? { discarded: true }
          : { error: 'Offline cleanup temporarily unavailable' },
      });
    }
    return route.fulfill({
      status: 405,
      json: { error: 'No repository execution in offline fixture' },
    });
  });
  await seed(page, { 'mitzo-chat-draft:preparation-only': JSON.stringify(draft) });
  await page.goto('/sessions/drafts');
  await page.getByRole('link', { name: /Untitled draft/ }).click();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue('');
  await expect(page.getByText('draft/briefing', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('mitzo-chat-draft:preparation-only') || '{}').settings
            ?.repositoryWorkspaceId,
      ),
    )
    .toBe(preparationId);
  await page.reload();
  await expect(page.getByText('draft/briefing', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('mitzo-chat-draft:preparation-only') || '{}'),
      ),
    )
    .toMatchObject({
      text: '',
      settings: { repositoryWorkspaceId: preparationId, selection: draft.settings.selection },
    });
  await page.goto('/sessions/drafts');
  await expect(page.getByText('Repository preparation saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('link', { name: /Untitled draft/ })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('mitzo-chat-draft:preparation-only')),
  ).not.toBeNull();
  await page.screenshot({
    path: testInfo.outputPath('repository-draft-cleanup-retry.png'),
    animations: 'disabled',
  });
  allowDiscard = true;
  holdDiscard = true;
  const confirm = page.getByRole('button', { name: 'Confirm discard', exact: true });
  if (!(await confirm.isVisible()))
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await confirm.click();
  await expect(page.getByRole('button', { name: 'Discarding…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Keep draft', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Discard this draft?' })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('repository-draft-cleanup-pending.png'),
    animations: 'disabled',
  });
  await expect.poll(() => typeof releaseDiscard).toBe('function');
  releaseDiscard!();
  await expect(page.getByText('No drafts yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  expect(
    await page.evaluate(() => localStorage.getItem('mitzo-chat-draft:preparation-only')),
  ).toBeNull();
  expect(deletes).toEqual([
    `/api/repository-workspaces/${preparationId}`,
    `/api/repository-workspaces/${preparationId}`,
  ]);
  expect(fixture.mutations).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
