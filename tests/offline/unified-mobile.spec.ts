import {
  enableBriefingRuntime,
  reviewBriefingRuntime,
  installBriefingSse,
} from '../support/briefing-owned-runtime';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
} from '../../packages/protocol/src/index';
import { OrdinaryRuntimeFirstCommandSchema } from '../../packages/protocol/src/local-codex-first-command';
import { settingRow, openChatSetting } from '../support/chat-settings';
import { HTML_PREVIEW_BOOTSTRAP, htmlPreviewPolicy } from '../../server/html-preview-shell';
import { disabledLocalCapabilities } from '../support/disabled-local-capabilities';
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

async function openAgentSettings(page: Page) {
  const trigger = page.getByRole('button', { name: /^Workspace controls,/ });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(page.getByRole('region', { name: 'Agent settings', exact: true })).toBeVisible();
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
  await expect(page.getByRole('dialog', { name: 'Resources', exact: true })).toBeVisible();
  // Resources uses the shared native dialog; composer tool popovers retain motion.
  const tray = await page.locator('.chat-resource-dialog').boundingBox();
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
    .getByRole('dialog', { name: 'Resources', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: 'Resources', exact: true })).toBeHidden();
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

test('motion: closing menus hold their final frame without flashing or moving chat controls', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const finishes: { kind: string; opacity: string; height: number }[] = [];
    Object.assign(window, { exitFrames: finishes });
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (frames, options) {
      const animation = original.call(this, frames, options);
      const final = animation.effect?.getKeyframes().at(-1);
      if (final?.opacity === '0') {
        // Observe the native endpoint before React's finished handler can hide it.
        void animation.finished
          .then(() =>
            finishes.push({
              kind: animation.id,
              opacity: getComputedStyle(this).opacity,
              height: this.getBoundingClientRect().height,
            }),
          )
          .catch(() => {});
      }
      return animation;
    };
  });
  await page.goto('/chat');
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await draft.fill('Preserve this draft');
  const composer = page.locator('.chat-input--compact');
  const header = page.locator('.workspace-controls-heading');
  const toggle = page.getByRole('button', { name: 'More composer actions', exact: true });
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'dark' ? 'mint' : 'teal';
      document.documentElement.dataset.font = theme === 'dark' ? 'system' : 'georgia';
      await document.fonts.ready;
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
          .map((animation) => animation.finished.catch(() => {})),
      );
    }, theme);
    // Font substitution also schedules the settings panel's ResizeObserver
    // budget measurement. Settle that layout before measuring the motion baseline.
    await page.evaluate(async () => {
      await document.fonts.ready;
      let previous = '';
      let stableFrames = 0;
      for (let frame = 0; frame < 60 && stableFrames < 3; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const geometry = JSON.stringify(
          ['.chat-input--compact', '.workspace-controls-heading', '.agent-settings-panel'].map(
            (selector) => {
              const element = document.querySelector(selector);
              const box = element?.getBoundingClientRect();
              return box ? [box.x, box.y, box.width, box.height] : null;
            },
          ),
        );
        stableFrames = geometry === previous ? stableFrames + 1 : 0;
        previous = geometry;
      }
      if (stableFrames < 3) throw new Error('Appearance layout did not settle before motion check');
    });
    const baseline = { composer: await composer.boundingBox(), header: await header.boundingBox() };
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Commands', exact: true })).toBeVisible();
    await composer.screenshot({
      path: testInfo.outputPath(`menu-${theme}.png`),
      animations: 'disabled',
    });
    await toggle.click();
    await expect(composer.locator('.composer-tools')).toBeHidden();
    await workspace.click();
    const panel = page.locator('.workspace-controls > .motion-disclosure');
    await expect(panel).toBeVisible();
    await panel.screenshot({
      path: testInfo.outputPath(`workspace-${theme}.png`),
      animations: 'disabled',
    });
    await workspace.click();
    await expect(panel).toBeHidden();
    await expect(draft).toHaveValue('Preserve this draft');
    expect(await composer.boundingBox()).toEqual(baseline.composer);
    expect(await header.boundingBox()).toEqual(baseline.header);
  }
  const frames = await page.evaluate(
    () =>
      (
        window as Window & {
          exitFrames: { kind: string; opacity: string; height: number }[];
        }
      ).exitFrames,
  );
  expect(frames).toHaveLength(4);
  expect(frames.every((frame) => Number(frame.opacity) === 0)).toBe(true);
  // Both the composer menu and compact settings are popovers: they retain
  // their full geometry while the transparent exit frame awaits React's hide.
  expect(frames.every((frame) => frame.kind === 'mitzo:popover')).toBe(true);
  expect(frames.every((frame) => frame.height > 0)).toBe(true);
});

