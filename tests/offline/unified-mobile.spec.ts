import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import {
  symposiumMessages,
  symposiumPerspective,
  symposiumStatus,
} from '../../frontend/src/preview/symposium-fixtures';

const outcomes = Array.from({ length: 12 }, (_, index) => ({
  id: `outcome-${index}`,
  summary:
    index === 0
      ? 'Prepare the quarterly planning review and bring together the latest decisions, priorities and context for the team'
      : `Outcome ${index + 1}`,
  intent: 'Bring the decisions and their context into one clear next step.',
  profile: 'work',
  urgency: 0.6,
  starred: index < 2,
  status: 'active',
  ageDays: 2,
  parentId: null,
  children: [],
  childCount: 0,
  completedChildCount: 0,
  sources: [],
  links: [],
  goalId: null,
  contextHints: {
    repos: [],
    paths: [],
    issues: [],
    docIds: [],
    people: [],
    jiraKeys: [],
    keywords: [],
    taskHint: '',
  },
}));
const proposals = Array.from({ length: 12 }, (_, index) => ({
  filename: `proposal-${index}.md`,
  agent: index % 2 ? 'planner' : 'dream_detector',
  title:
    index === 0
      ? '[cross-reference] planning.py ↔ Quarterly planning decisions and follow-up context.md'
      : `Proposal ${index + 1}`,
  timestamp: '2026-10-09T12:00:00Z',
  tags: ['planning', 'memory', 'follow-up'],
  preview: 'Bring related decisions together so the next review starts with the right context.',
}));
const sessions = Array.from({ length: 14 }, (_, index) => ({
  id: `session-${index}`,
  summary:
    ['Quarterly planning review', 'Explore the product direction', 'Follow up on team priorities'][
      index % 3
    ] + ` ${index + 1}`,
  lastModified: Date.now() - index * 3600000,
  totalTokens: 0,
  isActive: false,
  isAttached: false,
}));
const account = {
  id: 'work-account',
  kind: 'ai-account',
  section: 'ai-accounts',
  provider: 'openai',
  revision: 1,
  label: 'Work OpenAI',
  owner: 'accounts',
  gateway: 'primary',
  workspace: null,
  nativeId: 'work',
  status: 'configured',
  accountIdentity: null,
  verification: { state: 'unverified', verifiedAt: null, reason: null },
  access: {
    summary: 'Choose inside a chat',
    desiredAccountIds: [],
    observedAttachments: null,
    appliesTo: 'New conversations',
  },
  actions: [{ id: 'manage', label: 'Manage', href: '/connections' }],
  details: {},
};
const knowledgeDocuments = Array.from({ length: 40 }, (_, index) => ({
  path: `hub/context/document-${String(index + 1).padStart(2, '0')}.md`,
  title: `Knowledge document ${index + 1}`,
  area: 'Hub',
}));
const fixtures: Record<string, unknown> = {
  '/api/auth/check': { authenticated: true },
  '/api/sessions': sessions,
  '/api/config': { quickActions: [] },
  '/api/version': { updateAvailable: false },
  '/api/todos': { profiles: ['manual', 'personal', 'work'], items: outcomes },
  '/api/tasks': [],
  '/api/inbox': proposals,
  '/api/briefings/latest': {
    date: '2026-10-10',
    generatedAt: '2026-10-10T07:00:00Z',
    path: '/workspace/report.md',
  },
  '/api/home/preferences': {
    revision: 1,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
    pins: [{ kind: 'session', id: 'session-0', title: 'Quarterly planning review' }],
  },
  '/api/home/briefing-chats': [],
  '/api/accounts': [
    {
      id: 'work-account',
      label: 'Work OpenAI',
      models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
    },
  ],
  '/api/service-health': { services: [], checkedAt: Date.now() },
  '/api/notifications': {
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `notification-${index}`,
      kind: 'session',
      title: `Session update ${index + 1}`,
      body:
        index === 0
          ? 'The selected account’s project is unavailable or archived. Check its project configuration before starting a new turn.'
          : 'Agent finished its turn.',
      createdAt: Date.now() - index * 3600000,
      readAt: Date.now(),
    })),
    needsYou: 0,
    unread: 0,
    total: 12,
    hasMore: false,
    preferences: {
      approvals: true,
      questions: true,
      completion: 'unattended',
      quietHours: false,
      quietStart: '22:00',
      quietEnd: '08:00',
      timezone: 'UTC',
      sensitivePreviews: false,
    },
    delivery: { configured: false, registeredDevices: 0 },
  },
  '/api/connections-access': { generatedAt: Date.now(), sources: [], resources: [account] },
  '/api/git/info': { branch: 'main', repoPath: '/workspace', worktrees: [] },
  '/api/files/roots': [],
  '/api/files': {
    dir: '/workspace',
    root: '/workspace',
    entries: Array.from({ length: 40 }, (_, index) => ({
      name: `Report ${index + 1}.md`,
      isDir: false,
    })),
  },
  '/api/files/read': {
    path: '/workspace/report.md',
    ext: '.md',
    content: '# Report\n\nFull document context.',
  },
  '/api/knowledge': {
    revision: 'fixture-revision',
    documents: knowledgeDocuments,
    directories: ['hub', 'hub/context'],
    documentPaths: ['hub'],
    drafts: [],
    reviewEnabled: false,
    acceptanceEnabled: false,
    syncedAt: null,
  },
};

const iconTasks = (
  ['pending', 'active', 'done', 'pending_review', 'blocked', 'skipped', 'failed'] as const
).map((status, index) => ({
  id: `icon-task-${status}`,
  parentId: null,
  title: `Icon check: ${status.replaceAll('_', ' ')}`,
  description: null,
  status,
  sessionId: null,
  sessionPolicy: 'auto',
  priority: index,
  depth: 0,
  annotations: [],
  summary: null,
  requiresApproval: false,
  tokenUsage: 0,
  claimedBy: null,
  claimedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  completedAt: null,
  stageType: null,
  gateConfig: null,
  artifacts: null,
  retryCount: 0,
  maxRetries: 0,
  templateId: null,
  children: [],
}));

