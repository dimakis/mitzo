import { observeTaskChatReads } from './task-chat-read-observer';
import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('keeps attached scope usable despite unrelated transport failure and fences old coordinator release during a delayed replacement read', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { api, ordinary, canonical, page, front, f } = h;
  const facts: Array<Record<string, unknown>> = [];
  let release!: () => void;
  let heldReads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'coordinator-refresh-observations.json'),
        JSON.stringify(
          {
            facts,
            heldReads,
            nativeLaunches: h.nativeSessions.length,
            pageErrors: h.pageErrors,
            realModelCalls: 0,
          },
          null,
          2,
        ),
      );
  };
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  const insert = canonical.db.prepare(
    `INSERT INTO items (id,parent_id,summary,profile,categories,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,'manual',?,?,?,?,?)`,
  );
  const add = async (
    id: string,
    parent: string | null,
    title: string,
    kind: 'coordinator' | 'outcome',
    category = 'Mitzo',
  ) => {
    insert.run(
      id,
      parent,
      title,
      JSON.stringify([category]),
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
  const setup = async (expectedAssignmentRevision: number) => {
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
    const review = await api.reviewRoleContext({
      itemId: 'refresh-coordinator',
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const result = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: review.presentationRef,
      input: {
        version: 2,
        itemId: 'refresh-coordinator',
        role: 'lead',
        requestId: randomUUID(),
        expectedRevision: review.selection.brief.revision,
        expectedAssignmentRevision,
        contextSelection: review.selection,
        settings: {
          version: 2,
          binding: prepared.runtimeBinding,
          selection: f.first.request.selection,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
      },
    });
    return result.work.assignments[0].conversation.conversationId;
  };
  const recordReads = observeTaskChatReads(page);
  const attachedIds = Array.from({ length: 6 }, (_, index) => `refresh-feature-${index}`);
  const waitForAttachedRecords = (boundary: number) =>
    recordReads.waitForCollectionRecords(attachedIds, boundary);
  try {
    await add('refresh-coordinator', null, 'Refresh coordinator', 'coordinator');
    for (let i = 0; i < 6; i++)
      await add('refresh-feature-' + i, 'refresh-coordinator', 'Refresh feature ' + i, 'outcome');
    await add('unrelated-refresh-job', null, 'Unrelated Job record', 'outcome', 'Job');
    const oldId = await setup(0);
    let unrelatedFailures = 0;
    const unrelatedPattern = '**/api/telos/work/items/unrelated-refresh-job/record';
    await page.route(unrelatedPattern, async (route) => {
      unrelatedFailures++;
      await route.abort('failed');
    });
    // Require this document's completed canonical records before retaining
    // the original control assertions under the unrelated transport failure.
    const initialRecordBoundary = recordReads.boundary();
    await page.goto(front.origin + '/chat/' + oldId);
    await waitForAttachedRecords(initialRecordBoundary);
    const controls = page.getByRole('region', { name: 'Coordinator controls', exact: true });
    // Affected scope is read from actual canonical endpoints. No response is
    // fulfilled for the unrelated failure, and no attached record is changed.
    await browserExpect(
      controls.getByRole('button', { name: 'Refresh feature 0', exact: true }),
    ).toBeVisible();
    const priority = controls.getByRole('button', { name: 'Refresh feature 0', exact: true });
    const send = controls.getByRole('button', { name: /^Send hold to (five|six) leads$/ });
    // Even if the known bad source disables priority, record that failure and
    // recover through the actual read path before testing the separate race.
    await browserExpect(priority)
      .toBeEnabled()
      .catch(() => {});
    expect.soft(await priority.isEnabled()).toBe(true);
    if (await priority.isEnabled()) await priority.click();
    await browserExpect(send)
      .toBeEnabled()
      .catch(() => {});
    expect.soft(await send.isEnabled()).toBe(true);
    expect(unrelatedFailures).toBe(0);
    facts.push({
      stage: 'unrelated-transport-failure',
      unrelatedFailures,
      priorityEnabled: await priority.isEnabled(),
      sendEnabled: await send.isEnabled(),
      actualCurrentControls: await controls.innerText(),
    });
    await capture('unrelated-failure-valid-attached-scope');
    await save();
    await page.unroute(unrelatedPattern);
    const reloadRecordBoundary = recordReads.boundary();
    await page.reload();
    await waitForAttachedRecords(reloadRecordBoundary);
    await controls.getByRole('button', { name: 'Refresh feature 0', exact: true }).click();
    const [requestedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'request',
      ),
      send.click(),
    ]);
    expect(requestedResponse.status()).toBe(200);
    const original = await requestedResponse.json();
    expect(original.stage).toBe('requested');
    const releaseButton = controls.getByRole('button', { name: 'Release held leads', exact: true });
    await browserExpect(releaseButton).toBeEnabled();
    const replacementId = await setup(1);
    expect(replacementId).not.toBe(oldId);
    // The shared collection replaces six per-item hydration reads. Observe its
    // actual completed body after this reconnect, independently of the held role read.
    const reconnectBoundary = recordReads.boundary();
    await page.route('**/api/telos/work/items/refresh-coordinator', async (route) => {
      heldReads++;
      await gate;
      await route.continue();
    });
    const readInbox = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/telos/work/controls') &&
        r.request().postDataJSON().operation === 'inbox' &&
        r.status() === 200,
    );
    // Close the actual broadcast SSE transport; its real EventSource reconnect
    // triggers existing onConnectionChange refreshes. No synthetic DTO/event.
    h.application.sseRegistry.destroy();
    await vi.waitFor(() => expect(heldReads).toBeGreaterThan(0), { timeout: 10_000 });
    await readInbox;
    const refreshed = await waitForAttachedRecords(reconnectBoundary);
    const completedRelated = refreshed.body.records
      .filter((record) => attachedIds.includes(record.itemId))
      .map((record) => record.itemId)
      .sort();
    const pendingRelated = recordReads
      .pending()
      .filter(
        (read) =>
          read.requestOrdinal > reconnectBoundary && read.path === '/api/telos/work/collection',
      );
    expect(pendingRelated).toHaveLength(0);
    expect(
      recordReads
        .since(reconnectBoundary)
        .filter((read) =>
          attachedIds.some((id) => read.path === `/api/telos/work/items/${id}/record`),
        ),
    ).toHaveLength(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const whileHeld = {
      oldId,
      replacementId,
      heldReads,
      relatedCompleted: completedRelated,
      pendingRelated: pendingRelated.length,
      releaseEnabled: await releaseButton.isEnabled(),
      controlText: await controls.innerText(),
    };
    facts.push({ stage: 'replacement-read-held-after-real-reconnect', ...whileHeld });
    await capture('replacement-read-pending-no-release');
    await save();
    expect.soft(whileHeld.releaseEnabled).toBe(false);
    const actualReplacedRead = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/telos/work/items/refresh-coordinator' &&
        r.status() === 200,
    );
    release();
    const fresh = await (await actualReplacedRead).json();
    expect(fresh.assignments[0].conversation.conversationId).toBe(replacementId);
    await browserExpect(controls).toHaveCount(0);
    expect(await api.control({ operation: 'read', controlId: original.controlId })).toEqual(
      original,
    );
    expect(h.nativeSessions).toHaveLength(0);
    expect(h.pageErrors).toEqual([]);
    facts.push({
      stage: 'replacement-read-released',
      replacementId,
      oldControlsRemoved: true,
      originalControlUnchanged: true,
    });
    await save();
  } finally {
    recordReads.close();
    release();
    await save();
  }
}, 90_000);