test('composer: commands use a quiet icon with discoverable labels', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/chat');
  const commands = page.getByRole('button', { name: 'Commands', exact: true });
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await draft.fill('Keep this draft while browsing commands');
  await expect(commands).toBeVisible();
  const bounds = (await commands.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(bounds.height + 1);
  await expect(commands.locator('[data-icon="command"]')).toBeVisible();
  await expect(commands.locator('.chat-input-command-label')).toBeHidden();
  await commands.focus();
  await expect(commands.locator('.chat-input-command-label')).toBeVisible();
  await commands.press('Enter');
  await expect(draft).toHaveValue('Keep this draft while browsing commands');
  await expect(draft).toBeFocused();
  await draft.click();
  await page.mouse.move(0, 0);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'dark' ? 'coral' : 'teal';
      document.documentElement.dataset.font = theme === 'dark' ? 'system' : 'georgia';
    }, theme);
    await page.locator('.chat-input--compact .chat-input-row').screenshot({
      path: testInfo.outputPath(`composer-icons-${theme}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
  await draft.fill('Keep this draft while browsing commands');
  await expect(commands.locator('.chat-input-command-label')).toBeVisible();
  // WebKit can report 43.99997px for a 44px control during menu motion.
  expect(Math.round((await commands.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await commands.click();
  await expect(draft).toHaveValue('Keep this draft while browsing commands');
  await page.keyboard.press('Escape');
});

test('motion: rapid toggles continue from the visible menu and disclosure frame', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeVisible();
  const samples = await page.evaluate(async () => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // Freeze the two sampled surfaces at creation: a loaded WebKit worker can
    // finish a short entrance before the next animation frame is sampled.
    const nativeAnimate = Element.prototype.animate;
    const sampled = new Set<Element>();
    Element.prototype.animate = function (keyframes, options) {
      const animation = nativeAnimate.call(this, keyframes, options);
      if (sampled.has(this)) animation.pause();
      return animation;
    };
    const animationFor = async (surface: Element, previous?: Animation) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const animation = surface
          .getAnimations()
          .find((entry) => entry !== previous && entry.id.startsWith('mitzo:'));
        if (animation) return animation;
        await nextFrame();
      }
      throw new Error('Expected the sampled surface to start a Mitzo animation');
    };
    const results: { before: number; after: number; heightBefore: number; heightAfter: number }[] =
      [];
    try {
      for (const [toggleSelector, surfaceSelector] of [
        ['.composer-tools-toggle', '.composer-tools'],
        ['.workspace-controls-toggle', '.workspace-controls > .motion-disclosure'],
      ]) {
        const toggle = document.querySelector<HTMLElement>(toggleSelector)!;
        const surface = document.querySelector<HTMLElement>(surfaceSelector)!;
        sampled.add(surface);
        toggle.click();
        await nextFrame();
        for (let interruption = 0; interruption < 2; interruption++) {
          const current = await animationFor(surface);
          current.pause();
          current.currentTime = Number(current.effect!.getTiming().duration) / 2;
          const before = Number(getComputedStyle(surface).opacity);
          const heightBefore = surface.getBoundingClientRect().height;
          toggle.click();
          await nextFrame();
          const replacement = await animationFor(surface, current);
          replacement.pause();
          replacement.currentTime = 0;
          results.push({
            before,
            after: Number(getComputedStyle(surface).opacity),
            heightBefore,
            heightAfter: surface.getBoundingClientRect().height,
          });
        }
        // Settle the final entrance and exit before sampling the next surface.
        surface.getAnimations().forEach((animation) => animation.finish());
        await nextFrame();
        toggle.click();
        await nextFrame();
        surface.getAnimations().forEach((animation) => animation.finish());
        await nextFrame();
      }
      return results;
    } finally {
      Element.prototype.animate = nativeAnimate;
    }
  });
  expect(samples).toHaveLength(4);
  for (const sample of samples) {
    expect(sample.before).toBeGreaterThan(0);
    expect(sample.before).toBeLessThan(1);
    expect(sample.after).toBeCloseTo(sample.before, 3);
    expect(Math.abs(sample.heightAfter - sample.heightBefore)).toBeLessThan(3);
  }
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
  await expect(
    page.getByRole('button', { name: 'Attach images or PDF', exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole('button', { name: 'Attach images or PDF', exact: true }),
  ).toBeVisible();
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
    if (await disabledLocalCapabilities(route, url)) return;
    if (url.pathname.startsWith('/api/')) {
      // No app mutation or model request can leave this fixture suite.
      if (route.request().method() !== 'GET')
        return route.fulfill({ status: 405, json: { error: 'Offline UI test' } });
      if (url.pathname === '/api/html-preview')
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'content-security-policy': htmlPreviewPolicy() },
          body: HTML_PREVIEW_BOOTSTRAP,
        });
      if (/^\/api\/sessions\/[^/]+\/outputs$/.test(url.pathname))
        return route.fulfill({ json: { outputs: [], candidates: [] } });
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

for (const width of [320, 390, 440]) {
  test(`every mobile collection keeps one wordmark, one palette and reachable navigation (${width}px)`, async ({
    page,
    isMobile,
  }, testInfo) => {
    test.skip(!isMobile, 'Mobile shell');
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
  });
}

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
      .evaluate((element) => getComputedStyle(element).color),
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

test('desktop Work keeps legacy collection actions visible with one compact heading', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Desktop Work collection');
  await page.goto('/todos');
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const collection = page.locator('.telos-legacy-page');
    const heading = collection.locator('.todo-collection-heading');
    await expect(collection.getByRole('button', { name: 'Add outcome' })).toBeVisible();
    await expect(collection.getByRole('button', { name: 'Refresh Telos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Work', exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Work', exact: true })).toBeVisible();
    expect((await heading.boundingBox())!.height).toBeLessThanOrEqual(80);
    for (const button of await heading.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`work-legacy-${width}.png`) });
  }
});

test('desktop Work starts an unsent planning draft from the canonical collection', async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, 'Desktop Work collection');
  await page.route('**/api/todos', (route) =>
    route.fulfill({ json: { profiles: ['telos'], items: [] } }),
  );
  const sends: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat/send')
      sends.push(request.url());
  });
  for (const width of [1280, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/todos');
    const collection = page.locator('.telos-canonical-page');
    const heading = collection.locator('.todo-collection-heading');
    const start = heading.getByRole('button', { name: 'New item', exact: true });
    await expect(start).toBeVisible();
    await expect(heading.getByRole('button', { name: 'Refresh Telos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Telos outcomes', exact: true })).toHaveCount(1);
    const headerBox = (await heading.boundingBox())!;
    const contentBox = (await collection.locator('.todo-scroll').boundingBox())!;
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(contentBox.y + 1);
    expect(headerBox.x).toBeGreaterThanOrEqual(0);
    expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(width);
    for (const button of await heading.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`work-canonical-${width}.png`) });
    await start.click();
    await expect(page).toHaveURL(/\/chat\?draft=[^&]+$/);
    await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
      /Help me plan a new Telos outcome\.[\s\S]*Save a draft only after I review it[\s\S]*Do not start work\./,
    );
    await expect(page.getByPlaceholder('Milestones — first line is the next action')).toHaveCount(
      0,
    );
    expect(sends).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`work-planning-${width}.png`) });
  }
});

test('accent-filled controls retain paired foregrounds and warnings use outline colors', async ({
  page,
}) => {
  const html = await readFile(resolve('frontend/dist/index.html'), 'utf8');
  const stylesheets = [...html.matchAll(/href="([^"\s]+\.css)"/g)];
  const css = (
    await Promise.all(
      [
        ...stylesheets.map((match) => resolve('frontend/dist', match[1].slice(1))),
        // This component brings its CSS with its lazy route. The static
        // markup fixture must load that stylesheet alongside its markup.
        resolve('frontend/src/components/CodexQueueStatus.css'),
      ].map((path) => readFile(path, 'utf8')),
    )
  ).join('\n');
  expect(css).toContain('.mode-pill--active');
  expect(css).toContain('--color-on-accent');
  await page.setContent(`<style>${css}</style>
    <span id="paired-reference" style="color:var(--color-on-accent)">Reference</span>
    <span id="status-reference" style="color:var(--color-warning)">Outline warning reference</span>
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
          .locator('.codex-queue-status-attention')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe('rgba(0, 0, 0, 0)');
      expect(
        await page
          .locator('.html-preview-card-content')
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe('rgb(255, 255, 255)');
    }
  }
});

async function applyResponsivenessAppearance(
  page: Page,
  appearance: { theme: string; accent: string; font: string },
) {
  await page.evaluate(async (selection) => {
    const root = document.documentElement;
    root.dataset.theme = selection.theme;
    root.dataset.accent = selection.accent;
    root.dataset.font = selection.font;
    localStorage.setItem('mitzo-theme', selection.theme);
    localStorage.setItem('mitzo-accent', selection.accent);
    localStorage.setItem('mitzo-font', selection.font);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, appearance);
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance.theme);
  await expect(page.locator('html')).toHaveAttribute('data-accent', appearance.accent);
  await expect(page.locator('html')).toHaveAttribute('data-font', appearance.font);
}

