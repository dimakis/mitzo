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
  agent: index === 0 ? 'troubadour' : index % 2 ? 'planner' : 'dream_detector',
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
  '/api/skills': [],
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
    showDailyQuote: true,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
    pins: [{ kind: 'session', id: 'session-0', title: 'Quarterly planning review' }],
  },
  '/api/home/briefing-chats': [],
  '/api/agent-library': { drafts: [], versions: [] },
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
type InboxFixtureRecord = {
  id: string;
  kind: string;
  resolvedAt?: number | null;
  archivedAt?: number | null;
  inbox?: { category: string };
  [key: string]: unknown;
};
const inboxRecords: InboxFixtureRecord[] = [
  ...proposals.map((item) => ({
    id: `inbox:${item.filename}`,
    kind: 'update',
    title: item.title,
    body: item.preview,
    inboxFilename: item.filename,
    createdAt: Date.parse(item.timestamp),
    readAt: 1,
    resolvedAt: null,
    resolution: null,
    archivedAt: null,
    inbox: {
      agent: item.agent,
      category: 'proposal',
      severity: 'info',
      needsAttention: false,
      status: 'pending',
      tags: item.tags,
      content:
        '# Full proposal context\n\nReview the original evidence before deciding on the next step.',
    },
  })),
  ...(fixtures['/api/notifications'] as { items: { id: string; kind: string }[] }).items.map(
    (item) => ({
      ...item,
      resolvedAt: null,
      resolution: null,
      archivedAt: null,
    }),
  ),
];
function inboxFixture(url: URL, records: InboxFixtureRecord[] = inboxRecords) {
  const view = url.searchParams.get('view') || 'needs';
  const query = (url.searchParams.get('query') || '').toLowerCase();
  const filtered = records.filter((item) => {
    if (query) return JSON.stringify(item).toLowerCase().includes(query);
    if (view === 'archive') return item.archivedAt != null;
    if (item.archivedAt != null) return false;
    if (view === 'needs')
      return ['approval', 'question'].includes(item.kind) && item.resolvedAt == null;
    if (view === 'proposals') return item.inbox?.category === 'proposal';
    if (view === 'briefings') return item.inbox?.category === 'briefing';
    return true;
  });
  const offset = Number(url.searchParams.get('offset')) || 0;
  return {
    items: filtered.slice(offset, offset + 50),
    total: filtered.length,
    needsYou: records.filter(
      (item) =>
        ['approval', 'question'].includes(item.kind) &&
        item.resolvedAt == null &&
        item.archivedAt == null,
    ).length,
    sources: ['planner', 'dream_detector', 'troubadour'],
  };
}
const mime: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    const events: { kind: string; duration: number }[] = [];
    Object.assign(window, { motionEvents: events });
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (frames, options) {
      const animation = original.call(this, frames, options);
      queueMicrotask(() =>
        events.push({
          kind: animation.id,
          duration: Number(animation.effect?.getTiming().duration),
        }),
      );
      return animation;
    };
  });
}
async function motionKinds(page: Page) {
  return page.evaluate(() =>
    (window as Window & { motionEvents: { kind: string }[] }).motionEvents.map(
      (event) => event.kind,
    ),
  );
}

test('motion: navigation keeps layout and input stable across push and back', async ({
  page,
}, testInfo) => {
  await recordMotion(page);
  await page.goto('/sessions');
  await expect(page.getByRole('link', { name: 'More', exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const before = await nav.boundingBox();
  await page.getByRole('link', { name: 'More', exact: true }).click();
  await expect(page).toHaveURL(/\/more$/);
  await expect.poll(() => motionKinds(page)).toContain('mitzo:page');
  expect(await nav.boundingBox()).toEqual(before);
  await page.goBack();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect
    .poll(async () => (await motionKinds(page)).filter((kind) => kind === 'mitzo:page').length)
    .toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: testInfo.outputPath('motion-navigation.png'),
    animations: 'disabled',
  });
});

test('motion: composer popover and resource sheet animate without losing the draft', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile'), 'Composer popover is mobile only');
  await recordMotion(page);
  await page.goto('/chat');
  const draft = page.getByRole('textbox', { name: /Message/ }).first();
  await draft.fill('Keep this draft');
  await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible();
  await expect.poll(() => motionKinds(page)).toContain('mitzo:popover');
  await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close session tray', exact: true })).toBeVisible();
  await expect.poll(() => motionKinds(page)).toContain('mitzo:sheet');
  const tray = await page.locator('.session-tray--toolbar').boundingBox();
  expect(tray!.x).toBeGreaterThanOrEqual(0);
  expect(tray!.x + tray!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({
    path: testInfo.outputPath('motion-session-tray-dark.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await page.screenshot({
    path: testInfo.outputPath('motion-session-tray-light.png'),
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Dismiss session tray', exact: true })
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('button', { name: 'Close session tray', exact: true })).toBeHidden();
  await expect(draft).toHaveValue('Keep this draft');
  await expect(
    page.getByRole('button', { name: 'More composer actions', exact: true }),
  ).toBeInViewport();
});

test('motion: Reduce Motion disables navigation and control animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recordMotion(page);
  await page.goto('/sessions');
  await page.getByRole('link', { name: 'More', exact: true }).click();
  await expect(page).toHaveURL(/\/more$/);
  expect(await motionKinds(page)).toEqual([]);
  const animations = await page.evaluate(() => document.getAnimations().length);
  expect(animations).toBe(0);
});

test('motion: a wide mobile composer keeps inline actions accessible', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto('/chat');
  const composer = page.locator('.chat-input--compact');
  await expect(composer).toBeVisible();
  expect(await composer.evaluate((element) => element.clientWidth)).toBeGreaterThan(520);
  await expect(
    page.getByRole('button', { name: 'More composer actions', exact: true }),
  ).toBeHidden();
  const tools = composer.locator('.composer-tools');
  await expect(tools).not.toHaveAttribute('inert');
  await expect(tools).not.toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  const isolation = page.getByRole('button', { name: 'Worktree isolation', exact: true });
  await expect(isolation).toBeVisible();
  const isolated = await isolation.getAttribute('aria-pressed');
  await isolation.click();
  await expect(isolation).toHaveAttribute('aria-pressed', isolated === 'true' ? 'false' : 'true');
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  await expect(draft).toHaveValue('/');
  await expect(draft).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath('motion-wide-mobile-composer.png'),
    animations: 'disabled',
  });
});

