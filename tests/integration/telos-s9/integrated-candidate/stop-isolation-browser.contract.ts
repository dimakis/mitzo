import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

// UX18/21/22 bounded current-contract journey. Bound chat intentionally keeps
// legacy local queues behind guarded admission and omits replacement interrupts.
// This does not assert full ordinary-control parity or Symposium qualification.
it('Actual App Stop cancels only the selected unrelated outcome while retaining drafts, queues and the other native turn', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 1280, height: 900 } });
  const { canonical, f, api, ordinary, chat, page, front, nativeSessions } = h;
  canonical.db
    .prepare(
      `INSERT INTO items
      (id,summary,intent,rationale,acceptance_criteria,profile,priority,
      first_seen,last_seen,created_at,updated_at)
      VALUES('quarterly','Quarterly connections','Review the quarter','Support the team',
      '["Reviewed notes"]','manual',4,?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  const ids: string[] = [];
  for (const itemId of ['studio', 'quarterly']) {
    await api.execute({
      operation: 'classify',
      itemId,
      kind: 'outcome',
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
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
      itemId,
      role: 'lead',
      sourceSnapshotIds: [],
      artifactRefs:
        itemId === 'studio'
          ? [
              {
                artifactId: canonical.material.id,
                revision: canonical.material.revision,
                sha256: canonical.material.sha256,
              },
            ]
          : [],
    });
    const receipt = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: reviewed.presentationRef,
      input: {
        version: 2,
        itemId,
        requestId: randomUUID(),
        role: 'lead',
        expectedRevision: reviewed.selection.brief.revision,
        expectedAssignmentRevision: 0,
        contextSelection: reviewed.selection,
        settings: {
          version: 2,
          binding: prepared.runtimeBinding,
          selection: f.first.request.selection,
          workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
        },
      },
    });
    ids.push(receipt.work.assignments[0].conversation.conversationId);
  }
  expect(new Set(ids).size).toBe(2);
  expect(nativeSessions).toHaveLength(0);
  const workBefore = await Promise.all(['studio', 'quarterly'].map((id) => api.read(id)));
  const sessionsBefore = chat.eventStore.listSessions().length;
  const queues = ids.map((id, index) => ({
    key: 'mitzo-queue-' + id,
    value: JSON.stringify([
      {
        text: 'Retained local queue for outcome ' + index,
        contextBlocks: [],
        queueEntryId: randomUUID(),
      },
    ]),
  }));
  await page.addInitScript((entries) => {
    for (const entry of entries)
      if (localStorage.getItem(entry.key) === null) localStorage.setItem(entry.key, entry.value);
  }, queues);
  const commandPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stopPosts: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/chat/stop'))
      stopPosts.push(request.postDataJSON());
    if (request.method() === 'POST' && request.url().includes('/api/ordinary/workspaces/commands/'))
      commandPosts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  const drafts = ['Keep the studio cancellation draft.', 'Keep the unrelated quarterly draft.'];
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  const stop = page.getByRole('button', { name: 'Stop generation', exact: true });
  for (let index = 0; index < ids.length; index++) {
    await page.goto(front.origin + '/chat/' + ids[index]);
    await h.waitForPreparedConversation(ids[index]);
    await composer.fill('Start only outcome ' + index + ' for this offline probe.');
    const [first] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(first.status()).toBe(202);
    expect(await first.json()).toMatchObject({
      sessionId: ids[index],
      state: 'consumed',
      dispatched: true,
    });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(index + 1));
    await vi.waitFor(() =>
      expect(
        nativeSessions[index].rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(1),
    );
    await browserExpect(stop).toBeVisible();
    await composer.fill(drafts[index]);
    await browserExpect(
      page.getByRole('button', { name: 'Interrupt and send now', exact: true }),
    ).toHaveCount(0);
  }
  const readQueues = () =>
    page.evaluate((entries) => entries.map((entry) => localStorage.getItem(entry.key)), queues);
  expect(await readQueues()).toEqual(queues.map((q) => q.value));
  await page.goto(front.origin + '/chat/' + ids[0]);
  await browserExpect(composer).toHaveValue(drafts[0]);
  await browserExpect(stop).toBeVisible();
  const [cancel] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/chat/stop'),
    ),
    stop.click(),
  ]);
  expect(cancel.request().postDataJSON()).toEqual({ type: 'stop', sessionId: ids[0] });
  expect(cancel.status()).toBe(200);
  expect(await cancel.json()).toEqual({ ok: true });
  // Runtime close and owned-local custody cleanup both close the same RPC.
  // One public Stop, selected cancellation and no other native effect are the
  // contract; internal idempotent cleanup callback count is not that receipt.
  await vi.waitFor(() => expect(nativeSessions[0].rpc.close).toHaveBeenCalled());
  expect(nativeSessions[1].rpc.close).not.toHaveBeenCalled();
  await browserExpect(stop).toBeHidden();
  await browserExpect(composer).toHaveValue(drafts[0]);
  expect(await readQueues()).toEqual(queues.map((q) => q.value));
  const afterStopRegistry = ids.map((id) => ({
    id,
    attached: !!chat.registry.findBySessionId(id),
  }));
  expect(afterStopRegistry).toEqual([
    { id: ids[0], attached: false },
    { id: ids[1], attached: true },
  ]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'studio-stopped-draft-retained.png'),
      fullPage: true,
    });
  await page.goto(front.origin + '/chat/' + ids[1]);
  await browserExpect(composer).toHaveValue(drafts[1]);
  await browserExpect(stop).toBeVisible();
  const survivor = nativeSessions[1];
  const reply = 'The unrelated quarterly conversation completed independently.';
  survivor.lifecycle.onNotification('item/agentMessage/delta', {
    threadId: survivor.threadId,
    turnId: survivor.turnId,
    itemId: 'survivor',
    delta: reply,
  });
  survivor.lifecycle.onNotification('item/completed', {
    threadId: survivor.threadId,
    turnId: survivor.turnId,
    item: { type: 'agentMessage', id: 'survivor', text: reply },
  });
  survivor.lifecycle.onNotification('turn/completed', {
    threadId: survivor.threadId,
    turn: { id: survivor.turnId, status: 'completed' },
  });
  await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
  await browserExpect(stop).toBeHidden();
  await browserExpect(composer).toHaveValue(drafts[1]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'quarterly-unaffected-completed.png'),
      fullPage: true,
    });
  await page.reload();
  await browserExpect(composer).toHaveValue(drafts[1]);
  await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
  expect(await readQueues()).toEqual(queues.map((q) => q.value));
  await page.goto(front.origin + '/chat/' + ids[0]);
  await browserExpect(composer).toHaveValue(drafts[0]);
  await browserExpect(page.getByText(reply, { exact: true })).toHaveCount(0);
  expect(await readQueues()).toEqual(queues.map((q) => q.value));
  expect(commandPosts).toHaveLength(2);
  expect(stopPosts).toEqual([{ type: 'stop', sessionId: ids[0] }]);
  expect(commandPosts.map((p) => p.body.sessionId)).toEqual(ids);
  expect(new Set(commandPosts.map((p) => p.body.clientMsgId)).size).toBe(2);
  expect(nativeSessions).toHaveLength(2);
  for (const native of nativeSessions)
    expect(
      native.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(1);
  expect(nativeSessions[1].rpc.close).not.toHaveBeenCalled();
  expect(chat.eventStore.listSessions()).toHaveLength(sessionsBefore);
  expect(await Promise.all(['studio', 'quarterly'].map((id) => api.read(id)))).toEqual(workBefore);
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'stop-isolation-observations.json'),
      JSON.stringify(
        {
          ids,
          commandPosts,
          stopPosts,
          queues,
          drafts,
          afterStopRegistry,
          nativeLaunches: nativeSessions.length,
          selectedCloseCount: nativeSessions[0].rpc.close.mock.calls.length,
          survivorCloseCount: nativeSessions[1].rpc.close.mock.calls.length,
          survivorReply: reply,
          pageErrors: h.pageErrors,
          limits:
            'Bounded ordinary cancellation/current guarded-queue isolation only; no queued replacement/interrupt parity, Symposium coexistence, process restart or live model qualification.',
        },
        null,
        2,
      ),
    );
}, 90_000);
