import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';

it('compares Telos and non-Telos bound ordinary controls on the same account, profile and runtime without a legacy fallback', async () => {
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { api, f, prepared, chat, page, front, nativeSessions } = h;
  const ordinaryId = f.first.receipt.sessionId;
  expect(await api.links({ namespace: 'mitzo', conversationId: ordinaryId })).toEqual([]);
  await api.execute({
    operation: 'classify',
    itemId: 'studio',
    kind: 'outcome',
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
  });
  const review = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const receipt = await api.setupReviewedOrdinaryRole({
    version: 2,
    presentationRef: review.presentationRef,
    input: {
      version: 2,
      itemId: 'studio',
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
  const telosId = receipt.work.assignments[0].conversation.conversationId;
  expect(await api.links({ namespace: 'mitzo', conversationId: telosId })).toHaveLength(1);
  const ids = [ordinaryId, telosId];
  const meta = await Promise.all(
    ids.map(async (id) => (await h.http('/api/sessions/' + id + '/meta')).json()),
  );
  expect(meta[1].runtimeBinding).toEqual(meta[0].runtimeBinding);
  expect(meta[1].accountBinding).toEqual(meta[0].accountBinding);
  expect(meta[1].agentProfile).toEqual(meta[0].agentProfile);
  const observations: Array<Record<string, unknown>> = [];
  const composer = page.getByRole('textbox', { name: 'Message Mitzo' });
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  for (const [index, id] of ids.entries()) {
    const label = index === 0 ? 'ordinary' : 'telos';
    await page.goto(front.origin + '/chat/' + id);
    await h.waitForPreparedConversation(id);
    await composer.fill('First command for the ' + label + ' control comparison.');
    const [first] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(first.status()).toBe(202);
    expect(await first.json()).toMatchObject({
      state: 'consumed',
      dispatched: true,
      sessionId: id,
    });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(index + 1));
    await vi.waitFor(() =>
      expect(
        nativeSessions[index].rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(1),
    );
    const draft = 'Keep the ' + label + ' comparison draft.';
    await composer.fill(draft);
    const stop = page.getByRole('button', { name: 'Stop generation', exact: true });
    await browserExpect(stop).toBeVisible();
    const queue = page.getByRole('button', { name: 'Queue message', exact: true });
    await browserExpect(queue).toBeEnabled();
    const interrupt = page.getByRole('button', { name: 'Interrupt and send now', exact: true });
    await browserExpect(interrupt).toHaveCount(0);
    await capture(label + '-running-controls');
    const native = nativeSessions[index];
    const rawRpc = native.rpc.request.getMockImplementation()!;
    const queuedTurnId = native.turnId + '-guarded-queue';
    // Provider effects remain fake. Return a distinct native turn identity for
    // the continuation; real admission, durable queue and scheduling stay owned.
    native.rpc.request.mockImplementation(async (method, params) => {
      const response = await rawRpc(method, params);
      return method === 'turn/start' ? { turn: { id: queuedTurnId } } : response;
    });
    const queuedText = 'Admit this ' + label + ' follow-up through guarded native FIFO.';
    await composer.fill(queuedText);
    const [queued] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/continue'),
      ),
      queue.click(),
    ]);
    expect(queued.status()).toBe(202);
    const queueReceipt = await queued.json();
    expect(queueReceipt).toMatchObject({ state: 'consumed', sessionId: id });
    const queueRequest = queued.request().postDataJSON();
    const firstRequest = first.request().postDataJSON();
    for (const field of ['runtime', 'selection', 'workspace'])
      expect(queueRequest[field]).toEqual(firstRequest[field]);
    expect(queueRequest.payload.text).toBe(queuedText);
    expect(queueRequest.clientMsgId).not.toBe(firstRequest.clientMsgId);
    expect(chat.eventStore.getSendCommand(queueRequest.clientMsgId)).toMatchObject({
      sessionId: id,
    });
    expect(chat.eventStore.getOrdinaryCommandAdmission(queueRequest.clientMsgId)).toMatchObject({
      state: 'consumed',
    });
    expect(
      native.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(1);
    await browserExpect(composer).toHaveValue('');
    await composer.fill(draft);
    await capture(label + '-guarded-queue-admitted');
    native.lifecycle.onNotification('turn/completed', {
      threadId: native.threadId,
      turn: { id: native.turnId, status: 'completed' },
    });
    await vi.waitFor(() =>
      expect(
        native.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(2),
    );
    const starts = native.rpc.request.mock.calls.filter(([method]) => method === 'turn/start');
    expect(JSON.stringify(starts[0])).toContain(firstRequest.payload.text);
    expect(JSON.stringify(starts[1])).toContain(queuedText);
    native.lifecycle.onNotification('turn/completed', {
      threadId: native.threadId,
      turn: { id: queuedTurnId, status: 'completed' },
    });
    await browserExpect(stop).toBeHidden();
    await browserExpect(composer).toHaveValue(draft);
    await page.getByRole('button', { name: 'More composer actions', exact: true }).click();
    const commands = page.getByRole('button', { name: 'Commands', exact: true });
    await browserExpect(commands).toBeDisabled();
    await browserExpect(
      page.getByRole('button', { name: 'Attach images or PDF', exact: true }),
    ).toBeEnabled();
    const commandsDisabled = await commands.isDisabled();
    await page.keyboard.press('Escape');
    // Local image selection/preview/removal uses the real composer and editor;
    // no image is sent to a provider and no fake owned API response is used.
    await page.locator('input[type=file]').setInputFiles({
      name: 'synthetic-pixel.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await page.getByRole('button', { name: 'Preview attachment 1', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Image preview', exact: true });
    await browserExpect(
      preview.getByRole('toolbar', { name: 'Image drawing tools' }),
    ).toBeVisible();
    await browserExpect(
      preview.getByRole('button', { name: 'Save image', exact: true }),
    ).toBeEnabled();
    const decodedImage = await preview
      .getByRole('img', { name: 'Attached image', exact: true })
      .evaluate((element) => ({
        width: (element as HTMLImageElement).naturalWidth,
        height: (element as HTMLImageElement).naturalHeight,
      }));
    expect(decodedImage).toEqual({ width: 1, height: 1 });
    await browserExpect(preview.getByRole('alert')).toHaveCount(0);
    await capture(label + '-attachment-preview');
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Remove attachment 1', exact: true }).click();
    await browserExpect(composer).toHaveValue(draft);
    await page.getByRole('button', { name: 'Open session tray', exact: true }).click();
    const resources = page.getByRole('dialog', { name: 'Resources', exact: true });
    const tabs = await resources.getByRole('tab').allTextContents();
    expect(tabs).toEqual(['Sources', 'Context', 'Outputs', 'Mockups', 'References']);
    await resources.getByRole('tab', { name: 'Context', exact: true }).click();
    await browserExpect(
      resources.getByRole('heading', { name: 'Injected context', exact: true }),
    ).toBeVisible();
    await resources.getByRole('button', { name: 'Close', exact: true }).click();
    const [accessResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/sessions/' + id + '/access')),
      page.getByRole('button', { name: 'Access', exact: true }).click(),
    ]);
    expect(accessResponse.status()).toBe(200);
    const accessEvidence = await accessResponse.json();
    expect(accessEvidence.sessionId).toBe(id);
    const access = page.getByRole('dialog', { name: 'Access', exact: true });
    await browserExpect(
      access.getByRole('button', { name: 'Refresh Access', exact: true }),
    ).toBeVisible();
    await capture(label + '-access');
    await access.getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(composer).toHaveValue(draft);
    const voiceButtons = await page
      .getByRole('button', { name: 'Record voice message', exact: true })
      .count();
    const health = await (await h.http('/api/service-health')).json();
    observations.push({
      label,
      sessionId: id,
      interruptReplacementButtons: 0,
      runningQueueEnabled: true,
      guardedQueue: {
        request: queueRequest,
        receipt: queueReceipt,
        fifoTurns: 2,
        noEarlySecondTurn: true,
      },
      stopAvailable: true,
      commandsDisabled,
      attachmentPreviewAndRemoval: true,
      decodedImage,
      resourceTabs: tabs,
      accessEvidence,
      voiceButtons,
      serviceHealth: health,
      draftRetained: true,
    });
  }
  expect(observations[1].voiceButtons).toBe(observations[0].voiceButtons);
  expect(nativeSessions).toHaveLength(2);
  for (const native of nativeSessions)
    expect(
      native.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
    ).toHaveLength(2);
  expect(await api.links({ namespace: 'mitzo', conversationId: ordinaryId })).toEqual([]);
  expect(chat.eventStore.getSession(telosId)?.ordinaryWorkspaceId).not.toBe(
    chat.eventStore.getSession(ordinaryId)?.ordinaryWorkspaceId,
  );
  expect(h.pageErrors).toEqual([]);
  if (process.env.S9_JOINED_SCREENSHOT_DIR)
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'ordinary-parity-observations.json'),
      JSON.stringify(
        {
          source:
            'same actual ChatView, account/model/profile/runtime binding, distinct ordinary workspaces; non-Telos prepared by published ordinary fixture stores, Telos by actual reviewed setup HTTP',
          meta,
          observations,
          nativeLaunches: nativeSessions.length,
          pageErrors: h.pageErrors,
          limitations:
            'Equality establishes inherited current states, not full UX22 acceptance. Actual guarded Queue admission and two native FIFO turns are exercised for each chat. Replacement interrupts, available microphone/STT/TTS, skill execution and attachment delivery remain pending. No fallback route or real provider/model calls.',
        },
        null,
        2,
      ),
    );
}, 90_000);