for (const appearance of [
  { theme: 'dark', accent: 'mint', font: 'georgia' },
  { theme: 'light', accent: 'teal', font: 'verdana' },
]) {
  test(`Attention exposes an unavailable read and retries without claiming all clear (${appearance.theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    let available = false;
    await page.route('**/api/todos*', (route) =>
      route.fulfill({
        status: available ? 200 : 503,
        json: available ? fixtures['/api/todos'] : { error: 'Unavailable' },
      }),
    );
    await page.goto('/focus');
    await applyResponsivenessAppearance(page, appearance);
    const section = page.locator('.attention-section');
    await expect(section.getByRole('alert')).toContainText(
      'Couldn’t load attention items. Try again.',
    );
    await expect(section.getByText('all clear', { exact: true })).toHaveCount(0);
    await section.screenshot({
      path: testInfo.outputPath(
        `responsiveness-attention-unavailable-${appearance.theme}-${appearance.accent}-${appearance.font}.png`,
      ),
      animations: 'disabled',
    });
    available = true;
    await section.getByRole('button', { name: 'Retry attention items' }).click();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(section.locator('.attention-card').first()).toBeVisible();
  });

  test(`a rejected outcome swipe restores its row and shows the unconfirmed change (${appearance.theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.route('**/api/todos/*/action', (route) =>
      route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
    );
    await page.goto('/todos');
    await applyResponsivenessAppearance(page, appearance);
    const card = page.locator('.todo-card').first();
    await expect(card).toBeVisible();
    await card.evaluate((element) => {
      for (const [type, clientX] of [
        ['touchstart', 0],
        ['touchmove', 150],
        ['touchend', 150],
      ] as const) {
        const event = new Event(type, { bubbles: true });
        Object.defineProperty(event, 'touches', { value: [{ clientX, clientY: 20 }] });
        element.dispatchEvent(event);
      }
    });
    const error = page.getByText('Couldn’t confirm this change. Refresh to check its status.', {
      exact: true,
    });
    await expect(error).toBeVisible();
    await expect(error).toBeInViewport();
    await expect(card).toHaveCSS('opacity', '1');
    await expect(card).toBeVisible();
    await expect(card.locator('.todo-card-title')).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(
        `responsiveness-outcome-failed-swipe-${appearance.theme}-${appearance.accent}-${appearance.font}.png`,
      ),
      animations: 'disabled',
    });
  });

  test(`Calendar exposes temporary API failure on mobile and desktop (${appearance.theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
    await page.route('**/api/calendar?**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unavailable' }),
      }),
    );
    await page.goto('/calendar');
    await applyResponsivenessAppearance(page, appearance);
    await expect(page.getByRole('alert')).toHaveText(
      'Couldn’t load calendar. Check the connection and try again.',
    );
    // Mobile uses the shared shell rather than a duplicate page heading.
    if (!isMobile)
      await expect(page.getByRole('heading', { name: 'Calendar', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next period', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(
        `responsiveness-calendar-unavailable-${appearance.theme}-${appearance.accent}-${appearance.font}.png`,
      ),
      animations: 'disabled',
    });
  });
}

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
    if (path.endsWith('/meta')) return route.fulfill({ json: { sessionType: 'symposium' } });
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

test('combined conversation uses the approved Agents header and ordinary composer while retaining approval receipts', async ({
  page,
  isMobile,
}, testInfo) => {
  const queued = await fixtureSymposium(page);
  for (const width of isMobile ? [320, 390] : [1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('https://mitzo-ui.test/chat/offline-symposium');
    const agents = page.getByRole('button', { name: 'Agents, Architect, Reviewer' });
    await expect(agents).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Symposium conversations' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Message recipient' })).toHaveCount(0);
    const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const choose = async (name: string) => {
      await page.getByRole('button', { name: 'Choose who replies' }).click();
      await page.getByRole('checkbox', { name, exact: true }).click();
    };
    await choose('Reviewer');
    await draft.fill('Review this change, keeping the selected recipient explicit.');
    await agents.click();
    await page.getByRole('button', { name: 'Preview Architect conversation' }).click();
    await expect(page.getByRole('dialog', { name: 'Architect conversation' })).toBeVisible();
    await page.getByRole('button', { name: 'Close Agents' }).click();
    await expect(draft).toHaveValue('Review this change, keeping the selected recipient explicit.');
    await choose('Architect');
    await expect(draft).toHaveValue('');
    await choose('Reviewer');
    await expect(draft).toHaveValue('Review this change, keeping the selected recipient explicit.');
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = 'teal';
        document.documentElement.dataset.font = 'georgia';
      }, theme);
      await expect(draft).toBeInViewport();
      expect(await draft.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Georgia');
      const queue = page.getByRole('button', { name: 'Queue for approval', exact: true });
      await expect(queue).toBeInViewport();
      if (isMobile) expect((await queue.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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

test('combined conversation empty and failed status retain Access and drafts without implicit sending', async ({
  page,
}, testInfo) => {
  let finishLoading!: () => void;
  const ready = new Promise<void>((resolve) => (finishLoading = resolve));
  const queued = await fixtureSymposium(page, { empty: true, ready });
  await page.goto('https://mitzo-ui.test/chat/offline-symposium');
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toBeDisabled();
  await expect(page.locator('.chat-input[aria-busy="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Access', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('symposium-loading.png'),
    animations: 'disabled',
  });
  finishLoading();
  await expect(page.getByRole('button', { name: 'Agents, Architect, Reviewer' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Access', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('symposium-error.png'),
    animations: 'disabled',
  });
  expect(queued).toHaveLength(0);
});

async function exerciseBriefingReloadRecovery(
  page: Page,
  hideAssigned = false,
  nativeMode?: 'unready' | 'lost-ack' | 'sse',
) {
  test.setTimeout(60_000);
  const retainedGeneric = !!nativeMode && nativeMode !== 'sse';
  const inventory = retainedGeneric ? null : await enableBriefingRuntime(page);
  // Today must reopen this historical fixture's date, including after reload.
  // Fix Date at browser-local midday while HTTP/reload timers continue running.
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 9, 10, 12).getTime()));
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 900 });
  await page.addInitScript(() => {
    localStorage.removeItem('mitzo:transport');
    localStorage.removeItem('mitzo-workspace-controls-expanded');
    // Recreating either receiver cannot depend on the previous window's sessionStorage.
    sessionStorage.clear();
  });
  if (nativeMode)
    await page.addInitScript((mode) => {
      // Retain diagnostic WS coverage; SSE exercises the unmodified native default.
      if (mode !== 'sse') localStorage.setItem('mitzo:transport', 'ws');
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
    }, nativeMode);
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
  await page.exposeFunction('briefingFixtureSseOpened', () => {
    chatSseRequests++;
  });
  await page.addInitScript(() => {
    // Keep this receiver alive across a finite intercepted response. The
    // constructor reports each real transport selection, including reload.
    class FixtureEventSource extends EventTarget {
      readyState = 1;
      constructor(url: string) {
        super();
        if (url.includes('/api/chat/events')) {
          void (
            window as unknown as { briefingFixtureSseOpened(): Promise<void> }
          ).briefingFixtureSseOpened();
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent('welcome', {
                  data: JSON.stringify({ connectionId: 'offline-sse-restoration' }),
                }),
              ),
            0,
          );
        }
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = FixtureEventSource as unknown as typeof EventSource;
  });
  const websocketSends: unknown[] = [];
  await page.routeWebSocket('**/*', (socket) => {
    sockets += 1;
    if (!nativeMode || nativeMode === 'sse') {
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
    if (
      url.pathname === (retainedGeneric ? '/api/chat/send' : '/api/chat/local-codex/send') &&
      method === 'POST'
    ) {
      const command = retainedGeneric
        ? route.request().postDataJSON()
        : OrdinaryRuntimeFirstCommandSchema.parse(route.request().postDataJSON());
      if (retainedGeneric) expect(route.request().headers()['x-connection-id']).toBeUndefined();
      else expect(route.request().headers()['x-connection-id']).toBeTruthy();
      sends.push(command);
      turns.add(command.clientMsgId);
      if (sends.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await route
          .fulfill({
            ...(retainedGeneric
              ? { json: { accepted: true, clientMsgId: command.clientMsgId, sessionId } }
              : {
                  status: 202,
                  json: {
                    ok: true,
                    clientMsgId: command.clientMsgId,
                    sessionId,
                    state: 'consumed',
                    dispatched: true,
                  },
                }),
          })
          .catch(() => {});
        return;
      }
      if (sends.length === 2)
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
        });
      return route.fulfill({
        ...(retainedGeneric
          ? { json: { accepted: true, clientMsgId: command.clientMsgId, sessionId } }
          : {
              status: 202,
              json: {
                ok: true,
                clientMsgId: command.clientMsgId,
                sessionId,
                state: 'consumed',
                dispatched: true,
              },
            }),
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
          ...(inventory
            ? {
                runtimeBinding: {
                  version: 2,
                  account: inventory.accounts[0].account,
                  harness: { implementation: 'codex' },
                  execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
                },
                runtimeCommandScope: 'first-command-only',
              }
            : {}),
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
  expect(await page.evaluate(() => localStorage.getItem('mitzo:transport'))).toBe(
    nativeMode && nativeMode !== 'sse' ? 'ws' : null,
  );
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
  const launchDraftId = new URL(page.url()).searchParams.get('draft')!;
  if (!retainedGeneric) await reviewBriefingRuntime(page);
  await page
    .getByRole('textbox', { name: 'Message Mitzo', exact: true })
    .fill('Keep my unsent follow-up');
  if (retainedGeneric) {
    // Materialize the pre-migration generic queue through its actual owner.
    // The current page never translates this retained receipt into owned work.
    await page.evaluate(() => {
      const state = (
        window as unknown as { __mitzoStore: { getState(): { sendPendingSession(): boolean } } }
      ).__mitzoStore.getState();
      if (!state.sendPendingSession()) throw Error('Retained generic fixture could not be queued');
    });
  } else await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  if (retainedGeneric) {
    expect(sends[0].sessionId).toBeNull();
    expect(sends[0].accountId).toBe(binding.accountId);
    expect(sends[0].model).toBe(binding.model);
    expect(sends[0].sourceSnapshots).toEqual([
      expect.objectContaining({ kind: 'briefing', date: binding.date, revision: binding.revision }),
    ]);
  } else {
    const firstCommand = OrdinaryRuntimeFirstCommandSchema.parse(sends[0]);
    expect(firstCommand.runtime.account).toEqual(inventory!.accounts[0].account);
    expect(firstCommand.selection.model).toBe(binding.model);
    expect(firstCommand.payload.sourceSnapshots).toEqual([
      expect.objectContaining({ kind: 'briefing', date: binding.date, revision: binding.revision }),
    ]);
  }
  expect(registrations).toHaveLength(0);
  // HTTP delivery does not wait for the receiver's asynchronous socket startup.
  if (nativeMode && nativeMode !== 'sse')
    await expect.poll(() => sockets).toBeGreaterThanOrEqual(1);
  await page.reload();
  // Owned uncertain commands require an explicit retry of their frozen identity.
  if (!retainedGeneric) await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => sends.length).toBe(2);
  await expect(
    page.getByRole('button', { name: 'Send launch prompt', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
    'Keep my unsent follow-up',
  );
  releaseFirst?.();
  expect(sends[1]).toEqual(sends[0]);
  expect(turns.size).toBe(1);
  if (nativeMode && nativeMode !== 'sse') {
    await expect.poll(() => sockets).toBeGreaterThanOrEqual(2);
    expect(sockets).toBeGreaterThanOrEqual(2);
    expect(websocketSends).toHaveLength(0);
    expect(chatSseRequests).toBe(0);
  } else {
    expect(sockets).toBe(0);
    await expect.poll(() => chatSseRequests).toBeGreaterThanOrEqual(2);
  }
  // Stay in the same app process while the restored acknowledgement remains pending.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  // Today loads lazily; the old chat banner has a same-named, revision-pinned link.
  const todayBriefing = page.getByRole('link', { name: 'Read briefing', exact: true });
  await expect(todayBriefing).toHaveAttribute('href', `/briefings/${binding.date}`);
  await todayBriefing.click();
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
  await expect
    .poll(() =>
      page.evaluate((id) => localStorage.getItem(`mitzo-chat-draft:${id}`), launchDraftId),
    )
    .toBeNull();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('mitzo-chat-draft:'))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
        .some((draft) => draft.text === 'Keep my unsent follow-up' && !draft.settings.launch),
    ),
  ).toBe(true);
  await waitingPicker.getByRole('button', { name: 'Use selection', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  const retry = page.getByRole('button', { name: 'Retry saving briefing link', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveAttribute(
    'href',
    `/briefings/${binding.date}?revision=${binding.revision}`,
  );
  const workspace = page.getByRole('button', { name: /^Workspace controls,/ });
  async function openWorkspace() {
    await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
    await expect(workspace).toBeVisible();
    await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
    if ((await workspace.getAttribute('aria-expanded')) === 'false') await workspace.click();
    await expect(workspace).toHaveAttribute('aria-expanded', 'true');
    await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', binding.model);
  }

  await openWorkspace();
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', binding.model);
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-readonly', 'true');
  await expect(settingRow(page, 'Thinking level')).toHaveAttribute('data-readonly', 'true');
  await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
  expect(registrations).toEqual([binding]);
  if (retainedGeneric) {
    // Legacy consent remains with the retained generic session; owned Codex
    // never inherits that legacy control or permission authority.
    await openChatSetting(page, 'more');
    await expect(page.getByRole('button', { name: 'Web search permission: Denied' })).toBeVisible();
    await openWorkspace();
  }
  // Confirm authoritative visibility before reusing a locally retained assignment.
  hidden = hideAssigned;
  await page.goto('https://mitzo-ui.test/briefings/2026-10-10?ask=1');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use selection', exact: true })
    .click();
  if (hideAssigned) {
    await expect(page).toHaveURL(/\/chat\?draft=[^&]+$/);
    await reviewBriefingRuntime(page);
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
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-readonly', 'true');
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
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-readonly', 'true');
  expect(sends).toHaveLength(2);
  expect(turns.size).toBe(1);
  if (nativeMode && nativeMode !== 'sse') {
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

test('native-default SSE retains reviewed briefing delivery through cold reload without a duplicate turn', async ({
  page,
}) => {
  await exerciseBriefingReloadRecovery(page, false, 'sse');
});

for (const nativeMode of ['unready', 'lost-ack'] as const) {
  test(`explicit native WS override retains reviewed briefing delivery through cold reload with ${nativeMode} receipt`, async ({
    page,
  }) => {
    await exerciseBriefingReloadRecovery(page, false, nativeMode);
  });
}

test('reviewed launches let users dismiss Agent settings and reach Send at a short viewport', async ({
  page,
  isMobile,
}, testInfo) => {
  await enableBriefingRuntime(page);
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
  await reviewBriefingRuntime(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.font = 'georgia';
    document.documentElement.dataset.accent = 'teal';
  });
  await openAgentSettings(page);
  const settings = page.getByRole('button', { name: /^Workspace controls,/ });
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await expect(settingRow(page, 'Model')).toHaveAttribute('data-value', 'luna-fixture');
  await page.getByRole('button', { name: /^Workspace controls,/ }).click();
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  await expect(settings).toBeFocused();
  await expect(settingRow(page, 'Model')).toBeHidden();
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
  const inventory = await enableBriefingRuntime(page);
  await installBriefingSse(page);
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
    const assignedId =
      OrdinaryRuntimeFirstCommandSchema.parse(command).selection.model === changedBinding.model
        ? changedSessionId
        : sessionId;
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
            text: OrdinaryRuntimeFirstCommandSchema.parse(command).payload.text,
            sourceSnapshots:
              OrdinaryRuntimeFirstCommandSchema.parse(command).payload.sourceSnapshots,
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
    if (url.pathname === '/api/chat/local-codex/send' && route.request().method() === 'POST') {
      expect(route.request().headers()['x-connection-id']).toBeTruthy();
      const command = OrdinaryRuntimeFirstCommandSchema.parse(route.request().postDataJSON());
      return route.fulfill({
        status: 202,
        json: {
          ok: true,
          clientMsgId: command.clientMsgId,
          sessionId: accept(command),
          state: 'consumed',
          dispatched: true,
        },
      });
    }

    if (url.pathname === '/api/chat/switch') {
      const id = route.request().postDataJSON().sessionId;
      const command = accepted.get(id);
      if (command) {
        const request = OrdinaryRuntimeFirstCommandSchema.parse(command);
        await page.evaluate(
          ({ id, request }) => {
            const receiver = (
              window as unknown as {
                briefingFixtureSse: { onmessage: ((event: MessageEvent) => void) | null };
              }
            ).briefingFixtureSse;
            for (const message of [
              { type: 'session_state_changed', sessionId: id, state: 'running' },
              {
                type: 'user_message',
                sessionId: id,
                messageId: request.clientMsgId,
                text: request.payload.text,
                sourceSnapshots: request.payload.sourceSnapshots,
              },
              { type: 'session_state_changed', sessionId: id, state: 'idle' },
            ])
              receiver.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
          },
          { id, request },
        );
        completed = true;
      }
      return route.fulfill({ json: { ok: true } });
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
          runtimeBinding: {
            version: 2,
            account: inventory.accounts[0].account,
            harness: { implementation: 'codex' },
            execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
          },
          runtimeCommandScope: 'first-command-only',
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
  await reviewBriefingRuntime(page);
  await openAgentSettings(page);
  const profile = page.locator('select[aria-label="Agent"]');
  await expect(profile).toBeEnabled();
  await expect(profile).toHaveValue(
    JSON.stringify(['builtin', DEFAULT_MITZO_PROFILE_ID, DEFAULT_MITZO_PROFILE_REVISION]),
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry saving briefing link', exact: true });
  await expect(retry).toBeVisible();
  await expect.poll(() => completed).toBe(true);
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
    await openAgentSettings(page);
    const model = settingRow(page, 'Model');
    await expect(model).toHaveAttribute('data-value', binding.model);
    await expect(model).toHaveAttribute('data-readonly', 'true');
    await expect(settingRow(page, 'Thinking level')).toHaveAttribute('data-readonly', 'true');
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
  await openChatSetting(page, 'more');
  // Owned runtime permissions cannot inherit the legacy web-search control.
  // Its Denied state remains covered by both retained generic WS journeys.
  await expect(page.getByRole('button', { name: 'Web search permission: Denied' })).toHaveCount(0);
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
  await expect(page).toHaveURL(/\/chat\?draft=[^&]+$/);
  // Larger text must keep composer settings and launch actions reachable.
  if (isMobile)
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
  await page.screenshot({
    path: testInfo.outputPath('briefing-launch-access-large-text.png'),
    animations: 'disabled',
  });
  await reviewBriefingRuntime(page);
  await page.getByRole('button', { name: 'Send launch prompt', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${changedSessionId}$`));
  await expect.poll(() => posts.length).toBe(3);
  expect(posts).toEqual([binding, binding, changedBinding]);
  expect(turns).toHaveLength(2);
  expect(websocketSends).toHaveLength(0);
  expect(OrdinaryRuntimeFirstCommandSchema.parse(turns[1]).payload.sourceSnapshots).toEqual(
    OrdinaryRuntimeFirstCommandSchema.parse(turns[0]).payload.sourceSnapshots,
  );
  expect(OrdinaryRuntimeFirstCommandSchema.parse(turns[1]).selection.model).toBe(
    changedBinding.model,
  );
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
      await openAgentSettings(page);
      const model = settingRow(page, 'Model');
      await expect(model).toBeVisible();
      await expect(model).toHaveAttribute('data-readonly', 'true');
      await expect(model).toHaveAttribute('data-value', 'luna-fixture');
      await expect(page.locator('.chat-account-binding')).toHaveText('Work OpenAI');
      const thinking = settingRow(page, 'Thinking level');
      await expect(thinking).toHaveAttribute('data-readonly', 'true');
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
      await expect(workspace).toHaveAttribute('aria-expanded', 'false');
      await openAgentSettings(page);
      if (recovered === 'briefing') {
        await expect(page.getByText('Jeeves · 2026-10-10', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toBeVisible();
        await expect(model).toHaveAttribute('data-readonly', 'true');
        await expect(thinking).toHaveAttribute('data-readonly', 'true');
        await expect(
          page.getByRole('button', { name: 'Change account or model', exact: true }),
        ).toBeVisible();
      } else {
        await expect(model).not.toHaveAttribute('data-readonly', 'true');
        await expect(thinking).not.toHaveAttribute('data-readonly', 'true');
        await expect(page.getByRole('link', { name: 'Read briefing', exact: true })).toHaveCount(0);
      }
    }
  }
});