for (const appearance of [
  { theme: 'dark', accent: 'lavender', font: 'system' },
  { theme: 'light', accent: 'mint', font: 'georgia' },
]) {
  test(`outline icons keep their meaning and geometry with ${appearance.theme}/${appearance.font}`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript((selection) => {
      localStorage.setItem('mitzo-theme', selection.theme);
      localStorage.setItem('mitzo-accent', selection.accent);
      localStorage.setItem('mitzo-font', selection.font);
    }, appearance);
    if (testInfo.project.name.startsWith('mobile')) {
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 320, height: viewport.height });
    }
    await page.goto('/settings');
    const backups = page.getByRole('link', { name: 'Backups', exact: true });
    await expect(backups).toHaveText('Backups');
    await expect(backups.locator('svg[data-icon="forward"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await backups.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`icons-settings-${appearance.theme}.png`),
      animations: 'disabled',
    });

    await page.route('**/api/tasks', (route) => route.fulfill({ json: iconTasks }));
    await page.goto('/tasks');
    const spawning = page.getByRole('switch', { name: /session spawning/ });
    await expect(spawning).toHaveAttribute('aria-checked', 'false');
    await expect(spawning.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await page.getByRole('button', { name: 'Show tree order', exact: true }).click();
    const actions = page.locator('.page-header-actions');
    await expect(actions).toBeVisible();
    const actionBounds = await actions.boundingBox();
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    if (testInfo.project.name === 'desktop-chromium') {
      await page.getByRole('button', { name: 'Tree and attention', exact: true }).click();
    }
    for (const [status, icon] of Object.entries({
      pending: 'circle',
      active: 'running',
      done: 'complete',
      pending_review: 'review',
      blocked: 'unavailable',
      skipped: 'minus',
      failed: 'failed',
    })) {
      const control = page.getByRole('button', { name: `Status: ${status}`, exact: true });
      await expect(control.locator(`svg[data-icon="${icon}"]`)).toHaveCount(1);
      await expect(control).toHaveText('');
    }
    await page.screenshot({
      path: testInfo.outputPath(`icons-taskboard-${appearance.theme}.png`),
      animations: 'disabled',
    });
    if (testInfo.project.name.startsWith('mobile')) {
      const size = await spawning.boundingBox();
      expect(size?.height).toBeGreaterThanOrEqual(44);
      expect(size?.width).toBeGreaterThanOrEqual(44);
      const review = page.locator('.task-node--status-pending_review .task-node-body').first();
      expect((await review.boundingBox())!.width).toBeGreaterThanOrEqual(140);
      await expect(
        page.locator('.task-node--status-pending_review .task-node-actions').first(),
      ).toHaveCSS('opacity', '1');
    }

    await page.goto('/connections-access');
    await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
    await expect(page.locator('.access-row-icon')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`icons-connections-${appearance.theme}.png`),
      animations: 'disabled',
    });
  });
}
const mime: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mitzo-theme', 'dark');
    localStorage.setItem('mitzo:transport', 'ws');
    // Match the native application's bounded viewport without native APIs.
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
      // No app mutation or model request can leave this fixture suite.
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 405, json: { error: 'Offline UI test' } });
      if (url.pathname === '/api/knowledge/document') {
        const document = knowledgeDocuments.find(
          (item) => item.path === url.searchParams.get('path'),
        );
        if (!document)
          return route.fulfill({ status: 404, json: { error: 'Unknown fixture document' } });
        return route.fulfill({
          json: {
            path: document.path,
            revision: 'fixture-revision',
            content: `# ${document.title}\n\nAccepted library context.`,
          },
        });
      }
      if (url.pathname === '/api/calendar') {
        const base = url.searchParams.get('date')!;
        const days = Number(url.searchParams.get('days'));
        return route.fulfill({
          json: {
            startDate: base,
            endDate: base,
            events: Array.from({ length: days === 1 ? 12 : 18 }, (_, index) => {
              const date = new Date(base + 'T10:00:00Z');
              date.setUTCDate(date.getUTCDate() + (index < 12 ? 0 : index - 11));
              if (index < 12) date.setUTCMinutes(index * 30);
              const start = date.toISOString();
              const end = new Date(date.getTime() + 30 * 60000).toISOString();
              return {
                id: `event-${index}`,
                type: index === 17 ? 'milestone' : 'meeting',
                title:
                  index === 0
                    ? 'Planning review with a long meeting title and team context'
                    : `Meeting ${index + 1}`,
                start,
                end,
                allDay: index === 17,
                attendeeCount: 3,
                location: 'Studio',
                hangoutLink: 'https://meet.example.com/review',
              };
            }),
            sprints: [
              { id: 'sprint', title: 'Sprint 2026-20 (estimated)', start: base, end: base },
            ],
          },
        });
      }
      if (url.pathname.startsWith('/api/inbox/'))
        return route.fulfill({
          json: {
            content:
              '# Full proposal context\n\nReview the original evidence before deciding on the next step.',
          },
        });
      if (url.pathname === '/api/home/quote')
        return route.fulfill({
          json: {
            date: url.searchParams.get('date'),
            quote: JSON.parse(await readFile(resolve('content/quotes/catalog.json'), 'utf8'))[0],
          },
        });
      if (url.pathname === '/api/home/briefing')
        return route.fulfill({
          json: {
            date: url.searchParams.get('date'),
            filename: 'report.md',
            path: '/workspace/report.md',
            revision: 'a'.repeat(64),
            generatedAt: '2026-10-10T07:00:00Z',
            content:
              '# Morning briefing\n\n## Calendar updates\n\nA meeting moved to 10:00.\n\n' +
              Array.from(
                { length: 10 },
                (_, index) =>
                  `## ${9 + index}:00 Meeting ${index + 1}\n\nAgenda ${index + 1}.\n\n### Jira context\n\nSupporting issue ${index + 1}.\n`,
              ).join('\n'),
          },
        });
      if (url.pathname === '/api/files/read' && url.searchParams.get('path')?.endsWith('.html'))
        return route.fulfill({
          json: {
            path: '/workspace/preview.html',
            ext: '.html',
            content: '<h1>HTML artifact</h1>',
          },
        });
      return route.fulfill({ json: url.pathname in fixtures ? fixtures[url.pathname] : {} });
    }
    const file =
      url.pathname.startsWith('/assets/') || extname(url.pathname)
        ? url.pathname.slice(1)
        : 'index.html';
    const root = resolve('frontend/dist');
    const path = resolve(root, file);
    if (!path.startsWith(root + '/')) return route.abort();
    try {
      return route.fulfill({
        body: await readFile(path),
        contentType: mime[extname(path)] ?? 'application/octet-stream',
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Missing offline asset' });
    }
  });
});

const routes = ['/', '/sessions', '/inbox', '/todos', '/more', '/connections-access', '/knowledge'];
const todayDetailRoutes = ['/briefings/2026-10-10', '/quotes/2026-10-10'];

test('every mobile collection keeps one wordmark, one palette and reachable navigation', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile, 'Mobile shell');
  for (const width of [320, 390, 440]) {
    await page.setViewportSize({ width, height: 844 });
    let reference: unknown;
    for (const route of [...routes, ...todayDetailRoutes]) {
      await page.goto(route);
      await expect(page.locator('h1').first()).toBeVisible();
      const brand = page.getByRole('link', { name: 'Mitzo home' });
      await expect(brand).toBeVisible();
      await brand.click({ trial: true });
      const pageTop = await page.locator('.mobile-workspace-body > *').first().boundingBox();
      const masthead = (await page.locator('.mobile-workspace-masthead').boundingBox())!;
      expect(pageTop!.y).toBeGreaterThanOrEqual(masthead.y + masthead.height);
      await expect(page.locator('.mitzo-logo')).toHaveCount(0); // hidden legacy logos tested separately below
      const box = await brand.boundingBox();
      if (reference) expect(box).toEqual(reference);
      else reference = box;
      expect(
        await page
          .locator('.mobile-workspace-body')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      await expect(page.getByRole('link', { name: 'More', exact: true })).toBeInViewport();
      if (width === 390) {
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        await page.screenshot({
          path: testInfo.outputPath(`${route.replaceAll('/', '') || 'today'}.png`),
        });
      }
    }
  }
});

