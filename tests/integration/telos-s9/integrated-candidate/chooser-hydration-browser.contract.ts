import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('keeps an interactive chooser disclosure and keyboard focus while canonical collection parent records hydrate', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { canonical, f, api, ordinary, chat, page, front } = h;
  canonical.db
    .prepare(
      `INSERT INTO items (id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES('hydration-parent','Recording programme','manual',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  canonical.db.prepare('UPDATE items SET parent_id=? WHERE id=?').run('hydration-parent', 'studio');
  for (const [itemId, kind] of [
    ['hydration-parent', 'coordinator'],
    ['studio', 'outcome'],
  ] as const)
    await api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
  let lead = '';
  for (const assigned of [true, false]) {
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
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const result = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: reviewed.presentationRef,
      input: {
        version: 2,
        itemId: 'studio',
        role: 'lead',
        requestId: randomUUID(),
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
    if (assigned) {
      lead = result.work.assignments[0].conversation.conversationId;
      chat.eventStore.upsertSession({
        ...chat.eventStore.getSession(lead)!,
        summary: 'Hydration lead',
      });
    }
  }
  const beforeWork = await api.read('studio');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayedCollectionReads = 0;
  await page.route('**/api/todos**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/todos') {
      delayedCollectionReads++;
      await gate;
    }
    await route.continue();
  });
  await page.goto(front.origin + '/todos/studio?view=Chat');
  await browserExpect(page.getByRole('heading', { name: 'Chats · 2', exact: true })).toBeVisible();
  const row = page.getByRole('button', { name: 'Open Assigned lead: Hydration lead', exact: true });
  await browserExpect(row.locator('time')).toBeVisible();
  const details = row.locator('..').locator('details.telos-chat-provenance');
  const summary = details.locator('summary');
  const original = await summary.elementHandle();
  await summary.focus();
  await browserExpect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await browserExpect(details).toHaveAttribute('open', '');
  // The ae2 shared-shell correction must preserve activation focus naturally;
  // never restore it manually in this acceptance precondition.
  await browserExpect(summary).toBeFocused();
  expect(delayedCollectionReads).toBeGreaterThan(0);
  const before = await summary.evaluate((node) => ({
    focused: document.activeElement === node,
    connected: node.isConnected,
    open: (node.parentElement as HTMLDetailsElement).open,
  }));
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'before-collection-hydration.png'),
      fullPage: true,
    });
  const actualCollection = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/todos',
  );
  release();
  const response = await actualCollection;
  expect(response.status()).toBe(200);
  await browserExpect(
    page.getByRole('button', { name: 'Recording programme', exact: true }),
  ).toBeVisible();
  await browserExpect(row.locator('time')).toBeVisible();
  const after = {
    originalConnected: await original!.evaluate((node) => node.isConnected),
    current: await summary.evaluate((node) => ({
      focused: document.activeElement === node,
      connected: node.isConnected,
      open: (node.parentElement as HTMLDetailsElement).open,
      activeTag: document.activeElement?.tagName,
    })),
  };
  if (process.env.S9_JOINED_SCREENSHOT_DIR) {
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'after-collection-hydration.png'),
      fullPage: true,
    });
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'hydration-before-navigation-observation.json'),
      JSON.stringify(
        {
          before,
          after,
          nativeLaunches: h.nativeSessions.length,
          apiTransportTarget: h.apiTransportTarget,
        },
        null,
        2,
      ),
    );
  }
  const beforeNavigation = await summary.elementHandle();
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let delayedNavigationReads = 0;
  await page.route('**/api/telos/work/items/hydration-parent/record', async (route) => {
    delayedNavigationReads++;
    await navigationGate;
    await route.continue();
  });
  const navigationResponse = page
    .waitForResponse((value) =>
      value.url().endsWith('/api/telos/work/items/hydration-parent/record'),
    )
    .catch(() => null);
  const navigationRequest = page
    .waitForRequest((value) =>
      value.url().endsWith('/api/telos/work/items/hydration-parent/record'),
    )
    .catch(() => null);
  await page.getByRole('button', { name: 'Recording programme', exact: true }).click();
  await browserExpect(page).toHaveURL(/\/todos\/hydration-parent(?:\?|$)/);
  await browserExpect(page.getByText('Recording programme', { exact: true }).first()).toBeVisible();
  await browserExpect(page.getByRole('heading', { name: 'Home studio', exact: true })).toHaveCount(
    0,
  );
  await browserExpect(row).toHaveCount(0);
  expect(await navigationRequest).not.toBeNull();
  const navigation = {
    url: page.url(),
    oldChooserConnected: await beforeNavigation!.evaluate((node) => node.isConnected),
    oldHeadingCount: await page.getByRole('heading', { name: 'Home studio', exact: true }).count(),
    delayedNavigationReads,
  };
  expect(navigation.oldChooserConnected).toBe(false);
  expect(navigation.delayedNavigationReads).toBeGreaterThan(0);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'true-item-navigation.png'),
      fullPage: true,
    });
  releaseNavigation();
  const navigatedRecord = await navigationResponse;
  expect(navigatedRecord).not.toBeNull();
  expect(navigatedRecord!.status()).toBe(200);
  await browserExpect(
    page.getByRole('heading', { name: 'Recording programme', exact: true }),
  ).toBeVisible();
  if (process.env.S9_JOINED_SCREENSHOT_DIR) {
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'chooser-hydration-observations.json'),
      JSON.stringify(
        {
          lead,
          before,
          after,
          navigation,
          apiTransportTarget: h.apiTransportTarget,
          delayedCollectionReads,
          collectionStatus: response.status(),
          collectionBody: await response.json(),
          nativeLaunches: h.nativeSessions.length,
          pageErrors: h.pageErrors,
          source:
            'Actual App/canonical3077/private CLI/authHTTP/SSE. Only collection transport delayed then continued; no owned response fulfilled or provider launched.',
        },
        null,
        2,
      ),
    );
  }
  expect(await api.read('studio')).toEqual(beforeWork);
  expect(h.nativeSessions).toHaveLength(0);
  expect(h.pageErrors).toEqual([]);
  expect
    .soft(after.originalConnected, 'interactive chooser must not remount during parent hydration')
    .toBe(true);
  expect.soft(after.current.focused, 'keyboard focus must remain on the disclosure').toBe(true);
  expect.soft(after.current.open, 'open provenance must remain open').toBe(true);
}, 90_000);