test('chat builder selection distinguishes built-in guidance from a saved profile with the same ID', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'mitzo-ui.test') return route.abort();
    if (url.pathname === '/api/agent-library')
      return route.fulfill({
        json: {
          drafts: [],
          versions: [
            {
              profileId: 'mitzo-profile-builder',
              revision: 2,
              contentHash: 'a'.repeat(64),
              definition: {
                name: 'My saved builder',
                descriptor: 'My own guidance',
                description: 'Saved profile',
                role: 'agent',
                instructions: 'Use my own instructions.',
                expectedOutput: 'A report',
                acceptanceCriteria: ['Cites evidence'],
                modelPolicyRole: 'agent',
              },
            },
          ],
        },
      });
    if (url.pathname === '/api/accounts')
      return route.fulfill({
        json: [
          {
            id: 'work-account',
            label: 'Work OpenAI',
            models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low'] }],
          },
        ],
      });
    return route.fallback();
  });
  await page.goto(
    'https://mitzo-ui.test/chat?agentProfile=mitzo-profile-builder&agentProfileKind=builtin&profileRevision=1&prompt=Help+me+create+an+agent.',
  );
  await expect(page).toHaveURL(/agentProfileKind=builtin/);
  await expect(page.getByRole('textbox', { name: 'Message Mitzo', exact: true })).toHaveValue(
    'Help me create an agent.',
  );
  await openAgentSettings(page);
  await openChatSetting(page, 'agent');
  const picker = page.locator('select[aria-label="Agent"]');
  await expect(picker).toHaveValue(JSON.stringify(['builtin', 'mitzo-profile-builder', 1]));
  await expect(picker.getByRole('option', { name: /My saved builder/ })).toHaveCount(1);
  await picker.selectOption(JSON.stringify(['saved', 'mitzo-profile-builder', 2]));
  await expect(page).toHaveURL(/profileRevision=2/);
  expect(new URL(page.url()).searchParams.has('agentProfileKind')).toBe(false);
  await expect(picker).toHaveValue(JSON.stringify(['saved', 'mitzo-profile-builder', 2]));
  await openChatSetting(page, 'agent');
  await picker.selectOption('');
  expect(new URL(page.url()).searchParams.has('agentProfile')).toBe(false);
});