test('one token change updates the accent and font on every main page', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile theme contract');
  for (const route of [...routes, ...todayDetailRoutes]) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--color-accent', '#36d6b7');
      document.documentElement.style.setProperty('--font-ui', 'Georgia');
    });
    const active = page.locator('.workspace-tabs [aria-current="page"]');
    expect(await active.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(54, 214, 183)',
    );
    expect(
      await page
        .locator('h1')
        .first()
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).toContain('Georgia');
    if (route === '/todos') {
      expect(
        await page
          .locator('.todo-card-icon')
          .first()
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe('rgb(54, 214, 183)');
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(
      await page
        .locator('.mobile-workspace')
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgb(250, 249, 246)');
  }
});

test('Today exposes real bookmarks, the tiny quote and all saved briefing meetings', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto('/');
  if (isMobile) await expect(page.getByRole('link', { name: 'Mitzo home' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search sessions and messages' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New session' })).toHaveAttribute('href', '/chat');
  await expect(page.getByRole('heading', { name: 'Pinned to Today' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your focus' })).toHaveCount(0);
  const quote = page.getByRole('link', { name: /Quote of the day by/ });
  await expect(quote).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('today-home.png') });
  await quote.click();
  await expect(page.getByRole('heading', { name: 'A thought for today' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the source' })).toHaveAttribute(
    'href',
    /^https:\/\//,
  );
  await page.goto('/');
  await page.getByRole('link', { name: 'Read briefing' }).click();
  await expect(
    page.getByRole('heading', { name: 'Morning briefing', exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: /^\d+:00 Meeting \d+$/ })).toHaveCount(10);
  const calendar = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Calendar updates' }) })
    .first();
  await expect(calendar).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Expand all meetings' }).click();
  await expect(page.getByText('Agenda 10.', { exact: true })).toBeVisible();
  await expect(page.getByText('Supporting issue 10.', { exact: true })).toBeHidden();
  const firstMeeting = page.locator('summary').filter({ hasText: /^9:00 Meeting 1$/ });
  await firstMeeting.click();
  await expect(page.getByText('Agenda 1.', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Expand all meetings' }).click();
  await expect(page.getByText('Agenda 1.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await firstMeeting.click();
  await expect(page.getByText('Agenda 1.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.getByText('Agenda 1.', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Expand all meetings' }).click();
  await page.getByRole('button', { name: 'Ask Jeeves', exact: true }).click();
  const popup = page.getByRole('dialog');
  await expect(popup).toBeVisible();
  const popupBounds = (await popup.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(popupBounds.x).toBeCloseTo((viewport.width - popupBounds.width) / 2, 0);
  expect(popupBounds.y).toBeCloseTo((viewport.height - popupBounds.height) / 2, 0);
  const accountBounds = (await popup
    .getByRole('combobox', { name: 'Account', exact: true })
    .boundingBox())!;
  expect(accountBounds.width).toBeGreaterThan(popupBounds.width - 80);
  await expect(popup.getByRole('combobox', { name: 'Account', exact: true })).toBeVisible();
  await expect(popup.getByRole('combobox', { name: 'Account', exact: true })).toHaveValue(
    'work-account',
  );
  await page.screenshot({ path: testInfo.outputPath('briefing-picker.png') });
  await popup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(popup).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('briefing-reader.png') });
});

test('Today details and nickname controls inherit appearance and remain usable with larger text', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  for (const variant of [
    { theme: 'dark', accent: 'lavender', font: 'system' },
    { theme: 'light', accent: 'teal', font: 'georgia' },
  ]) {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Quote of the day by/ })).toBeVisible();
    await page.evaluate((appearance) => {
      const root = document.documentElement;
      root.dataset.theme = appearance.theme;
      root.dataset.accent = appearance.accent;
      root.dataset.font = appearance.font;
      root.style.fontSize = '18px';
      localStorage.setItem('mitzo-font', appearance.font);
      localStorage.setItem('mitzo-accent', appearance.accent);
    }, variant);
    async function inspect(name: string) {
      const pageCanvas = page.locator('.workspace-page').first();
      expect(
        await pageCanvas.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      const controls = page.locator(
        '.home-secondary, .home-search input, .home-names input, .briefing-page button',
      );
      const geometry = await controls.evaluateAll((elements) => {
        const family = getComputedStyle(document.body).fontFamily;
        const minimum = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--control-height'),
        );
        return elements.map((element) => ({
          family: getComputedStyle(element).fontFamily === family,
          height: element.getBoundingClientRect().height >= minimum,
        }));
      });
      expect(geometry.every((control) => control.family && control.height)).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${variant.theme}-${variant.font}-${variant.accent}.png`),
        animations: 'disabled',
      });
    }
    await inspect('today');
    await expect(
      page.getByRole('link', { name: 'New session', exact: true }).locator('svg[data-icon="plus"]'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Manage pins' }).click();
    const pinPopup = page.getByRole('dialog');
    await expect(pinPopup).toBeVisible();
    const popupBounds = (await pinPopup.boundingBox())!;
    expect(popupBounds.x).toBeCloseTo((page.viewportSize()!.width - popupBounds.width) / 2, 0);
    for (const direction of ['up', 'down']) {
      const control = pinPopup.getByRole('button', { name: new RegExp(`^Move .* ${direction}$`) });
      await expect(
        control.locator(`svg[data-icon="${direction}"][aria-hidden="true"]`),
      ).toBeVisible();
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: testInfo.outputPath(`pins-${variant.theme}-${variant.font}-${variant.accent}.png`),
      animations: 'disabled',
    });
    await pinPopup.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('link', { name: 'Read briefing', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Morning briefing', exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.locator('summary').filter({ hasText: /^\d+:00 Meeting \d+$/ })).toHaveCount(
      10,
    );
    await inspect('briefing');
    const briefingBack = page
      .locator('.briefing-page')
      .getByRole('link', { name: 'Today', exact: true });
    await expect(briefingBack.locator('svg[data-icon="back"][aria-hidden="true"]')).toBeVisible();
    await briefingBack.click();
    await page.getByRole('link', { name: /Quote of the day by/ }).click();
    await expect(page.getByRole('heading', { name: 'A thought for today' })).toBeVisible();
    await expect(
      page
        .locator('.quote-page')
        .getByRole('link', { name: 'Today', exact: true })
        .locator('svg[data-icon="back"]'),
    ).toBeVisible();
    await expect(
      page
        .getByRole('link', { name: 'Read the source', exact: true })
        .locator('svg[data-icon="external"]'),
    ).toBeVisible();
    await inspect('quote');
    await page.goto('/settings');
    await expect(page.getByLabel('Briefing minion name')).toHaveValue('Jeeves');
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(variant.theme);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '18px';
    });
    await inspect('names');
    await page.getByRole('button', { name: 'Save names', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Save names', exact: true })).toBeInViewport();
  }
});

test('Proposals opens full context and keeps the end of each collection above the tabs', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile collections');
  await page.goto('/inbox');
  await page.getByRole('button', { name: proposals[0].title, exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Proposal details' })
      .getByText('Full proposal context', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review in session' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to proposals' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('region', { name: 'Proposal details' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill('Proposal 12');
  await expect(page.locator('.proposal-record')).toHaveCount(1);
  for (const [route, scroll, last] of [
    ['/inbox', '.inbox-scroll', '.proposal-record'],
    ['/todos', '.todo-scroll', '.todo-card'],
    ['/sessions', '.session-list-scroll', '.session-item'],
    ['/knowledge', '.knowledge-library', '.knowledge-tree-row:has(.knowledge-tree-more)'],
  ]) {
    await page.goto(route);
    if (route === '/knowledge') {
      const hub = page.getByRole('button', { name: 'Folder hub', exact: true });
      await expect(hub).toHaveAttribute('aria-expanded', 'false');
      await hub.click();
      const context = page.getByRole('button', { name: 'Folder hub/context', exact: true });
      await expect(context).toHaveAttribute('aria-expanded', 'false');
      await context.click();
      await expect(page.locator(last)).toHaveCount(knowledgeDocuments.length);
      await expect(
        page
          .locator(last)
          .last()
          .getByRole('button', { name: /^Knowledge document 40/ }),
      ).toBeAttached();
    }
    await expect(page.locator(last).last()).toBeAttached();
    await page.locator(scroll).evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const end = (await page.locator(last).last().boundingBox())!;
    const tabs = (await page.locator('.workspace-tabs').boundingBox())!;
    expect(end.y + end.height).toBeLessThanOrEqual(tabs.y);
  }
  await page.getByRole('button', { name: /^Knowledge document 40/ }).click();
  const reader = page.getByRole('article', { name: 'Knowledge document 40' });
  await expect(reader.getByRole('heading', { name: 'Knowledge document 40' })).toBeVisible();
  await expect(reader.getByText('Accepted library context.', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem('mitzo-knowledge-working-copy:')),
  ).toBeNull();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
});

test('desktop collections inherit the same theme without the mobile masthead', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop theme contract');
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.locator('.mobile-workspace-masthead')).toHaveCount(0);
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--color-accent', '#36d6b7'),
    );
    expect(
      await page
        .locator('.workspace-rail a')
        .first()
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--accent').trim()),
    ).toBe('#36d6b7');
  }
});

test('Files keeps the last row and editor controls inside the shell and resized visual viewport', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile file viewport');
  await page.goto('/files');
  const viewer = page.locator('.viewer-page');
  const body = page.locator('.mobile-workspace-body');
  const tabs = page.locator('.workspace-tabs');
  await expect(page.getByRole('button', { name: 'Report 40.md' })).toBeAttached();
  expect((await viewer.boundingBox())!.height).toBeLessThanOrEqual(
    (await body.boundingBox())!.height,
  );
  await page.locator('.viewer-content').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = (await page.getByRole('button', { name: 'Report 40.md' }).boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual((await tabs.boundingBox())!.y);
  await page.goto('/files?path=report.md');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Document source' })).toBeVisible();
  for (const offsetTop of [0, 100]) {
    await page.evaluate((offset) => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => 450 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => offset });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    }, offsetTop);
    const bounds = (await viewer.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(offsetTop);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(450 + offsetTop);
    const footer = (await page.locator('.document-editor-footer').boundingBox())!;
    expect(footer.y + footer.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(
      (await page.getByRole('textbox', { name: 'Document source' }).boundingBox())!.height,
    ).toBeGreaterThan(44);
    await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
});

test('HTML artifacts keep a light canvas and readable default text in both app themes', async ({
  page,
}) => {
  await page.goto('/files?path=preview.html');
  const iframe = page.locator('iframe.html-preview');
  const heading = page
    .frameLocator('iframe.html-preview')
    .getByRole('heading', { name: 'HTML artifact' });
  await expect(heading).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await iframe.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgb(255, 255, 255)',
    );
    expect(await heading.evaluate((element) => getComputedStyle(element).color)).toBe(
      'rgb(0, 0, 0)',
    );
  }
});

test('Settings previews and persists every accent and font across navigation and reload', async ({
  page,
  isMobile,
}, testInfo) => {
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/settings');
  const theme = page.getByRole('combobox', { name: 'Theme' });
  const preview = page.locator('.appearance-preview-action');
  for (const mode of ['dark', 'light']) {
    await theme.selectOption(mode);
    await page.getByRole('radio', { name: 'Lavender', exact: true }).check();
    const swatches = page.locator('.appearance-swatch');
    const palette = await swatches.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
    expect(new Set(palette).size).toBe(8);
    for (const label of ['Lavender', 'Teal', 'Rose', 'Amber', 'Blue', 'Mint', 'Coral', 'Plum']) {
      await page.getByRole('radio', { name: label, exact: true }).check();
      expect(
        await swatches.evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        ),
        `Swatches after selecting ${label} in ${mode}`,
      ).toEqual(palette);
      const ratio = await preview.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const parts = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
        };
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio, `${label} in ${mode}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await theme.selectOption('dark');
  await page.getByRole('radio', { name: 'Teal', exact: true }).check();
  for (const [value, family] of [
    ['system', ''],
    ['arial', 'Arial'],
    ['verdana', 'Verdana'],
    ['trebuchet', 'Trebuchet MS'],
    ['palatino', 'Palatino'],
    ['courier', 'Courier New'],
    ['georgia', 'Georgia'],
  ]) {
    await page.getByRole('combobox', { name: 'Font' }).selectOption(value);
    const stored = await page.evaluate(() => localStorage.getItem('mitzo-font'));
    expect(stored).toBe(value);
    const font = await page
      .locator('h1')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily);
    if (family) expect(font).toContain(family);
    if (isMobile)
      expect(
        await page
          .locator('.settings-page')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
  }
  const accent = await preview.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.goto('/sessions');
  expect(
    await page
      .locator('.workspace-primary')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe(accent);
  expect(
    await page
      .locator('h1')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain('Georgia');
  await page.reload();
  expect(
    await page
      .locator('h1')
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain('Georgia');
  await page.goto('/settings');
  await expect(page.getByRole('radio', { name: 'Teal', exact: true })).toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Font' })).toHaveValue('georgia');
  for (const mode of ['light', 'dark']) {
    await theme.selectOption(mode);
    await page.getByRole('radio', { name: 'Teal', exact: true }).check();
    await page.getByRole('combobox', { name: 'Font' }).selectOption('georgia');
    await page.getByRole('button', { name: 'Reset appearance' }).click();
    await expect(theme).toHaveValue('system');
    await expect(page.getByRole('radio', { name: 'Lavender', exact: true })).toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Font' })).toHaveValue('system');
    expect(await page.evaluate(() => localStorage.getItem('mitzo-theme'))).toBe('system');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(
      await page.evaluate(() =>
        window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
      ),
    );
  }
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('settings.png') });
});

test('desktop Work keeps collection actions visible while hiding its duplicate heading', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop Work collection');
  await page.goto('/todos');
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const list = page.getByRole('region', { name: 'Work items', exact: true });
    await expect(list.getByRole('button', { name: 'Add outcome' })).toBeVisible();
    await expect(list.getByRole('button', { name: 'Refresh Telos' })).toBeVisible();
    await expect(list.getByRole('heading', { name: 'Work', exact: true })).toBeHidden();
    expect(
      (await list.locator('.todo-collection-heading').boundingBox())!.height,
    ).toBeLessThanOrEqual(80);
  }
});

test('accent-filled controls retain their paired foreground on hover and in user-message utilities', async ({
  page,
}) => {
  const html = await readFile(resolve('frontend/dist/index.html'), 'utf8');
  const stylesheets = [...html.matchAll(/href="([^"\s]+\.css)"/g)];
  const css = (
    await Promise.all(
      stylesheets.map((match) => readFile(resolve('frontend/dist', match[1].slice(1)), 'utf8')),
    )
  ).join('\n');
  expect(css).toContain('.mode-pill--active');
  expect(css).toContain('--color-on-accent');
  await page.setContent(`<style>${css}</style>
    <span id="paired-reference" style="color:var(--color-on-accent)">Reference</span>
    <span id="status-reference" style="color:var(--color-on-status)">Status reference</span>
    <div class="chat-input--compact"><button class="chat-input-btn--queue">Queue</button></div>
    <span class="codex-queue-status-attention">!</span>
    <div class="html-preview-card-content">HTML card canvas</div>
    <button class="mode-pill mode-pill--active">Agent</button>
    <div class="msg-bubble-group msg-bubble-group--user"><div class="msg-bubble msg-bubble--user">
      User message<div class="msg-bubble-footer msg-bubble-footer--user">
        <span class="msg-timestamp msg-timestamp--user">12:00</span>
        <button class="read-aloud-btn msg-bubble-read-aloud--user">Read aloud</button>
        <button class="msg-bubble-copy msg-bubble-copy--user">Copy</button>
      </div></div></div>`);
  for (const theme of ['dark', 'light']) {
    for (const accent of ['lavender', 'teal', 'rose', 'amber', 'blue', 'mint', 'coral', 'plum']) {
      await page.evaluate(
        ({ theme, accent }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.accent = accent;
        },
        { theme, accent },
      );
      const color = await page
        .locator('#paired-reference')
        .evaluate((element) => getComputedStyle(element).color);
      const mode = page.getByRole('button', { name: 'Agent', exact: true });
      await mode.hover();
      await expect
        .poll(() => mode.evaluate((element) => getComputedStyle(element).color))
        .toBe(color);
      for (const selector of [
        '.msg-timestamp--user',
        '.msg-bubble-read-aloud--user',
        '.msg-bubble-copy--user',
        '.chat-input-btn--queue',
      ]) {
        const control = page.locator(selector);
        await expect
          .poll(() => control.evaluate((element) => getComputedStyle(element).color))
          .toBe(color);
        await expect
          .poll(() => control.evaluate((element) => getComputedStyle(element).opacity))
          .toBe('1');
      }
      expect(
        await page
          .locator('.codex-queue-status-attention')
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe(
        await page
          .locator('#status-reference')
          .evaluate((element) => getComputedStyle(element).color),
      );
      expect(
        await page
          .locator('.html-preview-card-content')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe('rgb(255, 255, 255)');
    }
  }
});

test('desktop Calendar uses the week canvas and dismissible event details', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Desktop calendar');
  for (const width of [900, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/calendar');
    const agenda = page.locator('.cal-body');
    await expect(agenda.locator('.cal-day')).toHaveCount(7);
    await expect(page.locator('.calendar-desktop .mitzo-logo')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Event details' })).toHaveCount(0);
    const canvas = (await page.locator('.calendar-desktop').boundingBox())!;
    const box = (await agenda.boundingBox())!;
    expect(box.width).toBeGreaterThan(canvas.width - 60);
    const first = (await agenda.locator('.cal-day').nth(0).boundingBox())!;
    const second = (await agenda.locator('.cal-day').nth(1).boundingBox())!;
    expect(second.y).toBeCloseTo(first.y, 0);
    expect(second.x).toBeGreaterThan(first.x);
    expect(await agenda.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(agenda.locator('.cal-day').last().locator('.cal-day-header')).toBeInViewport();
    const meeting = page.getByRole('button', {
      name: 'Planning review with a long meeting title and team context',
    });
    await meeting.click();
    const details = page.getByRole('region', { name: 'Event details' });
    await expect(details.getByRole('link', { name: 'Join video call' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Close event details' })).toBeFocused();
    expect(await agenda.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(meeting).toBeFocused();
    await agenda.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Meeting 12', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(agenda.locator('.cal-day')).toHaveCount(1);
    await page.getByRole('button', { name: 'Releases', exact: true }).click();
    await expect(agenda.locator('.cal-day')).toHaveCount(1);
    await expect(agenda.getByText('No events')).toHaveCount(0);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(agenda.locator('.cal-day')).toHaveCount(7);
    expect(
      await page.locator('.calendar-desktop').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(page.locator('.cal-loading')).toHaveCount(0);
    await expect(agenda.getByRole('button', { name: 'Meeting 18', exact: true })).toBeAttached();
    if (width === 1440)
      await page.screenshot({
        path: testInfo.outputPath('calendar-desktop.png'),
        animations: 'disabled',
      });
  }
});

test('desktop Notifications fills the workspace with compact activity rows', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Desktop notifications');
  for (const width of [900, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/notifications');
    const canvas = (await page.locator('.desktop-center').boundingBox())!;
    const content = (await page.locator('.notifications-page').boundingBox())!;
    expect(content.x).toBeCloseTo(canvas.x, 0);
    expect(content.width).toBeCloseTo(canvas.width, 0);
    const card = page.locator('.notification-card').first();
    await expect(card).toBeVisible();
    expect((await card.boundingBox())!.width).toBeGreaterThan(content.width - 60);
    if (width >= 1440) {
      expect((await card.boundingBox())!.height).toBeLessThan(160);
      const action = (await card.getByRole('button', { name: 'View update' }).boundingBox())!;
      const title = (await card.locator('h2').boundingBox())!;
      expect(action.x).toBeGreaterThan(title.x + title.width);
    }
    if (width === 1440)
      await page.screenshot({
        path: testInfo.outputPath('notifications-desktop.png'),
        animations: 'disabled',
      });
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What reaches you' })).toBeVisible();
    expect(
      await page.locator('.notifications-page').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  }
});

test('mobile Calendar and Notifications remain bounded and scrollable', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile calendar and notifications');
  for (const route of ['/calendar', '/notifications']) {
    await page.goto(route);
    const body = page.locator('.mobile-workspace-body');
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const scroller = page.locator(route === '/calendar' ? '.cal-body' : '.notifications-page');
    await expect(
      page.getByText(route === '/calendar' ? 'Meeting 12' : 'Session update 12', { exact: true }),
    ).toBeAttached();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const end = (await page
      .getByText(route === '/calendar' ? 'Meeting 18' : 'Session update 12', { exact: true })
      .boundingBox())!;
    expect(end.y + end.height).toBeLessThanOrEqual(
      (await page.locator('.workspace-tabs').boundingBox())!.y,
    );
  }
});

test('short desktop Calendar keeps event details and actions reachable', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Desktop calendar');
  for (const width of [800, 1024, 1440]) {
    await page.setViewportSize({ width, height: 500 });
    await page.goto('/calendar');
    await page
      .getByRole('button', { name: 'Planning review with a long meeting title and team context' })
      .click();
    const details = page.getByRole('region', { name: 'Event details' });
    const bounds = (await details.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(500);
    expect(bounds.height).toBeGreaterThan(40);
    await details.getByRole('link', { name: 'Join video call' }).scrollIntoViewIfNeeded();
    await expect(details.getByRole('link', { name: 'Join video call' })).toBeInViewport();
    await expect(details.getByRole('button', { name: 'Prep for this meeting' })).toBeInViewport();
    await details.getByRole('button', { name: 'Close event details' }).click();
    await expect(details).toHaveCount(0);
  }
});

test('notification archive actions stay usable on desktop and mobile', async ({
  page,
}, testInfo) => {
  const items = [
    {
      id: 'done',
      kind: 'session',
      title: 'Finished work',
      body: 'Agent finished its turn.',
      createdAt: Date.now(),
      readAt: 1,
      resolution: null,
      archivedAt: null as number | null,
    },
    {
      id: 'live',
      kind: 'approval',
      title: 'Pending approval',
      body: 'Needs your decision',
      permId: 'live',
      createdAt: Date.now(),
      readAt: null,
      resolution: null,
      archivedAt: null as number | null,
    },
  ];
  await page.route('**/api/notifications**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() === 'POST') {
      if (path === '/api/notifications/archive-resolved') items[0].archivedAt = Date.now();
      else if (path === '/api/notifications/done/archive') items[0].archivedAt = Date.now();
      else if (path === '/api/notifications/done/restore') items[0].archivedAt = null;
      else return route.fulfill({ status: 400, json: { error: 'Unexpected test action' } });
      return route.fulfill({ json: { ok: true } });
    }
    const archived = url.searchParams.get('filter') === 'archived';
    const visible = items.filter((item) =>
      archived ? item.archivedAt !== null : item.archivedAt === null,
    );
    return route.fulfill({
      json: {
        ...(fixtures['/api/notifications'] as object),
        items: visible,
        total: visible.length,
        needsYou: 1,
      },
    });
  });
  await page.goto('/notifications');
  const finished = page.getByRole('article').filter({ hasText: 'Finished work' });
  const pending = page.getByRole('article').filter({ hasText: 'Pending approval' });
  await expect(pending.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await finished.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(finished).toHaveCount(0);
  await expect(pending).toBeVisible();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await finished.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(finished).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(finished).toBeVisible();
  await page.getByRole('button', { name: 'Archive resolved', exact: true }).click();
  await expect(finished).toHaveCount(0);
  await expect(pending).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('notification-archive.png'),
    animations: 'disabled',
  });
});

async function fixtureSymposium(
  page: Page,
  options: { empty?: boolean; failed?: boolean; ready?: Promise<void> } = {},
) {
  const status = { ...symposiumStatus('offline-symposium'), deliveries: [] as object[] };
  const queued: Record<string, unknown>[] = [];
  await page.route('**/api/sessions/offline-symposium/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() === 'POST' && path.endsWith('/symposium/deliveries')) {
      const request = route.request().postDataJSON();
      queued.push(request);
      const delivery = {
        ...request,
        sessionId: status.sessionId,
        deliveryId: 'offline-delivery',
        status: 'awaiting_intervention',
        deliveredContent: null,
        recipients: request.recipientSeatIds.map((seatId: string) => ({
          seatId,
          status: 'pending',
        })),
      };
      status.deliveries = [delivery];
      return route.fulfill({ json: delivery });
    }
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline UI test' } });
    if (path.endsWith('/messages'))
      return route.fulfill({ json: options.empty ? [] : symposiumMessages });
    if (path.endsWith('/symposium/status')) {
      await options.ready;
      return options.failed
        ? route.fulfill({ status: 503, json: { error: 'Offline status unavailable' } })
        : route.fulfill({ json: status });
    }
    if (path.endsWith('/symposium/perspectives'))
      return route.fulfill({
        json: options.empty
          ? { items: [], queued: [], nextSeq: null }
          : { ...symposiumPerspective(url.searchParams.get('seatId')), queued: [] },
      });
    if (
      path.endsWith('/symposium/profile-proposals') ||
      path.endsWith('/symposium/access-requests')
    )
      return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  return queued;
}

test('combined conversation keeps explicit recipient drafts independent of tabs and appearance', async ({
  page,
  isMobile,
  browserName,
}, testInfo) => {
  const queued = await fixtureSymposium(page);
  for (const width of isMobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('https://mitzo-ui.test/chat/offline-symposium');
    const all = page.getByRole('tab', { name: 'All', exact: true });
    await expect(all).toHaveAttribute('aria-selected', 'true');
    const selector = page.getByRole('combobox', { name: 'Message recipient' });
    await expect(selector).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Queue for approval', exact: true }),
    ).toBeDisabled();
    await selector.selectOption('reviewer');
    const draft = page.getByRole('textbox', { name: 'Message for Reviewer', exact: true });
    await draft.fill('Review this change, keeping the selected recipient explicit.');
    await page.getByRole('tab', { name: 'Architect', exact: true }).click();
    await expect(selector).toHaveValue('reviewer');
    await expect(draft).toHaveValue('Review this change, keeping the selected recipient explicit.');
    await all.click();
    await selector.selectOption('architect');
    await expect(
      page.getByRole('textbox', { name: 'Message for Architect', exact: true }),
    ).toHaveValue('');
    await selector.selectOption('reviewer');
    await expect(draft).toHaveValue('Review this change, keeping the selected recipient explicit.');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = 'teal';
        document.documentElement.dataset.font = 'georgia';
      }, theme);
      await expect(all).toHaveAttribute('aria-selected', 'true');
      await expect(selector).toBeInViewport();
      await expect(draft).toBeInViewport();
      expect(await draft.evaluate((element) => getComputedStyle(element).fontFamily)).toContain(
        'Georgia',
      );
      await draft.evaluate((element) => (element.style.fontSize = '20px'));
      const queue = page.getByRole('button', { name: 'Queue for approval', exact: true });
      await expect(queue).toBeInViewport();
      if (isMobile) {
        expect((await selector.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await queue.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await selector.focus();
      // WebKit's default keyboard preference reaches buttons with Option-Tab.
      const nextControl = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
      await page.keyboard.press(nextControl);
      await expect(page.getByRole('button', { name: 'Choose agent recipient' })).toBeFocused();
      await page.keyboard.press(nextControl);
      await expect(draft).toBeFocused();
      expect(
        await page
          .locator('.symposium-perspective-panel')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`symposium-${width}-${theme}.png`),
        animations: 'disabled',
      });
    }
    expect(queued).toHaveLength(0);
    await page.getByRole('button', { name: 'Queue for approval', exact: true }).click();
    await expect(draft).toHaveValue('');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      recipientSeatIds: ['reviewer'],
      originalContent: 'Review this change, keeping the selected recipient explicit.',
    });
    await expect(
      page.getByRole('button', { name: 'Approve delivery to Reviewer', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send to Reviewer', exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: 'Stop delivery to Reviewer', exact: true }),
    ).toBeVisible();
    queued.length = 0;
  }
});

test('combined conversation empty and failed status remain readable without implicit sending', async ({
  page,
}, testInfo) => {
  let finishLoading!: () => void;
  const ready = new Promise<void>((resolve) => (finishLoading = resolve));
  const queued = await fixtureSymposium(page, { empty: true, ready });
  await page.goto('https://mitzo-ui.test/chat/offline-symposium');
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeDisabled();
  await expect(page.locator('.chat-input[aria-busy="true"]')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('symposium-loading.png'),
    animations: 'disabled',
  });
  finishLoading();
  await expect(page.getByRole('combobox', { name: 'Message recipient' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Queue for approval', exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath('symposium-empty.png'),
    animations: 'disabled',
  });
  await fixtureSymposium(page, { failed: true });
  await page.reload();
  await expect(page.getByText('Offline status unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Message recipient' })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('symposium-error.png'),
    animations: 'disabled',
  });
  expect(queued).toHaveLength(0);
});

test('failed briefing registration survives a completed turn and reload without resending it', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mitzo-workspace-controls-expanded', '1'));
  const sessionId = 'assigned-briefing-registration';
  const binding = {
    sessionId,
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    accountId: 'work-account',
    model: 'luna-fixture',
  };
  const posts: unknown[] = [];
  const turns: Record<string, unknown>[] = [];
  let registered = false;
  let allowRegistration = false;
  let emptyReads = 0;
  let completed = false;
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        socket.send(
          JSON.stringify({
            type: 'welcome',
            protocolVersion: 2,
            connectionId: 'offline-registration',
          }),
        );
      if (message.type !== 'send') return;
      turns.push(message);
      socket.send(
        JSON.stringify({ type: 'session_id', sessionId, clientMsgId: message.clientMsgId }),
      );
      socket.send(JSON.stringify({ type: 'session_state_changed', sessionId, state: 'running' }));
      socket.send(
        JSON.stringify({
          type: 'user_message',
          sessionId,
          messageId: message.clientMsgId,
          text: message.prompt,
          sourceSnapshots: message.sourceSnapshots,
        }),
      );
      socket.send(JSON.stringify({ type: 'session_state_changed', sessionId, state: 'idle' }));
      completed = true;
    });
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/home/briefing-chats') {
      if (route.request().method() === 'POST') {
        posts.push(route.request().postDataJSON());
        if (!allowRegistration)
          return route.fulfill({ status: 503, json: { error: 'Offline registration failed' } });
        registered = true;
        return route.fulfill({ json: { ...binding, createdAt: '2026-10-10T07:00:00Z' } });
      }
      if (!registered) emptyReads += 1;
      return route.fulfill({
        json: registered ? [{ ...binding, createdAt: '2026-10-10T07:00:00Z' }] : [],
      });
    }
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
    const models = [
      { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
    ];
    if (url.pathname === '/api/accounts')
      return route.fulfill({ json: [{ id: 'work-account', label: 'Work OpenAI', models }] });
    if (url.pathname === '/api/repository-workspaces/catalog')
      return route.fulfill({ json: { available: false, repositories: [] } });
    if (url.pathname === `/api/chat/web-search-consent/${sessionId}`)
      return route.fulfill({ json: { ok: true, grant: 'denied', revision: 0, updatedAt: null } });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: [] });
    if (url.pathname === `/api/sessions/${sessionId}/meta`)
      return route.fulfill({
        json: {
          sessionType: 'chat',
          accountBinding: {
            accountId: 'work-account',
            accountLabel: 'Work OpenAI',
            model: 'luna-fixture',
          },
          modelSelection: { model: 'luna-fixture', models },
        },
      });
    if (url.pathname === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry saving briefing link', exact: true });
  await expect(retry).toBeVisible();
  expect(completed).toBe(true);
  expect(turns).toHaveLength(1);
  expect(posts).toEqual([binding]);
  await expect.poll(() => emptyReads).toBeGreaterThan(0);
  async function retained() {
    await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveAttribute(
      'href',
      `/briefings/${binding.date}?revision=${binding.revision}`,
    );
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(model).toHaveValue(binding.model);
    await expect(model).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Thinking', exact: true })).toBeDisabled();
    await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
  }
  await retained();
  await page.goto('https://mitzo-ui.test/');
  await page.goto(`https://mitzo-ui.test/chat/${sessionId}`);
  await expect(retry).toBeVisible();
  await retained();
  await page.reload();
  await expect(retry).toBeVisible();
  await retained();
  await expect(page.getByRole('button', { name: 'Web search permission: Denied' })).toBeVisible();
  const alert = page.getByRole('alert').filter({ has: retry });
  const geometry = await alert.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const column = element.closest('.briefing-chat-banner')!.getBoundingClientRect();
    return {
      left: bounds.left - column.left,
      right: column.right - bounds.right,
      gutter: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--page-gutter'),
      ),
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.gutter);
  expect(geometry.right).toBeGreaterThanOrEqual(geometry.gutter);
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const appearance of [
    { theme: 'dark', accent: 'lavender', font: 'system' },
    { theme: 'light', accent: 'teal', font: 'georgia' },
  ]) {
    await page.evaluate((appearance) => {
      const root = document.documentElement;
      root.dataset.theme = appearance.theme;
      root.dataset.accent = appearance.accent;
      root.dataset.font = appearance.font;
    }, appearance);
    const family = await retry.evaluate((element) => ({
      control: getComputedStyle(element).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
    }));
    expect(family.control).toBe(family.body);
    await retained();
    await page.screenshot({
      path: testInfo.outputPath(
        `briefing-registration-error-${appearance.theme}-${appearance.font}-${appearance.accent}.png`,
      ),
      animations: 'disabled',
    });
  }
  allowRegistration = true;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await retained();
  expect(posts).toEqual([binding, binding]);
  expect(turns).toHaveLength(1);
});