test('motion: a narrow desktop composer opens, closes, and follows container resizing', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/chat');
  const composer = page.locator('.chat-input--compact');
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await draft.fill('Keep this container draft');
  await composer.evaluate((element) => {
    (element as HTMLElement).style.width = '480px';
  });
  const tools = composer.locator('.composer-tools');
  const toggle = page.getByRole('button', { name: 'More composer actions', exact: true });
  await expect(toggle).toBeVisible();
  await expect(tools).toBeHidden();
  await expect(tools).toHaveAttribute('inert');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible();
  await toggle.click();
  await expect(tools).toBeHidden();
  await expect(tools).toHaveAttribute('aria-hidden', 'true');
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(tools).toBeHidden();
  await expect(draft).toBeFocused();
  // Resize the same mounted composer while the viewport remains desktop-sized.
  await composer.evaluate((element) => {
    (element as HTMLElement).style.width = '600px';
  });
  await expect(toggle).toBeHidden();
  await expect(tools).toBeVisible();
  await expect(tools).not.toHaveAttribute('inert');
  await expect(tools).not.toHaveAttribute('aria-hidden', 'true');
  await composer.evaluate((element) => {
    (element as HTMLElement).style.width = '480px';
  });
  await expect(toggle).toBeVisible();
  await expect(tools).toBeHidden();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Attach image', exact: true })).toBeVisible();
  await expect(draft).toHaveValue('Keep this container draft');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await page.screenshot({
    path: testInfo.outputPath('motion-narrow-desktop-composer.png'),
    animations: 'disabled',
  });
});

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
      if (url.pathname === '/api/inbox/feed') return route.fulfill({ json: inboxFixture(url) });
      if (url.pathname.startsWith('/api/inbox/records/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/inbox/records/'.length));
        const item = inboxRecords.find((record) => record.id === id);
        return route.fulfill({
          status: item ? 200 : 404,
          json: item || { error: 'Unknown fixture' },
        });
      }
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
    await expect(active).toHaveCSS('color', 'rgb(54, 214, 183)');
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
    const close = pinPopup.getByRole('button', { name: 'Close', exact: true });
    await expect(close.locator('svg[data-icon="close"][aria-hidden="true"]')).toBeVisible();
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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
    const summary = page.locator('summary').filter({ hasText: /^9:00 Meeting 1$/ });
    const marker = summary.locator('svg[data-icon="forward"][aria-hidden="true"]');
    await expect(marker).toBeVisible();
    expect((await marker.boundingBox())!.width).toBeCloseTo(16, 1);
    expect((await marker.boundingBox())!.height).toBeCloseTo(16, 1);
    expect(await summary.evaluate((element) => getComputedStyle(element, '::before').content)).toBe(
      'none',
    );
    const closedTransform = await marker.evaluate((element) => getComputedStyle(element).transform);
    await summary.click();
    expect(await marker.evaluate((element) => getComputedStyle(element).transform)).not.toBe(
      closedTransform,
    );
    await summary.click();
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
  await page.goto('/inbox?view=proposals');
  await page
    .getByRole('button', {
      name: 'Possible connection: Quarterly planning decisions and follow-up context',
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Inbox details' })
      .getByText('Full proposal context', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review in session' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/inbox\?view=proposals$/);
  await expect(page.getByRole('region', { name: 'Inbox details' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search your entire inbox' }).fill('Proposal 12');
  await expect(page.locator('.proposal-record')).toHaveCount(1);
  for (const [route, scroll, last] of [
    ['/inbox?view=proposals', '.inbox-scroll', '.proposal-record'],
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

test('desktop Inbox combines both feeds and retains notification preferences', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Desktop Inbox');
  for (const width of [900, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/notifications');
    await expect(page).toHaveURL(/\/inbox$/);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.locator('.proposal-record').first()).toBeVisible();
    expect(
      await page.locator('.unified-inbox').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    if (width === 1440)
      await page.screenshot({
        path: testInfo.outputPath('inbox-desktop.png'),
        animations: 'disabled',
      });
    await page.getByRole('link', { name: 'Preferences', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What reaches you' })).toBeVisible();
  }
});

test('mobile Calendar and combined Inbox remain bounded and scrollable', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Mobile collections');
  for (const route of ['/calendar', '/inbox?view=all']) {
    await page.goto(route);
    expect(
      await page
        .locator('.mobile-workspace-body')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const scroller = page.locator(route === '/calendar' ? '.cal-body' : '.inbox-scroll');
    await expect(
      page.getByText(route === '/calendar' ? 'Meeting 12' : 'Session update 12', { exact: true }),
    ).toBeAttached();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const end = (await (
      route === '/calendar'
        ? scroller.getByText('Meeting 18', { exact: true })
        : scroller.locator('.proposal-record').last()
    ).boundingBox())!;
    expect(end.y + end.height).toBeLessThanOrEqual(
      (await page.locator('.workspace-tabs').boundingBox())!.y + 1,
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

test('combined Inbox archive is recoverable and live approvals stay protected', async ({
  page,
  isMobile,
}, testInfo) => {
  const records = [
    {
      id: 'done',
      kind: 'session',
      title: 'Finished work',
      body: 'Agent finished its turn.',
      createdAt: Date.now(),
      readAt: 1,
      resolvedAt: null,
      resolution: null,
      archivedAt: null as number | null,
    },
    {
      id: 'live',
      kind: 'approval',
      title: 'Pending approval',
      body: 'Needs your decision',
      permId: 'live',
      sessionId: 's1',
      request: { toolName: 'Read', toolInput: 'README.md' },
      createdAt: Date.now(),
      readAt: null,
      resolvedAt: null,
      resolution: null,
      archivedAt: null as number | null,
    },
  ];
  await page.route('**/api/inbox/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/inbox/feed')
      return route.fulfill({ json: inboxFixture(url, records) });
    const item = records.find(
      (record) => record.id === decodeURIComponent(url.pathname.split('/').pop()!),
    );
    return route.fulfill({ status: item ? 200 : 404, json: item || {} });
  });
  await page.route('**/api/notifications**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST') {
      if (url.pathname === '/api/notifications/done/archive') records[0].archivedAt = Date.now();
      if (url.pathname === '/api/notifications/done/restore') records[0].archivedAt = null;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: {
        ...(fixtures['/api/notifications'] as object),
        items: records,
        needsYou: 1,
        total: 2,
      },
    });
  });
  await page.goto('/inbox?view=all');
  await page.getByRole('button', { name: 'Pending approval', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Inbox details' })
      .getByRole('heading', { name: 'Pending approval' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Inbox details' })
      .getByRole('button', { name: 'Archive', exact: true }),
  ).toHaveCount(0);
  if (isMobile) await page.getByRole('button', { name: 'Back to Inbox' }).click();
  await page.getByRole('button', { name: 'Finished work', exact: true }).click();
  await page
    .getByRole('region', { name: 'Inbox details' })
    .getByRole('button', { name: 'Archive', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Finished work', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finished work', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inbox-archive.png'), animations: 'disabled' });
});

test('Inbox filters and list controls fit with large text and alternate appearance', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1440, height: 900 });
  await page.goto('/inbox?view=all');
  await expect(page.locator('.proposal-record').first()).toBeVisible();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--color-accent', '#36d6b7');
      document.documentElement.style.setProperty('--font-ui', 'Georgia');
      document.documentElement.style.fontSize = '20px';
    }, theme);
    const list = page.locator('.inbox-scroll');
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const control of [
      page.getByRole('button', { name: 'Mark updates read' }),
      page.getByLabel('Source', { exact: true }),
      page.getByLabel('Type', { exact: true }),
    ]) {
      const bounds = await control.boundingBox();
      const width = page.viewportSize()!.width;
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({
      path: testInfo.outputPath(`inbox-${theme}-alternate.png`),
      animations: 'disabled',
    });
  }
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

async function exerciseBriefingReloadRecovery(
  page: Page,
  hideAssigned = false,
  nativeMode?: 'unready' | 'lost-ack',
) {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem('mitzo:transport');
    localStorage.removeItem('mitzo-workspace-controls-expanded');
    // Recreating either receiver cannot depend on the previous window's sessionStorage.
    sessionStorage.clear();
  });
  if (nativeMode)
    await page.addInitScript(() => {
      // Only platform presentation APIs are stubbed; chat uses the actual native-default selector.
      const names = [
        'App',
        'Keyboard',
        'StatusBar',
        'SplashScreen',
        'Haptics',
        'PushNotifications',
        'WatchAuthBridge',
        'NativeBiometric',
        'NotificationBadgeBridge',
      ];
      const methods = [
        'addListener',
        'removeListener',
        'setResizeMode',
        'setAccessoryBarVisible',
        'setScroll',
        'setStyle',
        'setBackgroundColor',
        'hide',
        'impact',
        'notification',
        'selectionChanged',
        'requestPermissions',
        'register',
        'configureNotificationServer',
        'isAvailable',
        'setBadge',
        'saveToken',
        'clearToken',
      ];
      Object.assign(window, {
        CapacitorCustomPlatform: { name: 'ios' },
        Capacitor: {
          PluginHeaders: names.map((name) => ({
            name,
            methods: methods.map((name) => ({
              name,
              rtype: name === 'addListener' ? 'callback' : 'promise',
            })),
          })),
          nativePromise: async (plugin: string) =>
            plugin === 'PushNotifications' ? { receive: 'denied' } : {},
          nativeCallback: () => 'offline-native-listener',
        },
      });
    });
  const sessionId = 'sse-restored-briefing-command';
  const binding = {
    sessionId,
    date: '2026-10-10',
    revision: 'a'.repeat(64),
    accountId: 'work-account',
    model: 'luna-fixture',
  };
  const sends: Record<string, unknown>[] = [];
  const registrations: unknown[] = [];
  const turns = new Set<string>();
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  let acceptRegistration = false;
  let registered = false;
  let hidden = false;
  let slowMetadata = false;
  let sockets = 0;
  let chatSseRequests = 0;
  const websocketSends: unknown[] = [];
  await page.routeWebSocket('**/*', (socket) => {
    sockets += 1;
    if (!nativeMode) {
      socket.close();
      return;
    }
    const generation = sockets;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'send') websocketSends.push(message);
      if (message.type === 'hello' && (nativeMode === 'lost-ack' || generation > 1))
        socket.send(
          JSON.stringify({
            type: 'welcome',
            protocolVersion: 2,
            connectionId: 'offline-native-ws',
          }),
        );
    });
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/chat/events') {
      chatSseRequests += 1;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\nevent: welcome\ndata: {"connectionId":"offline-sse-restoration"}\n\n',
      });
    }
    if (url.pathname === '/api/events')
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (url.pathname === '/api/chat/send' && method === 'POST') {
      const command = route.request().postDataJSON();
      expect(route.request().headers()['x-connection-id']).toBeUndefined();
      sends.push(command);
      turns.add(command.clientMsgId);
      if (sends.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await route
          .fulfill({ json: { accepted: true, clientMsgId: command.clientMsgId, sessionId } })
          .catch(() => {});
        return;
      }
      if (sends.length === 2)
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      return route.fulfill({
        json: { accepted: true, clientMsgId: command.clientMsgId, sessionId },
      });
    }
    if (url.pathname === '/api/home/briefing-chats') {
      if (method === 'POST') {
        registrations.push(route.request().postDataJSON());
        if (!acceptRegistration)
          return route.fulfill({ status: 503, json: { error: 'Offline receipt retry' } });
        registered = true;
        return route.fulfill({ json: { ...binding, createdAt: '2026-10-10T07:00:00Z' } });
      }
      return route.fulfill({
        json: registered ? [{ ...binding, createdAt: '2026-10-10T07:00:00Z' }] : [],
      });
    }
    if (
      method === 'POST' &&
      ['/api/chat/reconnect', '/api/chat/switch', '/api/sessions/suspend'].includes(url.pathname)
    )
      return route.fulfill({ json: { ok: true } });
    if (method !== 'GET')
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
    if (url.pathname === `/api/sessions/${sessionId}/meta`) {
      if (slowMetadata) await new Promise<void>((resolve) => setTimeout(resolve, 350));
      return route.fulfill({
        json: {
          sessionType: 'chat',
          isHidden: hidden,
          accountBinding: {
            accountId: 'work-account',
            accountLabel: 'Work OpenAI',
            model: 'luna-fixture',
          },
          modelSelection: { model: 'luna-fixture', models },
        },
      });
    }
    if (url.pathname === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  expect(await page.evaluate(() => localStorage.getItem('mitzo:transport'))).toBeNull();
  if (nativeMode)
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { Capacitor: { isNativePlatform(): boolean } }
        ).Capacitor.isNativePlatform(),
      ),
    ).toBe(true);
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].sessionId).toBeNull();
  expect(sends[0].accountId).toBe(binding.accountId);
  expect(sends[0].model).toBe(binding.model);
  expect(sends[0].sourceSnapshots).toEqual([
    expect.objectContaining({ kind: 'briefing', date: binding.date, revision: binding.revision }),
  ]);
  expect(registrations).toHaveLength(0);
  // HTTP delivery does not wait for the receiver's asynchronous socket startup.
  if (nativeMode) await expect.poll(() => sockets).toBeGreaterThanOrEqual(1);
  await page.reload();
  await expect.poll(() => sends.length).toBe(2);
  releaseFirst?.();
  expect(sends[1]).toEqual(sends[0]);
  expect(turns.size).toBe(1);
  if (nativeMode) {
    await expect.poll(() => sockets).toBeGreaterThanOrEqual(2);
    expect(sockets).toBeGreaterThanOrEqual(2);
    expect(websocketSends).toHaveLength(0);
    expect(chatSseRequests).toBe(0);
  } else expect(sockets).toBe(0);
  // Stay in the same app process while the restored acknowledgement remains pending.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('link', { name: 'Read briefing', exact: true }).click();
  await page.getByRole('button', { name: 'Ask Jeeves', exact: true }).click();
  const waitingPicker = page.getByRole('dialog');
  await waitingPicker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await expect(waitingPicker.getByRole('alert')).toHaveText(
    'This briefing conversation is awaiting assignment. Let its existing message finish restoring before asking again.',
  );
  await page.screenshot({ path: test.info().outputPath('briefing-awaiting-assignment.png') });
  await expect(page).toHaveURL(/\/briefings\/2026-10-10$/);
  expect(sends).toHaveLength(2);
  expect(registrations).toHaveLength(0);
  releaseSecond?.();
  await expect.poll(() => registrations.length).toBe(1);
  await waitingPicker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  const retry = page.getByRole('button', { name: 'Retry saving briefing link', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveAttribute(
    'href',
    `/briefings/${binding.date}?revision=${binding.revision}`,
  );
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  async function openWorkspace() {
    await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
    if ((await workspace.getAttribute('aria-expanded')) === 'false') await workspace.click();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
      binding.model,
    );
  }

  await openWorkspace();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    binding.model,
  );
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Thinking', exact: true })).toBeDisabled();
  await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
  expect(registrations).toEqual([binding]);
  // Confirm authoritative visibility before reusing a locally retained assignment.
  hidden = hideAssigned;
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  if (hideAssigned) {
    await expect(page).toHaveURL(/\/chat$/);
    await expect(
      page.getByRole('button', { name: 'Send launch prompt', exact: true }),
    ).toBeEnabled();
    await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
    expect(sends).toHaveLength(2);
    expect(turns.size).toBe(1);
    expect(registrations).toEqual([binding]);
    return;
  }
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await expect(retry).toBeVisible();
  await openWorkspace();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  expect(sends).toHaveLength(2);
  expect(turns.size).toBe(1);
  acceptRegistration = true;
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(registrations).toEqual([binding, binding]);
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  // Exercise delayed account hydration after the final reader-to-chat transition.
  slowMetadata = true;
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await openWorkspace();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
  expect(sends).toHaveLength(2);
  expect(turns.size).toBe(1);
  if (nativeMode) {
    expect(websocketSends).toHaveLength(0);
    expect(chatSseRequests).toBe(0);
  }
}