test('profile draft cards appear in conversation and save without opening Workspace', async ({
  page,
  isMobile,
}, testInfo) => {
  let state: 'empty' | 'error' | 'populated' = 'populated';
  let writes = 0;
  const proposal = {
    proposalId: 'offline-draft',
    suggestedProfileId: null,
    state: 'pending',
    definition: {
      name: 'Reusable reviewer for planning decisions and their supporting evidence',
      descriptor: 'The challenger',
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
    if (
      url.pathname === '/api/symposium/profile-proposals/offline-draft/save' &&
      route.request().method() === 'POST'
    ) {
      writes++;
      expect(route.request().postDataJSON().profileId).toMatch(/^[0-9a-f-]{36}$/);
      state = 'empty';
      return route.fulfill({ json: { profileId: 'saved-reviewer', revision: 1 } });
    }
    if (route.request().method() !== 'GET')
      return route.fulfill({ status: 405, json: { error: 'Offline fixture forbids writes' } });
    if (url.pathname === '/api/sessions/ui-drafts/messages') return route.fulfill({ json: [] });
    if (url.pathname === '/api/sessions/ui-drafts/meta')
      return route.fulfill({ json: { sessionType: 'chat' } });
    if (url.pathname === '/api/sessions/ui-drafts/symposium/status')
      return route.fulfill({ json: { sessionId: 'ui-drafts', config: null, seats: [] } });
    if (url.pathname === '/api/symposium/profiles') return route.fulfill({ json: [] });
    if (url.pathname === '/api/symposium/profile-proposals')
      return state === 'error'
        ? route.fulfill({ status: 503, json: { error: 'Draft service unavailable' } })
        : route.fulfill({ json: state === 'populated' ? [proposal] : [] });
    return route.fallback();
  });
  for (const width of isMobile ? [320, 390] : [1280])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 900 });
      state = 'populated';
      await page.goto('https://mitzo-ui.test/chat/ui-drafts');
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.accent = 'teal';
        document.documentElement.dataset.font = 'georgia';
      }, theme);
      const panel = page.getByRole('complementary', { name: 'Reusable profile drafts' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
        proposal.definition.name,
      );
      await expect(panel.getByRole('textbox', { name: 'Profile ID', exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Reusable profile drafts', exact: true }),
      ).toBeHidden();
      await expect(
        panel.getByRole('textbox', { name: 'Model policy role', exact: true }),
      ).toBeHidden();
      await panel.getByRole('textbox', { name: 'Name', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`draft-profile-${width}-${theme}.png`) });
      const save = panel.getByRole('button', { name: 'Save reusable profile' });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeEnabled();
      expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await save.focus();
      await expect(save).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`draft-ready-${width}-${theme}.png`) });
      const before = writes;
      await page.keyboard.press('Enter');
      await expect(panel.getByRole('status')).toContainText('Saved Reusable reviewer');
      await expect(panel.getByRole('link', { name: 'Open Agent Library' })).toBeVisible();
      expect(writes).toBe(before + 1);
      await page.screenshot({ path: testInfo.outputPath(`draft-saved-${width}-${theme}.png`) });
      for (const next of ['empty', 'error'] as const) {
        state = next;
        await page.goto('https://mitzo-ui.test/chat/ui-drafts');
        await page.getByRole('button', { name: /^Workspace controls/ }).click();
        await expect(page.locator('.workspace-controls > .motion-disclosure')).not.toHaveAttribute(
          'data-motion-active',
          'true',
        );
        await openChatSetting(page, 'more');
        await page.getByRole('button', { name: 'Reusable profile drafts', exact: true }).click();
        if (next === 'empty')
          await expect(panel.getByText('No profile drafts in this chat yet.')).toBeVisible();
        else await expect(panel.getByRole('alert')).toHaveText('Draft service unavailable');
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
    let showReply = true;
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
            blockId: 'delegation',
            blockType: 'tool_use',
            content: '',
            toolName: 'Agent',
            toolInput: 'Check delegated records',
            toolResult: 'Delegate finished',
            subagent: {
              messageId: 'delegate',
              summary: 'Delegate checked the records',
              blocks: [
                {
                  blockId: 'delegate-thought',
                  blockType: 'thinking',
                  content: 'Checking delegated evidence.',
                },
                {
                  blockId: 'delegate-tool',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'Read',
                  toolInput: 'delegated-records.md',
                  toolResult: 'Delegated evidence retrieved',
                },
              ],
            },
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
      if (path === `/api/sessions/${sessionId}/messages`)
        return route.fulfill({ json: showReply ? messages : messages.slice(0, -1) });
      if (path === `/api/sessions/${sessionId}/meta`)
        return route.fulfill({ json: { sessionType: 'chat' } });
      if (path === `/api/sessions/${sessionId}/symposium/status`)
        return route.fulfill({ json: { sessionId, config: null, seats: [] } });
      return route.fallback();
    });
    await page.goto(`/chat/${sessionId}`);
    await expect(page.getByRole('region', { name: 'Outputs', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Keep as output', exact: true })).toHaveCount(0);
    const toggle = page.getByRole('button', { name: /^(?:Activity|Agents? at work):/ });
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('Read');
    await expect(toggle).toContainText('1 failed');
    await expect(toggle).toContainText('1 delegated');
    await expect(page.getByText('I will check the records.', { exact: true })).toBeVisible();
    await expect(page.getByText('Here are the results.', { exact: true })).toBeVisible();
    const alignment = await page.locator('.msg-bubble-group--user').evaluate((user) => {
      const chat = user.closest('.chat-messages')!;
      // Flex aligns to the scroll container's content box, excluding its
      // border and the visible WebKit scrollbar rather than the outer rectangle.
      const contentRight =
        chat.getBoundingClientRect().left +
        chat.clientLeft +
        chat.clientWidth -
        parseFloat(getComputedStyle(chat).paddingRight);
      return Math.abs(user.getBoundingClientRect().right - contentRight);
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
    await expect(page.getByRole('button', { name: /^Thought/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.getByRole('button', { name: /^Thought/ }).click();
    await expect(
      page.getByText('Checking the latest records and their status.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^Agent Delegate checked the records/ }).click();
    await expect(page.getByText('Checking delegated evidence.', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: /^Agent Delegate checked the records/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`activity-delegated-${appearance.theme}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: /^Read \/workspace/ }).click();
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
    showReply = false;
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: /^Read/ })).toBeVisible();
    await page.getByRole('button', { name: /^Thought/ }).click();
    await expect(
      page.getByText('Checking the latest records and their status.', { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`activity-working-${appearance.theme}.png`),
      animations: 'disabled',
    });
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`chat activity live replies and device handoffs preserve grouping and keyboard focus with ${reducedMotion} motion`, async ({
    page,
  }, testInfo) => {
    const sessionId = 'offline-activity-focus';
    const live: { send?: (message: Record<string, unknown>) => void } = {};
    await page.emulateMedia({ reducedMotion });
    await page.routeWebSocket('**/*', (socket) => {
      live.send = (message) => socket.send(JSON.stringify({ ...message, sessionId }));
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'hello')
          socket.send(
            JSON.stringify({
              type: 'welcome',
              protocolVersion: 2,
              connectionId: 'offline-activity-focus',
            }),
          );
      });
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/sessions/${sessionId}/messages`)
        return route.fulfill({
          json: [
            {
              messageId: 'thought',
              role: 'assistant',
              blocks: [{ blockId: 'thought', blockType: 'thinking', content: 'Checking records' }],
            },
            {
              messageId: 'empty',
              role: 'assistant',
              blocks: [{ blockId: 'empty', blockType: 'text', content: ' \n\t ' }],
            },
            {
              messageId: 'read',
              role: 'assistant',
              blocks: [
                {
                  blockId: 'read',
                  blockType: 'tool_use',
                  content: '',
                  toolName: 'Read',
                  toolInput: '/workspace/report.md',
                  toolResult: 'Report contents',
                },
              ],
            },
          ],
        });
      if (path === `/api/sessions/${sessionId}/meta`)
        return route.fulfill({ json: { sessionType: 'chat' } });
      if (path === `/api/sessions/${sessionId}/symposium/status`)
        return route.fulfill({ json: { sessionId, config: null, seats: [] } });
      return route.fallback();
    });
    await page.goto(`/chat/${sessionId}`);
    const toggle = page.getByRole('button', { name: /^(?:Activity|Agents? at work):/ }).first();
    await expect(page.getByRole('button', { name: /^(?:Activity|Agents? at work):/ })).toHaveCount(
      1,
    );
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const read = page.getByRole('button', { name: /^Read/ });
    await read.focus();
    await expect(read).toBeFocused();
    await expect.poll(() => Boolean(live.send)).toBe(true);
    live.send!({ type: 'message_start', messageId: 'reply' });
    live.send!({ type: 'block_start', messageId: 'reply', blockId: 'answer', blockType: 'text' });
    live.send!({ type: 'session_state_changed', state: 'running' });
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
    live.send!({ type: 'session_takeover' });
    await expect(
      page.getByText('Session resumed on another device.', { exact: false }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(read).toBeFocused();
    live.send!({
      type: 'block_delta',
      messageId: 'reply',
      blockId: 'answer',
      blockType: 'text',
      delta: 'Here is the answer.',
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.locator('.agent-activity-details')).toBeHidden();
    await expect(page.getByText('Here is the answer.', { exact: true })).toBeVisible();
    live.send!({ type: 'message_start', messageId: 'next-working' });
    live.send!({
      type: 'block_start',
      messageId: 'next-working',
      blockId: 'next-thought',
      blockType: 'thinking',
    });
    live.send!({
      type: 'block_delta',
      messageId: 'next-working',
      blockId: 'next-thought',
      blockType: 'thinking',
      delta: 'Checking the next records',
    });
    const next = page.getByRole('button', { name: /^(?:Activity|Agents? at work):/ }).last();
    await expect(page.getByRole('button', { name: /^(?:Activity|Agents? at work):/ })).toHaveCount(
      2,
    );
    await expect(next).toHaveAttribute('aria-expanded', 'true');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    await composer.focus();
    live.send!({ type: 'message_start', messageId: 'next-reply' });
    live.send!({
      type: 'block_start',
      messageId: 'next-reply',
      blockId: 'next-answer',
      blockType: 'text',
    });
    live.send!({
      type: 'block_delta',
      messageId: 'next-reply',
      blockId: 'next-answer',
      blockType: 'text',
      delta: 'Here is the next answer.',
    });
    await expect(next).toHaveAttribute('aria-expanded', 'false');
    await expect(composer).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`activity-focus-${reducedMotion}.png`),
      animations: 'disabled',
    });
  });
}
test('sandbox boot context is not presented as a fallback in Outputs / Sources', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  let sendBoot: (() => void) | undefined;
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage((raw) => {
      if (JSON.parse(String(raw)).type !== 'hello') return;
      socket.send(
        JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'context-fixture' }),
      );
      sendBoot = () =>
        socket.send(
          JSON.stringify({
            type: 'boot_context',
            source: 'sandbox',
            scope: 'sandbox',
            sourceCount: 7,
            tokenCount: 11995,
            tokenBudget: 12000,
            sources: [{ path: 'AGENTS.md', kind: 'reference' }],
            included: [],
            trimmed: [],
            fullMarkdown: '# Published workspace guidance\nUse the accepted management context.',
          }),
        );
    });
  });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
  await expect.poll(() => !!sendBoot).toBe(true);
  sendBoot!();
  await page.getByRole('tab', { name: 'Context', exact: true }).click();
  const header = page.getByRole('button', { name: /7 sources/ });
  await expect(header).toBeVisible();
  await header.click();
  await expect(page.getByText('Boot Context (Sandbox)', { exact: true })).toBeVisible();
  await expect(page.getByText('Boot Context (Fallback)', { exact: true })).toHaveCount(0);
  await expect(page.locator('.session-banner-dot--ok')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sandbox-context-dark.png') });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.dataset.accent = 'teal';
    document.documentElement.dataset.font = 'georgia';
  });
  await header.focus();
  await expect(header).toBeFocused();
  await header.press('Enter');
  await expect(page.getByText('Boot Context (Sandbox)', { exact: true })).toHaveCount(0);
  await header.press('Enter');
  await expect(page.getByText('Boot Context (Sandbox)', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sandbox-context-light.png') });
});

test('rejected ordinary Stop preserves the live reply and queued image until server idle', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const sessionId = 'owned-contributor-child';
  const sent: Record<string, unknown>[] = [];
  let confirmIdle!: () => void;
  await page.routeWebSocket('**/*', (socket) => {
    const emit = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
    confirmIdle = () => emit({ type: 'session_state_changed', sessionId, state: 'idle' });
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        emit({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-child' });
      if (message.type === 'send') {
        sent.push(message);
        emit({
          type: 'user_message',
          sessionId,
          messageId: message.clientMsgId,
          text: message.prompt,
        });
      }
      if (message.type === 'switch_session') {
        emit({ type: 'session_switched', sessionId, mode: 'agent' });
        emit({ type: 'session_state_changed', sessionId, state: 'running' });
        emit({ type: 'message_start', sessionId, messageId: 'active-reply' });
        emit({
          type: 'block_start',
          sessionId,
          messageId: 'active-reply',
          blockId: 'reply-text',
          blockType: 'text',
        });
        emit({
          type: 'block_delta',
          sessionId,
          messageId: 'active-reply',
          blockId: 'reply-text',
          blockType: 'text',
          delta: 'An active child reply',
        });
      }
      if (message.type === 'stop') {
        emit({
          type: 'session_control_rejected',
          sessionId,
          control: 'stop',
          error: 'Use contributor controls to stop this conversation.',
        });
        emit({
          type: 'block_delta',
          sessionId,
          messageId: 'active-reply',
          blockId: 'reply-text',
          blockType: 'text',
          delta: ' continues after rejection.',
        });
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: [] });
    if (path === `/api/sessions/${sessionId}/meta`)
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
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        },
      });
    if (path === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  await page.goto(`/chat/${sessionId}`);
  const stop = page.getByRole('button', { name: 'Stop generation', exact: true });
  await expect(stop).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await draft.fill('Queued child follow-up');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'queued.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.getByAltText('Attachment 1')).toBeVisible();
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await draft.fill('Next untouched draft');
  await stop.click();
  await expect(
    page.getByText('Use contributor controls to stop this conversation.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('An active child reply continues after rejection.', { exact: true }),
  ).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(draft).toHaveValue('Next untouched draft');
  await expect(page.locator('.chat-input-queued')).toContainText('Queued child follow-up');
  expect(sent).toHaveLength(0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.dataset.accent = 'teal';
      document.documentElement.dataset.font = 'georgia';
    }, theme);
    await expect(stop).toBeInViewport();
    await expect(draft).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`rejected-stop-${theme}.png`),
      animations: 'disabled',
    });
  }
  confirmIdle();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({
    sessionId,
    prompt: 'Queued child follow-up',
    images: [expect.objectContaining({ mediaType: 'image/png' })],
  });
  await expect(draft).toHaveValue('Next untouched draft');
  await expect(page.locator('.chat-input-queued')).toHaveCount(0);
});

