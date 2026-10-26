import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';
import { settingsHome, openChatSetting } from '../../../support/chat-settings';

const profiles = {
  'mobile-dark': { width: 320, theme: 'dark', motion: 'reduce', touch: true },
  'mobile-light': { width: 320, theme: 'light', motion: 'no-preference', touch: true },
  'desktop-dark': { width: 1280, theme: 'dark', motion: 'no-preference', touch: false },
  'desktop-light': { width: 1280, theme: 'light', motion: 'reduce', touch: false },
} as const;
const selected = process.env.S9_UX_SCENARIO as keyof typeof profiles;
if (!Object.hasOwn(profiles, selected)) throw Error('Select an explicit S9_UX_SCENARIO');
const profile = profiles[selected];

it(`Actual App UX observation ${selected}: chooser, compact chat, settings, tree, resources and real refusal`, async () => {
  const h = await createJoinedOrdinaryApplication({
    viewport: { width: profile.width, height: 900 },
    colorScheme: profile.theme,
    reducedMotion: profile.motion,
    isMobile: profile.touch,
    hasTouch: profile.touch,
  });
  const { canonical, f, api, ordinary, page, front, chat, nativeSessions } = h;
  await page.addInitScript(
    ({ theme }) => {
      localStorage.setItem('mitzo-theme', theme);
      localStorage.setItem('mitzo-accent', theme === 'dark' ? 'mint' : 'teal');
      localStorage.setItem('mitzo-font', theme === 'dark' ? 'system' : 'georgia');
    },
    { theme: profile.theme },
  );
  canonical.db
    .prepare(
      `INSERT INTO items
    (id,summary,profile,first_seen,last_seen,created_at,updated_at)
    VALUES('ux-program','Recording programme','manual',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  canonical.db.prepare('UPDATE items SET parent_id=? WHERE id=?').run('ux-program', 'studio');
  for (const [itemId, kind] of [
    ['ux-program', 'coordinator'],
    ['studio', 'outcome'],
  ] as const)
    await api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
  chat.eventStore.upsertSession({
    ...canonical.events.getSession('planning')!,
    accountBinding: f.binding,
  });
  const sequence = chat.eventStore.append('planning', 'user_message', {
    messageId: 'ux-origin',
    text: 'Retain the original room measurements and acoustic plan.',
  });
  const material = {
    artifactId: canonical.material.id,
    revision: canonical.material.revision,
    sha256: canonical.material.sha256,
  };
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'planning',
    mode: 'selected' as const,
    boundary: { sequence, messageId: 'ux-origin' },
    messageIds: ['ux-origin'],
    artifacts: [material],
    purpose: 'Original room research',
    joiningBrief: '',
  };
  const preview = await api.previewSource({ itemId: 'studio', selection });
  await api.adoptSource({
    itemId: 'studio',
    selection,
    requestId: randomUUID(),
    expectedRevision: preview.packet.workRevision,
    previewSha256: preview.sha256,
  });
  const sources = (await api.read('studio')).sources;
  const createChat = async (assigned: boolean, title: string) => {
    const prepared = await ordinary.prepare({
      version: 1,
      model: f.binding.model,
      runOn: 'local',
      runtime: {
        account: f.first.request.runtime.account,
        harness: 'codex',
        targetId: f.first.request.runtime.targetId,
      },
    });
    const reviewed = await api.reviewRoleContext({
      itemId: 'studio',
      role: 'lead',
      sourceSnapshotIds: sources.map((s) => s.snapshotId),
      artifactRefs: [material],
    });
    const receipt = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: reviewed.presentationRef,
      input: {
        version: 2,
        itemId: 'studio',
        requestId: randomUUID(),
        role: 'lead',
        expectedRevision: reviewed.selection.brief.revision,
        expectedAssignmentRevision: assigned ? 0 : null,
        contextSelection: reviewed.selection,
        settings: {
          version: 2,
          binding: prepared.runtimeBinding,
          selection: f.first.request.selection,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
      },
    });
    const id = assigned
      ? receipt.work.assignments[0].conversation.conversationId
      : receipt.work.links.find(
          (l) =>
            l.role === 'lead' &&
            l.conversation.conversationId !==
              receipt.work.assignments[0].conversation.conversationId,
        )!.conversation.conversationId;
    // Synthetic saved title in the real event/catalog owner, not a fulfilled API.
    chat.eventStore.upsertSession({ ...chat.eventStore.getSession(id)!, summary: title });
    return id;
  };
  const lead = await createChat(true, 'Studio planning lead');
  const additional = await createChat(false, 'Additional acoustic discussion');
  const baselineSessions = chat.eventStore.listSessions().length;
  const captures: string[] = [];
  const geometry: Array<{ stage: string; width: number; viewport: number }> = [];
  let touchActivations = 0;
  const activate = async (target: import('@playwright/test').Locator) => {
    if (profile.touch) {
      await target.tap();
      touchActivations++;
    } else await target.click();
  };
  const motionObservations: unknown[] = [];
  const settleMotion = async () => {
    const observed = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const animations = document.getAnimations();
      const observations = animations.map((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const end = animation.effect?.getComputedTiming().endTime;
        const rendered = !!target && target.getClientRects().length > 0 && target.checkVisibility();
        return {
          name: animation instanceof CSSAnimation ? animation.animationName : 'web-animation',
          target: target?.tagName,
          rendered,
          enclosingDetailsOpen: target?.closest('details')?.open,
          playState: animation.playState,
          pending: animation.pending,
          end: typeof end === 'number' && Number.isFinite(end) ? end : 'non-finite',
          waited:
            typeof end === 'number' &&
            Number.isFinite(end) &&
            rendered &&
            (animation.playState === 'running' || animation.pending),
        };
      });
      // Closed native details may retain an unfinished CSS animation for hidden
      // content. It is not painting; do not wait indefinitely for its timeline.
      // Visible motion still finishes naturally, without disabling or advancing it.
      await Promise.all(
        animations
          .filter((_, index) => observations[index].waited)
          .map((animation) => animation.finished.catch(() => {})),
      );
      return observations;
    });
    motionObservations.push(observed);
  };
  const capture = async (stage: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, stage + '-animation-probe.json'),
        JSON.stringify(
          await page.evaluate(() =>
            document.getAnimations().map((animation) => {
              const target = (animation.effect as KeyframeEffect | null)?.target;
              return {
                name: animation instanceof CSSAnimation ? animation.animationName : 'web-animation',
                target: target?.tagName,
                rects: target?.getClientRects().length,
                visible: target?.checkVisibility(),
                enclosingDetailsOpen: target?.closest('details')?.open,
                playState: animation.playState,
                currentTime: animation.currentTime,
                endTime: animation.effect?.getComputedTiming().endTime,
              };
            }),
          ),
          null,
          2,
        ),
      );
    await settleMotion();
    geometry.push(
      await page.evaluate(
        (stage) => ({ stage, width: document.documentElement.scrollWidth, viewport: innerWidth }),
        stage,
      ),
    );
    if (process.env.S9_JOINED_SCREENSHOT_DIR) {
      const filename = stage + '.png';
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, filename),
        fullPage: true,
      });
      captures.push(filename);
    }
  };
  // Delay transport only; the original authenticated work route still executes.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gatedReads = 0;
  const delay = async (route: import('@playwright/test').Route) => {
    gatedReads++;
    await gate;
    await route.continue();
  };
  await page.route('**/api/telos/work/items/studio', delay);
  await page.goto(front.origin + '/todos/studio?view=Chat');
  await browserExpect(
    page.getByRole('status').filter({ hasText: 'Loading conversations…' }),
  ).toBeVisible();
  await capture('chooser-loading');
  expect(gatedReads).toBeGreaterThan(0);
  release();
  await browserExpect(page.getByRole('heading', { name: 'Chats · 3', exact: true })).toBeVisible();
  // The settled composition comparison starts after real canonical collection
  // hydration exposes this parent. Early interaction across that transition is
  // retained as a separate chooser-hydration regression, not waived here.
  await browserExpect(
    page.getByRole('button', { name: 'Recording programme', exact: true }),
  ).toBeVisible();
  await browserExpect(page.locator('html')).toHaveAttribute('data-theme', profile.theme);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    profile.motion === 'reduce',
  );
  const chooserRows = await page.locator('.telos-chat-row').evaluateAll((rows) =>
    rows.map((row) => ({
      accessibleName: row.getAttribute('aria-label'),
      text: (row as HTMLElement).innerText,
      height: row.getBoundingClientRect().height,
      metadata: [...row.querySelectorAll('small')].map((s) => {
        const range = document.createRange();
        range.selectNodeContents(s);
        return {
          text: s.textContent,
          height: s.getBoundingClientRect().height,
          lineCount: range.getClientRects().length,
        };
      }),
    })),
  );
  await capture('chooser-ready');
  // Additive correction observations. Keep all prior journey assertions and
  // raw geometry intact; primary creation is checked against the actual store,
  // while immutable link/source provenance remains keyboard-accessible.
  const chooserPresentation: Array<Record<string, unknown>> = [];
  const chooserWork = await api.read('studio');
  for (const [id, label, title] of [
    ['planning', 'Originating conversation', 'Studio planning'],
    [lead, 'Assigned lead', 'Studio planning lead'],
    [additional, 'Additional lead conversation', 'Additional acoustic discussion'],
  ]) {
    const row = page.getByRole('button', { name: `Open ${label}: ${title}`, exact: true });
    const primaryText = await row.innerText();
    const roleLine = row.locator('.telos-chat-role-settings');
    await browserExpect(roleLine).toContainText(label);
    await browserExpect(roleLine).toContainText('Offline personal');
    await browserExpect(roleLine).toContainText('Offline fixture');
    expect(primaryText).not.toMatch(/operator:[a-f0-9-]{20,}|Linked \d{4}/);
    const createdAt = chat.eventStore.getSession(id)!.createdAt;
    const expectedCreated = new Date(createdAt).toISOString();
    const time = row.locator('time');
    await browserExpect(time).toHaveAttribute('datetime', expectedCreated);
    await browserExpect(time).toContainText('Created ');
    const detailLine = time.locator('..');
    if (id !== 'planning') {
      await browserExpect(detailLine).toContainText(f.agentProfile.definition.name);
      await browserExpect(detailLine).toContainText('Local Mac');
    }
    const disclosure = row.locator('..').locator('details.telos-chat-provenance');
    const summary = disclosure.locator('summary');
    const originalSummary = await summary.elementHandle();
    await browserExpect(summary).toHaveText('Conversation provenance');
    await summary.focus();
    await browserExpect(summary).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(disclosure).toHaveAttribute('open', '');
    const focusAfterOpen = await summary.evaluate((node) => document.activeElement === node);
    expect
      .soft(focusAfterOpen, 'native disclosure activation must retain keyboard focus')
      .toBe(true);
    const provenanceText = await disclosure.locator('dl').innerText();
    for (const link of chooserWork.links.filter(
      (link) => link.conversation.conversationId === id,
    )) {
      expect(provenanceText).toContain(link.linkedAt ?? 'Linked date unknown');
      expect(provenanceText).toContain(link.linkedBy ?? 'Author unknown');
    }
    for (const source of sources.filter((source) => source.source?.conversationId === id)) {
      expect(provenanceText).toContain(source.snapshotId);
      expect(provenanceText).toContain(source.author ?? 'Author unknown');
      if (source.sourceCreatedAt) expect(provenanceText).toContain(source.sourceCreatedAt);
    }
    if (id === lead) await capture('chooser-provenance');
    const summaryBox = await summary.boundingBox();
    expect(summaryBox!.height).toBeGreaterThanOrEqual(44);
    // Continuous keyboard close: never restore focus to hide an App regression.
    await page.keyboard.press('Enter');
    await browserExpect(disclosure).not.toHaveAttribute('open', '');
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, `chooser-focus-${id}.json`),
        JSON.stringify(
          {
            id,
            original: await originalSummary!.evaluate((node) => ({
              connected: node.isConnected,
              focused: document.activeElement === node,
              node: node.outerHTML,
            })),
            current: await summary.evaluate((node) => ({
              focused: document.activeElement === node,
              node: node.outerHTML,
              active: document.activeElement?.outerHTML.slice(0, 500),
              visibility: document.visibilityState,
              documentFocused: document.hasFocus(),
            })),
          },
          null,
          2,
        ),
      );
    const focusAfterClose = await summary.evaluate((node) => document.activeElement === node);
    expect.soft(focusAfterClose, 'native disclosure close must retain keyboard focus').toBe(true);
    chooserPresentation.push({
      id,
      label,
      primaryText,
      roleLine: await roleLine.innerText(),
      detailLine: await detailLine.innerText(),
      actualCreatedAt: createdAt,
      expectedCreated,
      provenanceText,
      summaryBox,
      focusAfterOpen,
      focusAfterClose,
    });
  }
  await activate(
    page.getByRole('button', { name: 'Open Assigned lead: Studio planning lead', exact: true }),
  );
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + lead + '(?:\\?|$)'));
  await h.waitForPreparedConversation(lead);
  expect(new URL(page.url()).searchParams.get('telosChatItem')).toBe('studio');
  await page
    .getByRole('textbox', { name: 'Message Mitzo' })
    .fill('Inspect only the retained fixture plan.');
  const [first] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        r.url().endsWith('/api/ordinary/workspaces/commands/first'),
    ),
    page.getByRole('button', { name: 'Send message', exact: true }).click(),
  ]);
  expect(await first.json()).toMatchObject({
    state: 'consumed',
    dispatched: true,
    sessionId: lead,
  });
  await vi.waitFor(() => expect(nativeSessions).toHaveLength(1));
  await vi.waitFor(() =>
    expect(
      nativeSessions[0].rpc.request.mock.calls.filter(([m]) => m === 'turn/start'),
    ).toHaveLength(1),
  );
  nativeSessions[0].lifecycle.onNotification('turn/completed', {
    threadId: nativeSessions[0].threadId,
    turn: { id: nativeSessions[0].turnId, status: 'completed' },
  });
  const draft = 'Keep this unsent ' + selected + ' draft.';
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill(draft);
  const toggle = page.getByRole('button', { name: 'Toggle work tree', exact: true });
  await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
  await browserExpect(page.locator('.telos-chat-context-row')).toHaveCount(1);
  const collapsed = await page.locator('.telos-chat-transcript').boundingBox();
  const header = await page.locator('.telos-chat-context-row').evaluate((row) => ({
    height: row.getBoundingClientRect().height,
    controls: [...row.querySelectorAll('button')].map((b) => ({
      label: b.getAttribute('aria-label'),
      top: b.getBoundingClientRect().top,
      width: b.getBoundingClientRect().width,
    })),
  }));
  await capture('chat-collapsed');
  await settingsHome(page);
  await browserExpect(
    page.getByRole('region', { name: 'Agent settings', exact: true }),
  ).toBeVisible();
  await browserExpect(
    page.getByRole('region', { name: 'Agent settings', exact: true }),
  ).toContainText('Offline personal');
  await capture('settings-main');
  await openChatSetting(page, 'model');
  await capture('settings-model');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await settleMotion();
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(draft);
  await activate(toggle);
  await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
  const workTree = page.getByRole('region', { name: 'Work tree', exact: true });
  await browserExpect(workTree).toBeVisible();
  await capture('chat-tree-open');
  const treeRows = await workTree.locator('.telos-tree-row').evaluateAll((rows) =>
    rows.map((row) => {
      const title = row.querySelector('.telos-node-title')!;
      const range = document.createRange();
      range.selectNodeContents(title);
      return {
        text: (row as HTMLElement).innerText,
        rowWidth: row.getBoundingClientRect().width,
        title: title.textContent,
        titleWidth: title.getBoundingClientRect().width,
        titleLineCount: range.getClientRects().length,
        height: row.getBoundingClientRect().height,
        status: row.querySelector('.telos-node-status')?.textContent,
        priority: row.querySelector('.todo-priority-badge')?.textContent,
        titleBox: title.getBoundingClientRect().toJSON(),
        statusBox: row.querySelector('.telos-node-status')?.getBoundingClientRect().toJSON(),
        priorityBox: row.querySelector('.todo-priority-badge')?.getBoundingClientRect().toJSON(),
      };
    }),
  );
  const programme = workTree
    .locator('.telos-tree-row')
    .filter({ hasText: 'Recording programme' })
    .first();
  await browserExpect(programme.locator('.telos-node-status')).toBeVisible();
  await browserExpect(programme.locator('.telos-node-status')).toHaveText('active');
  await browserExpect(programme.locator('.todo-priority-badge')).toBeVisible();
  await browserExpect(programme.locator('.todo-priority-badge')).toHaveText('P5');
  for (const row of treeRows) {
    expect.soft(row.titleLineCount, selected + ' compact title readability').toBe(1);
    expect.soft(row.statusBox!.height, 'canonical status remains visible').toBeGreaterThan(0);
    expect.soft(row.priorityBox!.height, 'priority remains visible').toBeGreaterThan(0);
    expect.soft(row.titleBox.right).toBeLessThanOrEqual(row.priorityBox!.left + 1);
  }
  const closeTree = page.getByRole('button', { name: 'Close work tree', exact: true });
  await closeTree.focus();
  await closeTree.press('Escape');
  await browserExpect(workTree).toBeHidden();
  await browserExpect(toggle).toBeFocused();
  const restored = await page.locator('.telos-chat-transcript').boundingBox();
  expect(restored!.width).toBeCloseTo(collapsed!.width, 0);
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(draft);
  await capture('chat-tree-closed');
  await activate(page.getByRole('button', { name: 'Open session tray', exact: true }));
  const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
  await browserExpect(resources).toBeVisible();
  await browserExpect(resources.getByRole('tab')).toHaveCount(5);
  await capture('resources-sources');
  await resources.getByRole('tab', { name: 'Context', exact: true }).click();
  await capture('resources-context');
  await resources.getByRole('button', { name: 'Close', exact: true }).click();
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(draft);
  await page.getByRole('button', { name: 'View item: Home studio', exact: true }).click();
  await page.getByRole('button', { name: 'Materials', exact: true }).click();
  const outputs = page.getByRole('region', { name: 'Outputs', exact: true });
  await outputs.getByRole('link', { name: 'Acoustic plan', exact: true }).click();
  await browserExpect(page.getByRole('dialog')).toContainText('The reviewed panel layout.');
  await capture('saved-artifact-readable');
  const badPin = new URL(page.url());
  badPin.searchParams.set('savedRevision', '999');
  await page.goto(badPin.href);
  await browserExpect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await capture('saved-artifact-real-refusal');
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  await browserExpect(page.getByRole('dialog')).toHaveCount(0);
  expect((await api.read('studio')).assignments).toMatchObject([
    { role: 'lead', revision: 1, conversation: { conversationId: lead } },
  ]);
  expect((await api.read('studio')).sources).toEqual(sources);
  expect(canonical.artifacts.read(material.artifactId, material.revision).sha256).toBe(
    material.sha256,
  );
  expect(chat.eventStore.listSessions()).toHaveLength(baselineSessions);
  expect(nativeSessions).toHaveLength(1);
  expect(nativeSessions[0].rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(
    1,
  );
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'ux-observations.json'),
      JSON.stringify(
        {
          selected,
          profile,
          captures,
          geometry,
          motionObservations,
          chooserRows,
          chooserPresentation,
          header,
          treeRows,
          collapsed,
          restored,
          touchActivations,
          lead,
          additional,
          gatedReads,
          nativeLaunches: nativeSessions.length,
          rawOperatorIdsPresent: chooserRows.some((r) => /operator:[a-f0-9-]{20,}/.test(r.text)),
          source:
            'ActualApp only; approved mock source/retained captures read separately, never opened or served.',
        },
        null,
        2,
      ),
    );
  for (const observation of geometry)
    expect.soft(observation.width, observation.stage).toBeLessThanOrEqual(observation.viewport);
  expect(touchActivations).toBe(profile.touch ? 3 : 0);
}, 90_000);
