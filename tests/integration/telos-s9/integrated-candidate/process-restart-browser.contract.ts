import { readChatStorage, expectPersistedChatDraft } from '../../../support/persisted-chat-storage';
import { observeTaskChatReads, navigateToChatMetadata } from './task-chat-read-observer';
import type { OrdinaryWorkspaceFirstCommand } from '@mitzo/protocol';
import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProcessRestartFixture } from './process-restart-fixture';

it('preserves an actual admitted command and honest lost-result state through abrupt App process death, same-state recreation and exact UI recovery', async () => {
  const h = await createProcessRestartFixture();
  const { page, front, api, ordinary, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const record = async (stage: string, detail: Record<string, unknown>) => {
    observations.push({ stage, ...detail });
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'process-restart-observations.json'),
        JSON.stringify(
          { observations, pageErrors: h.pageErrors, realModelProviderCalls: 0 },
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
  try {
    expect(
      (await h.http('/api/todos')).status,
      'Actual canonical collection read before recovery',
    ).toBe(200);
    const prepared = await ordinary.prepare({
      version: 1,
      model: f.binding.model,
      runOn: 'local',
      runtime: {
        account: f.first.request.runtime.account,
        harness: f.first.request.runtime.harness,
        targetId: f.first.request.runtime.targetId,
      },
    });
    const setup = async (itemId: string) => {
      await api.execute({
        operation: 'classify',
        itemId,
        kind: 'outcome',
        requestId: randomUUID(),
        expectedRevision: (await api.read(itemId)).revision,
      });
      const review = await api.reviewRoleContext({
        itemId,
        role: 'lead',
        sourceSnapshotIds: [],
        artifactRefs: [],
      });
      const receipt = await api.setupReviewedOrdinaryRole({
        version: 2,
        presentationRef: review.presentationRef,
        input: {
          version: 2,
          itemId,
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
      return receipt.work.assignments[0].conversation.conversationId;
    };
    const sessionId = await setup('studio'),
      peerId = await setup('quiet-job');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const peerDraft = 'Keep the unrelated Job draft during the other process failure.';
    await page.goto(front.origin + '/chat/' + peerId);
    await h.waitForPreparedConversation(peerId);
    await composer.fill(peerDraft);
    await expectPersistedChatDraft(page, peerId, peerDraft);
    const peerBefore = await api.read('quiet-job');
    const createdTaskResponse = await h.http('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Unresolved restart review control',
        description:
          'Pending task control; no execution or completion inferred from command admission.',
        annotations: ['synthetic-restart-control'],
      }),
    });
    expect(createdTaskResponse.status).toBe(201);
    const taskBefore = (await createdTaskResponse.json()).task;
    expect(taskBefore.status).toBe('pending');
    const requests: OrdinaryWorkspaceFirstCommand[] = [],
      committed: unknown[] = [];
    await page.route('**/api/ordinary/workspaces/commands/first', async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const actual = await route.fetch();
        committed.push(await actual.json());
        await route.abort('failed');
      } else await route.continue();
    });
    // Preserve the manual exact-replay branch when both delivery observations
    // lose their responses. The actual receipt owner still runs and proves no dispatch.
    const lostReceiptReads: Array<{ status: number; body: Record<string, unknown> }> = [];
    await page.route('**/api/ordinary/workspaces/commands/first/receipt', async (route) => {
      if (route.request().postDataJSON().clientMsgId !== requests[0]?.clientMsgId) {
        await route.continue();
        return;
      }
      const actual = await route.fetch();
      lostReceiptReads.push({ status: actual.status(), body: await actual.json() });
      await route.abort('failed');
    });
    await page.goto(front.origin + '/chat/' + sessionId);
    const prompt = 'Review the acoustic task; retain uncertainty until a result exists.';
    await h.waitForPreparedConversation(sessionId);
    await composer.fill(prompt);
    await Promise.all([
      page.waitForEvent('requestfailed', {
        predicate: (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/api/ordinary/workspaces/commands/first',
        timeout: 10000,
      }),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    await vi.waitFor(() => expect(committed).toHaveLength(1));
    const original = requests[0];
    expect(committed[0]).toMatchObject({
      sessionId,
      clientMsgId: original.clientMsgId,
      state: 'consumed',
      dispatched: true,
    });
    // Admission precedes the provider ACK; observe the real turn before continuing.
    await vi.waitFor(
      async () =>
        expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1),
      { timeout: 10_000 },
    );
    const outbox = () =>
      readChatStorage(page, (storage) =>
        Object.keys(storage)
          .filter((key) => key.startsWith('mitzo-local-first-command-outbox:'))
          .map((key) => JSON.parse(storage.getItem(key)!)),
      );
    // The durable read crosses the browser and IndexedDB; use the browser
    // assertion deadline rather than Vitest's one-second in-process poll.
    await browserExpect
      .poll(async () =>
        (await outbox()).find((entry) => entry.body?.clientMsgId === original.clientMsgId),
      )
      .toMatchObject({ uncertain: true, body: original });
    const laterDraft = 'Keep this newer draft while the original result remains unknown.';
    await composer.fill(laterDraft);
    const before = await h.snapshot(sessionId, original.clientMsgId),
      workBefore = await api.read('studio');
    expect(before.runtimeBinding).toEqual(prepared.runtimeBinding);
    expect(before.session.agentProfile).toEqual(f.agentProfile);
    const inode = (await stat(before.session.cwd!)).ino;
    expect(before.admission.state).toBe('consumed');
    expect(before.native.commands).toHaveLength(1);
    expect(before.native.commands[0]).toMatchObject({
      id: original.clientMsgId,
      status: 'running',
    });
    expect(before.workspace.id).toBe(before.session.ordinaryWorkspaceId);
    expect(before.tasks).toContainEqual(taskBefore);
    await record('real-admission-native-accepted-with-no-terminal-result', {
      original,
      committed,
      before,
      workBefore,
      peerBefore,
      peerId,
      taskBefore,
      inode,
      effects: await h.effects(),
      outbox: await outbox(),
      stableOrigin: front.origin,
    });
    await capture('before-crash-retained-command');
    await h.crash();
    expect(h.lifecycle.find((e) => e.event === 'exit')).toMatchObject({
      pid: h.initialReady.pid,
      signal: 'SIGKILL',
    });
    const restarted = await h.restart();
    expect(restarted.pid).not.toBe(h.initialReady.pid);
    expect(restarted.authId).toBe(f.auth.id);
    expect(restarted.statePaths).toEqual(h.initialReady.statePaths);
    expect(
      (await h.http('/api/todos')).status,
      'Actual canonical collection read after process recreation',
    ).toBe(200);
    const cold = await h.snapshot(sessionId, original.clientMsgId);
    expect(cold.runtimeBinding).toEqual(before.runtimeBinding);
    expect(cold.session.agentProfile).toEqual(before.session.agentProfile);
    expect(cold.activeSessionIds).toEqual([]);
    expect(cold.native.commands).toHaveLength(1);
    const { status: beforeStatus, ...beforeCommandIdentity } = before.native.commands[0];
    const { status: recoveredStatus, ...recoveredCommandIdentity } = cold.native.commands[0];
    expect(beforeStatus).toBe('running');
    expect(recoveredStatus).toBe('interrupted');
    expect(recoveredCommandIdentity).toEqual(beforeCommandIdentity);
    expect(cold.native.conversation.recovery).toBe(1);
    const reloadReads = observeTaskChatReads(page);
    const reloadBoundary = reloadReads.boundary();
    try {
      await page.reload();
      await reloadReads.waitForSessionMeta(sessionId, reloadBoundary);
    } finally {
      reloadReads.close();
    }
    await browserExpect(composer).toHaveValue(laterDraft);
    await browserExpect
      .poll(async () =>
        (await outbox()).find((entry) => entry.body?.clientMsgId === original.clientMsgId),
      )
      .toMatchObject({ uncertain: true, body: original });
    expect(requests).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    await capture('fresh-app-real-ui-retains-uncertainty');
    await record('receipt-read-response-loss-if-requested', { lostReceiptReads });
    const settings = page.getByRole('button', { name: /^Workspace controls/ });
    if ((await settings.getAttribute('aria-expanded')) === 'true') await settings.click();
    const recover = page.getByRole('button', {
      name: 'Retry',
      exact: true,
    });
    await browserExpect(recover).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      recover.click(),
    ]);
    const recovery = await response.json();
    await record('actual-retry-receipt-after-process-recreation', {
      status: response.status(),
      recovery,
      cold,
      restarted,
      lifecycle: h.lifecycle,
      effects: await h.effects(),
    });
    expect(requests).toEqual([original, original]);
    // The actual historical owner must prove acknowledgement. Retained refusal
    // is recorded honestly, never rewritten into a success or terminal result.
    expect([202, 409]).toContain(response.status());
    if (response.status() === 202) {
      expect(recovery).toMatchObject({
        sessionId,
        clientMsgId: original.clientMsgId,
        state: 'consumed',
        dispatched: false,
      });
      await browserExpect(recover).toHaveCount(0);
    } else {
      expect(recovery).toMatchObject({
        sessionId,
        clientMsgId: original.clientMsgId,
        code: 'retained_command',
      });
      expect(
        (await outbox()).find((entry) => entry.body?.clientMsgId === original.clientMsgId)
          ?.uncertain,
      ).toBe(true);
    }
    await capture('exact-ui-retry-retained-owner-proof');
    if ((await settings.getAttribute('aria-expanded')) === 'true') await settings.click();
    await browserExpect(composer).toHaveValue(laterDraft);
    const after = await h.snapshot(sessionId, original.clientMsgId);
    await record('read-only-native-owner-recovery-identities', { before, cold, after });
    for (const key of [
      'sessionId',
      'ordinaryWorkspaceId',
      'cwd',
      'accountBinding',
      'agentProfile',
    ] as const)
      expect(after.session[key]).toEqual(before.session[key]);
    expect(after.runtimeBinding).toEqual(before.runtimeBinding);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.preparation).toEqual(before.preparation);
    expect(after.admission).toEqual(before.admission);
    expect(after.native.commands).toEqual(cold.native.commands);
    expect(after.native.conversation.threadId).toBe(before.native.conversation.threadId);
    expect(after.tasks).toEqual(before.tasks);
    expect((await stat(after.session.cwd!)).ino).toBe(inode);
    expect(
      after.events.filter(
        (e) =>
          e.type === 'user_message' &&
          (e.payload as { messageId?: string }).messageId === original.clientMsgId,
      ),
    ).toHaveLength(1);
    expect(after.events.filter((e) => e.type === 'assistant_message')).toHaveLength(0);
    expect(await api.read('studio')).toEqual(workBefore);
    expect(await api.read('quiet-job')).toEqual(peerBefore);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    await navigateToChatMetadata(page, front.origin + '/chat/' + peerId, peerId);
    await browserExpect(composer).toHaveValue(peerDraft);
    await capture('unrelated-job-draft-after-real-process-restart');
    expect(h.pageErrors).toEqual([]);
    await record('complete-bounded-process-restart-journey', {
      after,
      before,
      peerBefore,
      peerAfter: await api.read('quiet-job'),
      recovery,
      lifecycle: h.lifecycle,
      effects: await h.effects(),
      pageErrors: h.pageErrors,
      limitations:
        'One local fake-native ordinary lead, retained lead allocation/current assignment and separate pending TaskBoard control. No delegated worker execution/result, real provider/native binary, index host lifecycle, production bundle, backup restore, fullUX/device/main/live acceptance.',
    });
  } finally {
    await h.close();
  }
}, 150_000);