test('default SSE restores a briefing command after reload before assignment without a duplicate turn', async ({
  page,
}) => {
  await exerciseBriefingReloadRecovery(page);
});

test('default SSE allows a fresh draft when the recovered local conversation is hidden', async ({
  page,
}) => {
  await exerciseBriefingReloadRecovery(page, true);
});

for (const nativeMode of ['unready', 'lost-ack'] as const) {
  test(`native-default WS retains reviewed briefing delivery through cold reload with ${nativeMode} receipt`, async ({
    page,
  }) => {
    await exerciseBriefingReloadRecovery(page, false, nativeMode);
  });
}

test('reviewed launches let users collapse Workspace and reach Send at a short viewport', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 640 });
  await page.addInitScript(() => localStorage.removeItem('mitzo-workspace-controls-expanded'));
  await page.route('**/api/home/preferences', (route) =>
    route.fulfill({
      json: {
        ...fixtures['/api/home/preferences'],
        names: { briefing: 'M'.repeat(80), terminal: 'Minion' },
      },
    }),
  );
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.font = 'georgia';
    document.documentElement.dataset.accent = 'teal';
  });
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  await expect(workspace).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
    'luna-fixture',
  );
  await workspace.click();
  await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeHidden();
  const send = page.getByRole('button', { name: 'Send launch prompt', exact: true });
  await send.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport();
  await expect
    .poll(() =>
      send.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        );
      }),
    )
    .toBe(true);
  await send.click({ trial: true });
  await page.screenshot({ path: testInfo.outputPath('briefing-short-launch-collapsed.png') });
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
  const changedSessionId = 'changed-briefing-registration';
  const changedBinding = { ...binding, sessionId: changedSessionId, model: 'luna-other-fixture' };
  const savedBindings: Record<string, unknown>[] = [];
  const posts: unknown[] = [];
  const turns: Record<string, unknown>[] = [];
  let registered = false;
  let allowRegistration = false;
  let emptyReads = 0;
  let completed = false;
  let nickname = 'Jeeves';
  const accepted = new Map<string, Record<string, unknown>>();
  const websocketSends: unknown[] = [];
  function accept(command: Record<string, unknown>) {
    turns.push(command);
    const assignedId = command.model === changedBinding.model ? changedSessionId : sessionId;
    accepted.set(assignedId, command);
    return assignedId;
  }
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
      if (message.type === 'send') websocketSends.push(message);
      if (message.type === 'switch_session') {
        const command = accepted.get(message.sessionId);
        if (!command) return;
        socket.send(
          JSON.stringify({
            type: 'session_state_changed',
            sessionId: message.sessionId,
            state: 'running',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'user_message',
            sessionId: message.sessionId,
            messageId: command.clientMsgId,
            text: command.prompt,
            sourceSnapshots: command.sourceSnapshots,
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'session_state_changed',
            sessionId: message.sessionId,
            state: 'idle',
          }),
        );
        completed = true;
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/chat/send' && route.request().method() === 'POST') {
      expect(route.request().headers()['x-connection-id']).toBeUndefined();
      const command = route.request().postDataJSON();
      return route.fulfill({
        json: { accepted: true, clientMsgId: command.clientMsgId, sessionId: accept(command) },
      });
    }

    if (url.pathname === '/api/home/briefing-chats') {
      if (route.request().method() === 'POST') {
        posts.push(route.request().postDataJSON());
        if (!allowRegistration)
          return route.fulfill({ status: 503, json: { error: 'Offline registration failed' } });
        registered = true;
        const saved = { ...route.request().postDataJSON(), createdAt: '2026-10-10T07:00:00Z' };
        if (!savedBindings.some((entry) => entry.sessionId === saved.sessionId))
          savedBindings.push(saved);
        return route.fulfill({ json: saved });
      }
      if (!registered) emptyReads += 1;
      return route.fulfill({
        json: registered ? savedBindings : [],
      });
    }
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
    if (url.pathname === '/api/home/preferences')
      return route.fulfill({
        json: {
          ...fixtures['/api/home/preferences'],
          names: { briefing: nickname, terminal: 'Minion' },
        },
      });
    const models = [
      { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
      { id: 'luna-other-fixture', label: 'Luna other fixture', reasoningEfforts: ['low', 'high'] },
    ];
    if (url.pathname === '/api/accounts')
      return route.fulfill({ json: [{ id: 'work-account', label: 'Work OpenAI', models }] });
    if (url.pathname === '/api/repository-workspaces/catalog')
      return route.fulfill({ json: { available: false, repositories: [] } });
    if (
      [sessionId, changedSessionId].some(
        (id) => url.pathname === `/api/chat/web-search-consent/${id}`,
      )
    )
      return route.fulfill({ json: { ok: true, grant: 'denied', revision: 0, updatedAt: null } });
    if ([sessionId, changedSessionId].some((id) => url.pathname === `/api/sessions/${id}/messages`))
      return route.fulfill({ json: [] });
    if ([sessionId, changedSessionId].some((id) => url.pathname === `/api/sessions/${id}/meta`))
      return route.fulfill({
        json: {
          sessionType: 'chat',
          isHidden: false,
          accountBinding: {
            accountId: 'work-account',
            accountLabel: 'Work OpenAI',
            model: 'luna-fixture',
          },
          modelSelection: {
            model: url.pathname.includes(changedSessionId) ? changedBinding.model : binding.model,
            models,
          },
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
  const profile = page.getByRole('combobox', { name: 'Agent profile', exact: true });
  await expect(profile).toBeEnabled();
  await expect(profile).toHaveValue('');
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry saving briefing link', exact: true });
  await expect(retry).toBeVisible();
  expect(completed).toBe(true);
  expect(turns).toHaveLength(1);
  expect(posts).toEqual([binding]);
  await page.getByRole('button', { name: 'Change account or model', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await expect(retry).toBeVisible();
  expect(turns).toHaveLength(1);
  expect(posts).toEqual([binding]);

  await expect.poll(() => emptyReads).toBeGreaterThan(0);
  async function retained() {
    await expect(page.getByText(`${nickname} · 2026-10-10`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveAttribute(
      'href',
      `/briefings/${binding.date}?revision=${binding.revision}`,
    );
    const label = page.getByText(`${nickname} · 2026-10-10`, { exact: true });
    const read = page.getByRole('link', { name: 'Read briefing', exact: true });
    const change = page.getByRole('button', { name: 'Change account or model', exact: true });
    const layout = await label.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const column = element.closest('.briefing-chat-banner')!.getBoundingClientRect();
      return {
        left: bounds.left - column.left,
        gutter: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--page-gutter'),
        ),
        gap: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--space-2'),
        ),
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(layout.gutter);
    const labelBounds = (await label.boundingBox())!;
    const readBounds = (await read.boundingBox())!;
    const rowGap =
      readBounds.x >= labelBounds.x + labelBounds.width
        ? readBounds.x - labelBounds.x - labelBounds.width
        : readBounds.y - labelBounds.y - labelBounds.height;
    expect(rowGap).toBeGreaterThanOrEqual(layout.gap);
    for (const control of [read, change])
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
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
    const workspace = page.getByRole('button', { name: /^Workspace controls/ });
    await workspace.click();
    await expect(
      page.getByRole('textbox', { name: 'Message Mitzo', exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(
        `briefing-registration-error-${appearance.theme}-${appearance.font}-${appearance.accent}.png`,
      ),
      animations: 'disabled',
    });
    await workspace.click();
  }
  nickname = 'M'.repeat(80);
  await page.reload();
  await expect(retry).toBeVisible();
  await retained();
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  await workspace.click();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('briefing-registration-long-name.png'),
    animations: 'disabled',
  });
  await workspace.click();
  allowRegistration = true;
  await retry.click();
  await expect(retry).toHaveCount(0);
  await retained();
  expect(posts).toEqual([binding, binding]);
  expect(turns).toHaveLength(1);
  // Restore the regular fixture after the separate long-name and appearance checks.
  nickname = 'Jeeves';
  await page.reload();
  await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
  await retained();
  await page.getByRole('button', { name: 'Change account or model', exact: true }).click();
  const changedPicker = page.getByRole('dialog');
  await changedPicker
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption(changedBinding.model);
  await changedPicker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${changedSessionId}$`));
  await expect.poll(() => posts.length).toBe(3);
  expect(posts).toEqual([binding, binding, changedBinding]);
  expect(turns).toHaveLength(2);
  expect(websocketSends).toHaveLength(0);
  expect(turns[1].sourceSnapshots).toEqual(turns[0].sourceSnapshots);
  expect(turns[1].model).toBe(changedBinding.model);
  await expect(retry).toHaveCount(0);
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
      const workspace = page.getByRole('button', { name: /^Workspace controls/ });
      await workspace.click();
      await expect(
        page.getByRole('textbox', { name: 'Message Mitzo', exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: testInfo.outputPath(`briefing-lookup-error-${failed}-${recovered}.png`),
        animations: 'disabled',
      });
      await workspace.click();
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

test('daily quote setting preserves saved truth and suppresses delivery until enabled', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  let preferences = {
    revision: 1,
    showDailyQuote: false,
    names: { briefing: 'Jeeves', terminal: 'Minion' },
    pins: [{ kind: 'session', id: 'session-0', title: 'Quarterly planning review' }],
  };
  const writes: Record<string, unknown>[] = [];
  let quoteRequests = 0;
  let releasePreferences!: () => void;
  const pending = new Promise<void>((resolve) => {
    releasePreferences = resolve;
  });
  let holdPreferences = true;
  let failSave = false;
  let conflictSave = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/home/quote') quoteRequests++;
  });
  await page.route('**/api/home/preferences', async (route) => {
    if (route.request().method() === 'GET') {
      if (holdPreferences) await pending;
      return route.fulfill({ json: preferences });
    }
    const patch = route.request().postDataJSON();
    writes.push(patch);
    if (failSave) return route.fulfill({ status: 503, json: { error: 'Offline save failure' } });
    if (conflictSave) {
      conflictSave = false;
      preferences = {
        ...preferences,
        revision: preferences.revision + 1,
        showDailyQuote: true,
        names: { briefing: 'Remote name', terminal: 'Alfred' },
        pins: [{ kind: 'session', id: 'session-1', title: 'Remote bookmark' }],
      };
    }
    if (patch.revision !== preferences.revision)
      return route.fulfill({ status: 409, json: { error: 'changed' } });
    expect(Object.keys(patch).sort()).toEqual(['revision', 'showDailyQuote']);
    preferences = { ...preferences, ...patch, revision: preferences.revision + 1 };
    return route.fulfill({ json: preferences });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  expect(quoteRequests).toBe(0);
  holdPreferences = false;
  releasePreferences();
  await expect(page.getByRole('button', { name: 'Manage pins' })).toBeEnabled();
  await expect(page.getByRole('link', { name: /Quote of the day by/ })).toHaveCount(0);
  expect(quoteRequests).toBe(0);
  await page.goto('/settings');
  const toggle = page.getByRole('checkbox', { name: 'Show daily quote on Today' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  for (const variant of [
    { theme: 'dark', font: 'system', accent: 'lavender' },
    { theme: 'light', font: 'georgia', accent: 'teal' },
  ]) {
    await page.getByLabel('Theme', { exact: true }).selectOption(variant.theme);
    await page.getByLabel('Font', { exact: true }).selectOption(variant.font);
    await page
      .getByRole('radio', { name: variant.accent === 'teal' ? 'Teal' : 'Lavender', exact: true })
      .check();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '18px';
    });
    const geometry = await toggle.evaluate((element) => {
      const label = element.closest('label')!;
      const sample = document.createElement('span');
      sample.style.color = 'var(--workspace-accent)';
      document.body.append(sample);
      const accent = getComputedStyle(element).accentColor === getComputedStyle(sample).color;
      sample.remove();
      return {
        height: label.getBoundingClientRect().height,
        inherited:
          getComputedStyle(label).fontFamily === getComputedStyle(document.body).fontFamily,
        accent,
        overflow:
          document.querySelector('.workspace-page')!.scrollWidth >
          document.querySelector('.workspace-page')!.clientWidth,
      };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.inherited).toBe(true);
    expect(geometry.accent).toBe(true);
    expect(geometry.overflow).toBe(false);
    await toggle.focus();
    await page.screenshot({
      path: testInfo.outputPath(`quote-setting-${variant.theme}-${variant.font}.png`),
      animations: 'disabled',
    });
  }
  failSave = true;
  await toggle.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t save' })).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  const review = page.getByRole('button', { name: 'Review current setting', exact: true });
  expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await review.click();
  await expect(toggle).toBeEnabled();
  expect(writes).toHaveLength(1);
  failSave = false;
  conflictSave = true;
  await toggle.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'changed on another device' }),
  ).toBeVisible();
  await expect(toggle).toBeChecked();
  await review.click();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  expect(writes.at(-1)).toEqual({ revision: 2, showDailyQuote: false });
  expect(preferences.names.briefing).toBe('Remote name');
  expect(preferences.pins[0].id).toBe('session-1');
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Quote of the day by/ })).toBeVisible();
  expect(quoteRequests).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath('quote-enabled-today.png'),
    animations: 'disabled',
  });
  await page.goto('/settings');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Manage pins' })).toBeEnabled();
  await expect(page.getByRole('link', { name: /Quote of the day by/ })).toHaveCount(0);
  expect(quoteRequests).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath('quote-disabled-today.png'),
    animations: 'disabled',
  });
  await page.goto('/quotes/2026-10-10');
  await expect(page.getByRole('heading', { name: 'A thought for today' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the source', exact: true })).toBeVisible();
  expect(quoteRequests).toBe(2);
});

for (const appearance of [
  { theme: 'dark', accent: 'lavender', font: 'system' },
  { theme: 'light', accent: 'teal', font: 'georgia' },
]) {
  test(`chat activity groups every provider between responses in ${appearance.theme}`, async ({
    page,
  }, testInfo) => {
    const sessionId = 'offline-activity';
    const messages = [
      {
        messageId: 'user',
        role: 'user',
        blocks: [{ blockId: 'user', blockType: 'text', content: 'Check the records.' }],
      },
      {
        messageId: 'before',
        role: 'assistant',
        blocks: [{ blockId: 'before', blockType: 'text', content: 'I will check the records.' }],
      },
      {
        messageId: 'thinking',
        role: 'assistant',
        blocks: [
          {
            blockId: 'thought',
            blockType: 'thinking',
            content: 'Checking the latest records and their status.',
          },
        ],
      },
      {
        messageId: 'tools',
        role: 'assistant',
        blocks: [
          {
            blockId: 'failed',
            blockType: 'tool_use',
            content: '',
            toolName: 'Bash',
            toolInput: 'read records',
            toolResult: 'Permission denied',
            toolError: true,
          },
          {
            blockId: 'read',
            blockType: 'tool_use',
            content: '',
            toolName: 'Read',
            toolInput: '/workspace/very-long-report-name-with-records-and-updates.md',
            toolResult: 'Records retrieved successfully',
          },
        ],
      },
      {
        messageId: 'after',
        role: 'assistant',
        blocks: [{ blockId: 'after', blockType: 'text', content: 'Here are the results.' }],
      },
    ];
    await page.addInitScript((appearance) => {
      localStorage.setItem('mitzo-theme', appearance.theme);
      localStorage.setItem('mitzo-accent', appearance.accent);
      localStorage.setItem('mitzo-font', appearance.font);
    }, appearance);
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: messages });
      if (path === `/api/sessions/${sessionId}/meta`)
        return route.fulfill({ json: { sessionType: 'chat' } });
      if (path === `/api/sessions/${sessionId}/symposium/status`)
        return route.fulfill({ json: { sessionId, config: null, seats: [] } });
      return route.fallback();
    });
    await page.goto(`/chat/${sessionId}`);
    const toggle = page.getByRole('button', { name: /Agent at work/ });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Read');
    await expect(toggle).toContainText('1 failed');
    await expect(page.getByText('I will check the records.', { exact: true })).toBeVisible();
    await expect(page.getByText('Here are the results.', { exact: true })).toBeVisible();
    const alignment = await page.locator('.msg-bubble-group--user').evaluate((user) => {
      const chat = user.closest('.chat-messages')!;
      return Math.abs(
        user.getBoundingClientRect().right -
          chat.getBoundingClientRect().right +
          parseFloat(getComputedStyle(chat).paddingRight),
      );
    });
    expect(alignment).toBeLessThan(2);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: testInfo.outputPath(`activity-collapsed-${appearance.theme}.png`),
      animations: 'disabled',
    });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /^Thought/ })).toBeVisible();
    await page.getByRole('button', { name: /^Thought/ }).click();
    await expect(
      page.getByText('Checking the latest records and their status.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Read/ }).click();
    await expect(page.getByText('Records retrieved successfully', { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`activity-expanded-${appearance.theme}.png`),
      animations: 'disabled',
    });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.agent-activity-details')).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '125%';
    });
    if (testInfo.project.name.startsWith('mobile'))
      await page.setViewportSize({ width: 320, height: 740 });
    await toggle.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`activity-large-text-${appearance.theme}.png`),
      animations: 'disabled',
    });
  });
}