test('saved chat identity failures lock model controls until an explicit successful retry', async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mitzo-workspace-controls-expanded', '1'));
  let failure: '503' | 'network' | null = '503';
  let recovery: 'briefing' | 'ordinary' = 'briefing';
  let reads = 0;
  const sessionId = 'saved-binding-check';
  const binding = {
    sessionId,
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    accountId: 'work-account',
    model: 'luna-fixture',
    createdAt: '2026-10-10T07:00:00Z',
  };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
    if (
      url.pathname === '/api/home/briefing-chats' &&
      url.searchParams.get('sessionId') === sessionId
    ) {
      reads += 1;
      if (failure === 'network') return route.abort('failed');
      if (failure === '503')
        return route.fulfill({ status: 503, json: { error: 'Briefing identity unavailable' } });
      return route.fulfill({ json: recovery === 'briefing' ? [binding] : [] });
    }
    if (url.pathname === '/api/accounts')
      return route.fulfill({
        json: [
          {
            id: 'work-account',
            label: 'Work OpenAI',
            models: [
              { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
            ],
          },
        ],
      });
    if (url.pathname === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: [] });
    if (url.pathname === `/api/sessions/${sessionId}/meta`)
      return route.fulfill({
        json: {
          sessionType: 'chat',
          accountBinding: {
            accountId: 'work-account',
            accountLabel: 'Work OpenAI',
            model: 'luna-fixture',
          },
          modelSelection: {
            model: 'luna-fixture',
            models: [
              { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
              { id: 'alternative-fixture', label: 'Alternative fixture' },
            ],
          },
        },
      });
    if (url.pathname === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  for (const failed of ['503', 'network'] as const) {
    for (const recovered of ['briefing', 'ordinary'] as const) {
      failure = failed;
      recovery = recovered;
      await page.goto(`/chat/${sessionId}`);
      const retry = page.getByRole('button', { name: 'Retry briefing lookup', exact: true });
      await expect(retry).toBeVisible();
      const model = page.getByRole('combobox', { name: 'Model', exact: true });
      await expect(model).toBeVisible();
      await expect(model).toBeDisabled();
      await expect(model).toHaveValue('luna-fixture');
      await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
      const thinking = page.getByRole('combobox', { name: 'Thinking', exact: true });
      await expect(thinking).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Change account or model', exact: true }),
      ).toHaveCount(0);
      expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const alert = page.getByRole('alert').filter({ has: retry });
      const alignment = await alert.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const column = element.closest('.briefing-chat-banner')!.getBoundingClientRect();
        return {
          left: bounds.left - column.left,
          right: column.right - bounds.right,
          gutter: Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--page-gutter'),
          ),
        };
      });
      expect(alignment.left).toBeGreaterThanOrEqual(alignment.gutter);
      expect(alignment.right).toBeGreaterThanOrEqual(alignment.gutter);
      await page.evaluate((light) => {
        document.documentElement.dataset.theme = light ? 'light' : 'dark';
        document.documentElement.dataset.accent = light ? 'teal' : 'lavender';
        document.documentElement.dataset.font = light ? 'georgia' : 'system';
      }, failed === 'network');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width,
      );
      await page.screenshot({
        path: testInfo.outputPath(`briefing-lookup-error-${failed}-${recovered}.png`),
        animations: 'disabled',
      });
      failure = null;
      const before = reads;
      await retry.click();
      await expect(retry).toHaveCount(0);
      expect(reads).toBeGreaterThan(before);
      if (recovered === 'briefing') {
        await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toBeVisible();
        await expect(model).toBeDisabled();
        await expect(thinking).toBeDisabled();
        await expect(
          page.getByRole('button', { name: 'Change account or model', exact: true }),
        ).toBeVisible();
      } else {
        await expect(model).toBeEnabled();
        await expect(thinking).toBeEnabled();
        await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveCount(0);
      }
    }
  }
});