test('rejected running Enter recovers exact input without overwriting newer draft or automatically replaying', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const sessionId = 'owned-interrupt-child';
  const sent: Record<string, unknown>[] = [];
  let emit!: (message: Record<string, unknown>) => void;
  await page.routeWebSocket('**/*', (socket) => {
    emit = (message) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        emit({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-interrupt' });
      if (message.type === 'send' || message.type === 'interrupt') sent.push(message);
      if (message.type === 'send')
        emit({
          type: 'user_message',
          sessionId,
          messageId: message.clientMsgId,
          text: message.prompt,
        });
      if (message.type === 'switch_session') {
        emit({ type: 'session_switched', sessionId, mode: 'agent' });
        emit({ type: 'session_state_changed', sessionId, state: 'running' });
        emit({ type: 'message_start', sessionId, messageId: 'live-reply' });
        emit({
          type: 'block_start',
          sessionId,
          messageId: 'live-reply',
          blockId: 'reply',
          blockType: 'text',
        });
        emit({
          type: 'block_delta',
          sessionId,
          messageId: 'live-reply',
          blockId: 'reply',
          blockType: 'text',
          delta: 'An active child reply',
        });
      }
    });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: [] });
    if (path === `/api/sessions/${sessionId}/meta`)
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
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        },
      });
    if (path === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  await page.goto(`/chat/${sessionId}`);
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await input.fill('Independent queued input');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await input.fill('Exact refused interrupt');
  await page.locator('input[type=file]').setInputFiles({
    name: 'interrupt.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.locator('.chat-input').getByAltText('Attachment 1')).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => sent.filter((message) => message.type === 'interrupt').length).toBe(1);
  const command = sent.find((message) => message.type === 'interrupt')!;
  expect(command).toMatchObject({
    prompt: 'Exact refused interrupt',
    images: [expect.objectContaining({ mediaType: 'image/png' })],
  });
  await expect(input).toHaveValue('Exact refused interrupt');
  await expect(page.locator('.chat-input').getByAltText('Attachment 1')).toBeVisible();
  await input.fill('Newer untouched draft');
  await page.getByRole('button', { name: 'Remove attachment 1' }).click();
  emit({
    type: 'session_control_rejected',
    sessionId,
    control: 'interrupt',
    clientMsgId: command.clientMsgId,
    error: 'Use contributor controls for this input.',
  });
  emit({
    type: 'block_delta',
    sessionId,
    messageId: 'live-reply',
    blockId: 'reply',
    blockType: 'text',
    delta: ' continues after interrupt refusal.',
  });
  await expect(
    page.getByText('An active child reply continues after interrupt refusal.', { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('Newer untouched draft');
  await expect(page.locator('.chat-input-queued')).toHaveCount(2);
  await expect(page.locator('.chat-input-queued').nth(1)).toContainText('Exact refused interrupt');
  await expect(
    page.getByText('Use contributor controls for this input.', { exact: false }),
  ).toBeVisible();
  emit({ type: 'session_state_changed', sessionId, state: 'idle' });
  await expect.poll(() => sent.filter((message) => message.type === 'send').length).toBe(1);
  expect(sent.filter((message) => message.type === 'send')[0].prompt).toBe(
    'Independent queued input',
  );
  emit({ type: 'session_state_changed', sessionId, state: 'running' });
  await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toBeVisible();
  emit({ type: 'session_state_changed', sessionId, state: 'idle' });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  expect(sent.filter((message) => message.type === 'send')).toHaveLength(1);
  await expect(input).toHaveValue('Newer untouched draft');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(input).toHaveValue('Exact refused interrupt');
  await expect(page.locator('.chat-input').getByAltText('Attachment 1')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = 'teal';
      document.documentElement.dataset.font = 'georgia';
    }, theme);
    await page.screenshot({
      path: testInfo.outputPath(`recovered-interrupt-${theme}.png`),
      animations: 'disabled',
    });
  }
  expect(sent).toHaveLength(2);
});

test('rejected idle ordinary Send keeps attachments and an explicit retry without replacing newer input', async ({
  page,
  isMobile,
}, testInfo) => {
  await page.setViewportSize({ width: isMobile ? 320 : 1280, height: 900 });
  const sessionId = 'idle-owned-child';
  const sent: Record<string, unknown>[] = [];
  let emit!: (message: Record<string, unknown>) => void;
  await page.routeWebSocket('**/*', (socket) => {
    emit = (message) => socket.send(JSON.stringify(message));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello')
        emit({ type: 'welcome', protocolVersion: 2, connectionId: 'offline-idle-child' });
      if (message.type === 'switch_session') {
        emit({ type: 'session_switched', sessionId, mode: 'agent' });
        emit({ type: 'session_state_changed', sessionId, state: 'idle' });
      }
      if (message.type === 'send') sent.push(message);
    });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/sessions/${sessionId}/messages`) return route.fulfill({ json: [] });
    if (path === `/api/sessions/${sessionId}/meta`)
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
            models: [{ id: 'luna-fixture', label: 'Luna fixture' }],
          },
        },
      });
    if (path === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    return route.fallback();
  });
  await page.goto(`/chat/${sessionId}`);
  const draft = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  await draft.fill('Exact refused ordinary input');
  await page.locator('input[type=file]').setInputFiles({
    name: 'owned.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await expect(page.getByAltText('Attachment 1')).toBeVisible();
  await draft.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  await expect(draft).toHaveValue('');
  await expect(page.getByText('Exact refused ordinary input', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mitzo-draft-idle-owned-child')))
    .toBe('Exact refused ordinary input');
  await draft.fill('Newer untouched ordinary draft');
  emit({
    type: 'session_control_rejected',
    sessionId,
    clientMsgId: sent[0].clientMsgId,
    control: 'send',
    code: 'contributor_owned',
    error: 'Use contributor controls to send to this conversation.',
  });
  await expect(draft).toHaveValue('Newer untouched ordinary draft');
  await expect(page.locator('.chat-input-queued')).toContainText('Exact refused ordinary input');
  expect(
    await page.evaluate(() => localStorage.getItem('mitzo-queue-idle-owned-child')),
  ).not.toContain('data:image');
  const retry = page.getByRole('button', { name: 'Send Now', exact: true });
  await expect(retry).toBeVisible();
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = 'teal';
      document.documentElement.dataset.font = 'georgia';
    }, theme);
    await expect(draft).toBeInViewport();
    await expect(retry).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(`ordinary-send-recovery-${theme}.png`),
      animations: 'disabled',
    });
  }
  await retry.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({
    sessionId,
    prompt: 'Exact refused ordinary input',
    images: [expect.objectContaining({ mediaType: 'image/png' })],
  });
  expect(sent[1].clientMsgId).not.toBe(sent[0].clientMsgId);
  emit({ type: 'user_message', sessionId, messageId: sent[1].clientMsgId, text: sent[1].prompt });
  await expect(page.locator('.chat-input-queued')).toHaveCount(0);
  await expect(draft).toHaveValue('Newer untouched ordinary draft');
});

test('ordinary collaboration opens selected work explicitly and preserves the quiet conversation', async ({
  page,
  isMobile,
}, testInfo) => {
  const sessionId = 'ordinary-collaboration';
  const outputId = '00000000-0000-4000-8000-000000000099';
  const source = {
    sessionId,
    messageId: 'draft',
    blockId: 'text',
    messageEndSeq: 7,
    sha256: 'a'.repeat(64),
  };
  const output = {
    outputId,
    sessionId,
    title: 'Selected decision draft',
    revision: 1,
    kind: 'inline_draft',
    durability: 'reference_registered',
    label: 'In conversation',
    sourceAvailability: 'available',
    source,
    provenance: null,
    createdAt: 1,
  };
  const workReads: string[] = [];
  const forbidden: string[] = [];
  const additions: Record<string, unknown>[] = [];
  const contributors: Record<string, unknown>[] = [];
  const catalogScopes: string[] = [];
  let releaseAddition!: () => void;
  const additionReady = new Promise<void>((resolve) => {
    releaseAddition = resolve;
  });
  let failReads = false;
  let empty = false;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (
      path.startsWith('/api/symposium/personal/') ||
      (route.request().method() !== 'GET' && path.includes('/symposium/'))
    ) {
      forbidden.push(path);
      return route.fulfill({
        status: 409,
        json: { error: 'Dedicated setup is unavailable in this fixture' },
      });
    }
    if (path === '/api/accounts') catalogScopes.push(url.searchParams.get('scope') ?? 'chat');
    if (path === `/api/sessions/${sessionId}/meta`)
      return route.fulfill({ json: { sessionType: 'chat' } });
    if (path === `/api/sessions/${sessionId}/messages`)
      return route.fulfill({
        json: [
          {
            messageId: 'draft',
            role: 'assistant',
            blocks: [{ blockId: 'text', blockType: 'text', content: 'Selected exact draft' }],
          },
        ],
      });
    if (path === `/api/sessions/${sessionId}/symposium/status`)
      return route.fulfill({ json: { sessionId, config: null, seats: [] } });
    if (path === `/api/sessions/${sessionId}/outputs`) {
      workReads.push(path);
      return failReads
        ? route.fulfill({ status: 503, json: { error: 'Work is temporarily unavailable' } })
        : route.fulfill({ json: { outputs: empty ? [] : [output], candidates: [] } });
    }
    if (path === `/api/sessions/${sessionId}/outputs/${outputId}`)
      return route.fulfill({
        json: { output, content: 'Selected exact draft', contextPackageDigest: 'b'.repeat(64) },
      });
    if (path === `/api/sessions/${sessionId}/contributors` && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      additions.push(input);
      await additionReady;
      const contributor = {
        id: 'ordinary-independent',
        label: input.label,
        accountLabel: 'Work OpenAI',
        model: input.model,
        sessionId: null,
        outputId,
        outputRevision: 1,
        status: 'idle',
        messages: [],
      };
      contributors.push(contributor);
      return route.fulfill({ json: { contributor } });
    }
    if (path === `/api/sessions/${sessionId}/contributors`)
      return route.fulfill({
        json: {
          contributors,
          eligibility: {
            available: true,
            accountIds: ['work-account'],
            reason: 'Uses the existing ordinary account.',
          },
        },
      });
    return route.fallback();
  });
  await page.goto(`/chat/${sessionId}`);
  await page.getByRole('button', { name: /Workspace controls/ }).click();
  await openChatSetting(page, 'more');
  const action = page.getByRole('button', { name: 'Symposium collaboration', exact: true });
  const originalOverflow = await page.evaluate(() => document.body.style.overflow);
  await expect(action).toBeVisible();
  await expect(page.getByRole('region', { name: 'Outputs', exact: true })).toHaveCount(0);
  expect(workReads).toHaveLength(0);
  await action.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Collaborate on selected work' });
  await expect(
    dialog.getByRole('heading', { name: 'Selected decision draft', exact: true }),
  ).toBeVisible();
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.accent = theme === 'dark' ? 'mint' : 'teal';
      document.documentElement.dataset.font = theme === 'dark' ? 'system' : 'georgia';
    }, theme);
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await dialog.screenshot({
      path: testInfo.outputPath(
        `ordinary-collaboration-${theme}-${isMobile ? 'mobile' : 'desktop'}.png`,
      ),
      animations: 'disabled',
    });
  }
  await dialog.getByRole('button', { name: 'Add contributor', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add contributor', exact: true });
  await expect(add).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add contributor', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Add contributor', exact: true }).click();
  await expect(
    add.getByText('Start an independent conversation using one of your existing accounts.'),
  ).toBeVisible();
  await expect(add.getByText('Use a writing profile here.', { exact: false })).toBeVisible();
  await expect(add.getByLabel('Account', { exact: true })).toBeVisible();
  const widths = await add.getByLabel('Account', { exact: true }).evaluate((element) => ({
    control: element.getBoundingClientRect().width,
    field: element.closest('label')!.getBoundingClientRect().width,
  }));
  expect(widths.control).toBeGreaterThanOrEqual(widths.field - 1);
  await add.getByLabel('Contributor name').fill('Independent writer');
  await add.getByRole('button', { name: /^Use Work OpenAI/ }).click();
  await add.getByLabel('Session mode').selectOption('agent');
  await add.getByRole('button', { name: 'Add to this output', exact: true }).click();
  await expect.poll(() => additions.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(add).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(
    add.getByRole('button', { name: 'Adding contributor…', exact: true }),
  ).toBeDisabled();
  releaseAddition();
  await expect(add).toHaveCount(0);
  await expect(dialog.getByText('Independent writer', { exact: true })).toBeVisible();
  expect(additions).toEqual([
    expect.objectContaining({
      accountId: 'work-account',
      model: 'luna-fixture',
      mode: 'agent',
      outputId,
      outputRevision: 1,
      contextPackageDigest: 'b'.repeat(64),
      label: 'Independent writer',
    }),
  ]);
  expect(catalogScopes).toContain('chat');
  expect(forbidden).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const workspace = page.getByRole('button', { name: /^Workspace controls/ });
  await expect(action).toBeFocused();
  await expect(workspace).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Outputs', exact: true })).toHaveCount(0);
  failReads = true;
  await workspace.click();
  await action.focus();
  await action.click();
  await expect(dialog.getByRole('alert')).toContainText('Work is temporarily unavailable');
  failReads = false;
  empty = true;
  await dialog.getByRole('button', { name: 'Retry outputs' }).click();
  await expect(dialog.getByText('No finalized drafts yet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  empty = false;
  await workspace.click();
  await action.click();
  await dialog.getByRole('button', { name: 'Add contributor', exact: true }).click();
  await expect(add).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState({}, '', '/chats');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe(originalOverflow);
});
