import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('restores filtered searched pinned outcome-list scroll after nested item and ordinary-chat return at narrow and desktop widths', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { canonical, api, page, front, f, prepared, nativeSessions, chat } = h;
  const insert = canonical.db.prepare(`INSERT INTO items
    (id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,categories,context_hints,first_seen,last_seen,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'manual',5,?,'{}',?,?,?,?)`);
  const add = async (
    id: string,
    parent: string | null,
    title: string,
    kind: 'coordinator' | 'outcome' | 'work_item',
  ) => {
    insert.run(
      id,
      parent,
      title,
      'Preserve the navigation context',
      'Synthetic canonical navigation evidence',
      JSON.stringify(['Return without losing discovery context']),
      JSON.stringify(['Job', 'Navigation lab']),
      canonical.stamp,
      canonical.stamp,
      canonical.stamp,
      canonical.stamp,
    );
    await api.execute({
      operation: 'classify',
      itemId: id,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(id)).revision,
    });
  };
  await add('navigation-root', null, 'Navigation programme', 'coordinator');
  for (let index = 1; index <= 24; index++)
    await add(
      'navigation-' + index,
      'navigation-root',
      'Navigation target ' + String(index).padStart(2, '0'),
      'outcome',
    );
  const nestedId = 'navigation-nested',
    nestedTitle = 'Navigation target 24 · nested review',
    parentTitle = 'Navigation target 24';
  await add(nestedId, 'navigation-24', nestedTitle, 'work_item');
  // Setup itself uses the accepted real reviewed ordinary role owner. The test
  // never sends a command; a tree entry can open the existing lead conversation.
  const review = await api.reviewRoleContext({
    itemId: 'navigation-24',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const setup = await api.setupReviewedOrdinaryRole({
    version: 2,
    presentationRef: review.presentationRef,
    input: {
      version: 2,
      itemId: 'navigation-24',
      requestId: randomUUID(),
      role: 'lead',
      expectedRevision: review.selection.brief.revision,
      expectedAssignmentRevision: 0,
      contextSelection: review.selection,
      settings: {
        version: 2,
        binding: prepared.runtimeBinding,
        selection: f.first.request.selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
    },
  });
  const leadId = setup.work.assignments[0].conversation.conversationId;
  const before = await api.read('navigation-24'),
    sessionCount = chat.eventStore.listSessions().length;
  const profiles = [
    { name: 'narrow', width: 320, height: 900, reducedMotion: 'reduce' as const },
    { name: 'desktop', width: 1280, height: 900, reducedMotion: 'no-preference' as const },
  ];
  const observations: Array<Record<string, unknown>> = [];
  const tree = page.getByRole('region', { name: 'Outcomes tree', exact: true });
  const pins = tree.getByLabel('Pinned categories', { exact: true });
  const search = tree.getByRole('searchbox', { name: 'Search Telos tree', exact: true });
  const scroll = page.locator('.todo-scroll');
  const row = (title: string) =>
    tree
      .locator('.telos-tree-row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  const readScroll = () =>
    scroll.evaluate((el) => ({
      top: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
  const checkpoints: Array<Record<string, unknown>> = [];
  const readiness: unknown[] = [];
  const settleList = async (stage: string) => {
    await browserExpect(tree.getByText('Loading conversations…', { exact: true })).toHaveCount(0);
    const measured = await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const animations = document.getAnimations();
      const observed = animations.map((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const end = animation.effect?.getComputedTiming().endTime;
        const waited =
          typeof end === 'number' &&
          Number.isFinite(end) &&
          !!target &&
          target.getClientRects().length > 0 &&
          target.checkVisibility() &&
          (animation.playState === 'running' || animation.pending);
        return { target: target?.className, playState: animation.playState, waited };
      });
      await Promise.all(
        animations
          .filter((_, index) => observed[index].waited)
          .map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return observed;
    });
    readiness.push({ stage, animations: measured, scroll: await readScroll() });
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'navigation-readiness-observations.json'),
        JSON.stringify(readiness, null, 2),
      );
  };

  const assertRestored = async (name: string, expected: { top: number }) => {
    try {
      await browserExpect
        .poll(async () => Math.abs((await readScroll()).top - expected.top))
        .toBeLessThanOrEqual(1);
    } finally {
      checkpoints.push({
        name,
        expected,
        actual: await readScroll(),
        url: page.url(),
        preferences: await page.evaluate(() =>
          JSON.parse(localStorage.getItem('telos.outcomes.navigation.v1')!),
        ),
      });
      if (process.env.S9_JOINED_SCREENSHOT_DIR)
        await writeFile(
          join(process.env.S9_JOINED_SCREENSHOT_DIR, 'navigation-context-checkpoints.json'),
          JSON.stringify(checkpoints, null, 2),
        );
      await capture(name);
    }
  };
  for (const profile of profiles) {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.emulateMedia({ reducedMotion: profile.reducedMotion });
    await page.goto(front.origin + '/todos');
    await browserExpect(
      tree.getByRole('button', { name: 'All outcomes', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await search.fill('');
    await pins.getByRole('button', { name: 'Job', exact: true }).click();
    await browserExpect(row(nestedTitle)).toBeVisible();
    await browserExpect(row('Home studio')).toHaveCount(0);
    await capture(profile.name + '-job-filter');
    await pins.getByRole('button', { name: 'Browse categories', exact: true }).click();
    // The second viewport rediscovers the already-pinned real device preference;
    // unpin/pin is an actual UI action, not a localStorage fixture replacement.
    const unpin = tree.getByRole('button', { name: 'Unpin Navigation lab', exact: true });
    if (await unpin.count()) await unpin.click();
    await tree.getByRole('button', { name: 'Pin Navigation lab', exact: true }).click();
    await page.keyboard.press('Escape');
    await browserExpect(
      pins.getByRole('button', { name: 'Browse categories', exact: true }),
    ).toBeFocused();
    await pins.getByRole('button', { name: 'Navigation lab', exact: true }).click();
    await search.fill('Navigation target');
    await browserExpect(row(nestedTitle)).toBeVisible();
    await browserExpect(row('Navigation programme')).toBeVisible();
    const hierarchy = await row(nestedTitle).evaluate((el) => {
      const names: string[] = [];
      let node: Element | null = el;
      while (node) {
        if (node.tagName === 'LI')
          names.push(
            node.querySelector(':scope > .telos-tree-row .telos-node-title')!.textContent!,
          );
        node = node.parentElement;
      }
      return names;
    });
    expect(hierarchy).toEqual([nestedTitle, parentTitle, 'Navigation programme']);
    await settleList(profile.name + '-before-departure');
    await row(nestedTitle).scrollIntoViewIfNeeded();
    await capture(profile.name + '-searched-nested-before-open');
    const itemBefore = await readScroll();
    expect(itemBefore.top).toBeGreaterThan(300);
    await row(nestedTitle).getByRole('button', { name: nestedTitle, exact: true }).click();
    await browserExpect(page).toHaveURL(front.origin + '/todos/' + nestedId);
    await browserExpect(
      page.getByRole('heading', { name: nestedTitle, exact: true }),
    ).toBeVisible();
    await capture(profile.name + '-nested-item');
    await page
      .locator('.telos-item-workspace')
      .getByRole('button', { name: 'Back', exact: true })
      .click();
    await browserExpect(page).toHaveURL(front.origin + '/todos');
    await browserExpect(search).toHaveValue('Navigation target');
    await browserExpect(
      pins.getByRole('button', { name: 'Navigation lab', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await assertRestored(profile.name + '-item-return-restored', itemBefore);
    const itemAfter = await readScroll();
    await capture(profile.name + '-item-return-restored');
    await row(parentTitle)
      .getByRole('button', { name: 'Lead chat', exact: true })
      .scrollIntoViewIfNeeded();
    await settleList(profile.name + '-before-chat-departure');
    const chatBefore = await readScroll();
    await row(parentTitle).getByRole('button', { name: 'Lead chat', exact: true }).click();
    await browserExpect(page).toHaveURL(new RegExp('/chat/' + leadId));
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const draft = profile.name + ' navigation draft retained without execution.';
    await composer.fill(draft);
    await browserExpect(
      page.getByRole('button', { name: 'Toggle work tree', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false');
    await capture(profile.name + '-ordinary-chat');
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await browserExpect(page).toHaveURL(
      front.origin + '/todos/navigation-24?view=Chat&chooseChat=1',
    );
    await browserExpect(
      page.getByRole('heading', { name: 'Chats · 1', exact: true }),
    ).toBeVisible();
    await page
      .locator('.telos-item-workspace')
      .getByRole('button', { name: 'Back', exact: true })
      .click();
    await browserExpect(page).toHaveURL(front.origin + '/todos');
    await browserExpect(search).toHaveValue('Navigation target');
    await browserExpect(
      pins.getByRole('button', { name: 'Navigation lab', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await assertRestored(profile.name + '-chat-return-restored', chatBefore);
    const chatAfter = await readScroll();
    await capture(profile.name + '-chat-return-restored');
    await row(parentTitle).getByRole('button', { name: 'Lead chat', exact: true }).click();
    await browserExpect(page).toHaveURL(new RegExp('/chat/' + leadId));
    // The prior return intentionally forced a chooser; choose the existing chat
    // if that actual device preference now remains, never reconfigure its role.
    await browserExpect(composer).toHaveValue(draft);
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await page
      .locator('.telos-item-workspace')
      .getByRole('button', { name: 'Back', exact: true })
      .click();
    observations.push({
      profile,
      hierarchy,
      itemBefore,
      itemAfter,
      chatBefore,
      chatAfter,
      leadId,
      draft,
      ownNavigationPreferences: await page.evaluate(() =>
        JSON.parse(localStorage.getItem('telos.outcomes.navigation.v1')!),
      ),
    });
  }
  expect(await api.read('navigation-24')).toEqual(before);
  expect(chat.eventStore.listSessions()).toHaveLength(sessionCount);
  expect(nativeSessions).toHaveLength(0);
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'navigation-context-observations.json'),
      JSON.stringify(
        {
          observations,
          nativeLaunches: 0,
          sessionsBefore: sessionCount,
          sessionsAfter: chat.eventStore.listSessions().length,
          beforeWork: before,
          afterWork: await api.read('navigation-24'),
          pageErrors: h.pageErrors,
          scope:
            'One bounded actual-App case across two viewport contexts. No API fulfilment, manual scroll repair after return, provider/native/model calls, source edits or fullUX/device/main claim.',
        },
        null,
        2,
      ),
    );
}, 90_000);