test('profile drafts stay behind Workspace and remain readable on mobile and desktop', async ({
  page,
  isMobile,
}, testInfo) => {
  let state: 'empty' | 'error' | 'populated' = 'empty';
  let draftReads = 0;
  const proposal = {
    proposalId: 'offline-draft',
    suggestedProfileId: 'reviewer',
    state: 'pending',
    definition: {
      name: 'Reusable reviewer for planning decisions and their supporting evidence',
      role: 'reviewer',
      instructions: 'Review the selected changes and explain each finding with evidence. '.repeat(
        12,
      ),
      expectedOutput: 'A concise list of findings',
      acceptanceCriteria: ['Every finding cites evidence'],
      modelPolicyRole: 'reviewer',
    },
  };
  await page.addInitScript(() => localStorage.removeItem('mitzo-workspace-controls-expanded'));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
    if (url.pathname === '/api/sessions/ui-drafts/messages') return route.fulfill({ json: [] });
    if (url.pathname === '/api/sessions/ui-drafts/meta')
      return route.fulfill({ json: { sessionType: 'chat' } });
    if (url.pathname === '/api/sessions/ui-drafts/symposium/status')
      return route.fulfill({ json: { sessionId: 'ui-drafts', config: null, seats: [] } });
    if (url.pathname === '/api/symposium/profiles') return route.fulfill({ json: [] });
    if (url.pathname === '/api/symposium/profile-proposals') {
      draftReads += 1;
      if (state === 'error')
        return route.fulfill({ status: 503, json: { error: 'Draft service unavailable' } });
      return route.fulfill({ json: state === 'populated' ? [proposal] : [] });
    }
    return route.fallback();
  });
  for (const width of isMobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['dark', 'light']) {
      state = 'empty';
      const readsBefore = draftReads;
      await page.goto('https://mitzo-ui.test/chat/ui-drafts');
      await expect(page.getByPlaceholder('Message Mitzo...')).toBeVisible();
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = 'teal';
        document.documentElement.dataset.font = 'georgia';
      }, theme);
      const workspace = page.getByRole('button', { name: /^Workspace controls/ });
      const drafts = page.getByRole('button', { name: 'Reusable profile drafts', exact: true });
      await expect(drafts).toBeHidden();
      expect(draftReads).toBe(readsBefore);
      await page.screenshot({
        path: testInfo.outputPath(`drafts-collapsed-${width}-${theme}.png`),
      });
      await workspace.click();
      await expect(drafts).toBeVisible();
      expect(draftReads).toBe(readsBefore);
      const touch = await drafts.boundingBox();
      expect(touch!.height).toBeGreaterThanOrEqual(44);
      for (const next of ['empty', 'error', 'populated'] as const) {
        state = next;
        await drafts.focus();
        await expect(drafts).toBeFocused();
        await page.keyboard.press('Enter');
        const panel = page.getByRole('complementary', { name: 'Reusable profile drafts' });
        await expect(panel).toBeVisible();
        if (next === 'empty')
          await expect(panel.getByText('No profile drafts in this chat yet.')).toBeVisible();
        if (next === 'error')
          await expect(panel.getByRole('alert')).toHaveText('Draft service unavailable');
        if (next === 'populated') {
          await expect(panel.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
            proposal.definition.name,
          );
          await panel
            .getByRole('button', { name: 'Save reusable profile' })
            .scrollIntoViewIfNeeded();
          await expect(panel.getByRole('button', { name: 'Save reusable profile' })).toBeVisible();
          const saveTarget = await panel
            .getByRole('button', { name: 'Save reusable profile' })
            .boundingBox();
          expect(saveTarget!.height).toBeGreaterThanOrEqual(44);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath(`drafts-${next}-${width}-${theme}.png`),
        });
        await drafts.click();
        await expect(panel).toBeHidden();
      }
      await workspace.click();
      await expect(drafts).toBeHidden();
      await expect(page.getByPlaceholder('Message Mitzo...')).toBeVisible();
    }
  }
});
