import type {
  TelosOrdinaryWorkDelegationInput,
  OrdinaryWorkspaceFirstCommand,
} from '@mitzo/protocol';
import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openChatSetting } from '../../../support/chat-settings';
import { createWorkerRestartFixture } from './worker-process-restart-fixture';

it('recovers the original delegated worker, bound execution task, attempt and admitted native command after actual App process death without replacement inference', async () => {
  const h = await createWorkerRestartFixture();
  const { page, front, api, ordinary, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const record = async (stage: string, detail: Record<string, unknown>) => {
    observations.push({ stage, ...detail });
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'worker-process-restart-observations.json'),
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
    const leadId = await setup('studio'),
      peerId = await setup('quiet-job');
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const peerDraft = 'Keep the unrelated Job draft during the other process failure.';
    await page.goto(front.origin + '/chat/' + peerId);
    await composer.fill(peerDraft);
    const peerBefore = await api.read('quiet-job');
    await api.execute({
      operation: 'classify',
      itemId: 'recording-slice',
      kind: 'work_item',
      requestId: randomUUID(),
      expectedRevision: (await api.read('recording-slice')).revision,
    });
    await page.goto(front.origin + '/chat/' + leadId);
    const leadDraft = 'Keep the lead planning draft; delegate only this reviewed child.';
    await composer.fill(leadDraft);
    const workerReview = await api.reviewRoleContext({
      itemId: 'recording-slice',
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const allocationInput: TelosOrdinaryWorkDelegationInput = {
      version: 2,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: 'recording-slice',
      leadConversationId: leadId,
      expectedRevision: workerReview.selection.brief.revision,
      mode: 'start',
      predecessorAttemptId: null,
      settings: {
        version: 2,
        binding: prepared.runtimeBinding,
        selection: f.first.request.selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
      contextSelection: workerReview.selection,
    };
    const allocation = await api.delegateOrdinarySlice(allocationInput);
    expect(allocation.execution).toBe('not_started');
    expect(allocation.attempt.state).toBe('chat_ready');
    await browserExpect(page).toHaveURL(front.origin + '/chat/' + leadId);
    await browserExpect(composer).toHaveValue(leadDraft);
    expect((await h.effects()).filter((effect) => effect.kind === 'native.launch')).toHaveLength(0);
    const sessionId = allocation.workerConversationId,
      taskId = allocation.attempt.executionTaskId!;
    expect(new Set([leadId, peerId, sessionId]).size).toBe(3);
    const taskRead = await h.http('/api/tasks/' + taskId);
    expect(taskRead.status).toBe(200);
    const taskBefore = (await taskRead.json()).task;
    expect(taskBefore.id).toBe(taskId);
    expect(taskBefore.status).toBe('pending');
    await record('real-canonical-delegation-and-bound-task-before-execution', {
      allocationInput,
      allocation,
      taskBefore,
      leadId,
      peerId,
      leadDraft,
      peerDraft,
      effects: await h.effects(),
    });
    await capture('lead-remains-after-real-child-allocation');
    const requests: OrdinaryWorkspaceFirstCommand[] = [],
      committed: unknown[] = [];
    const committedStatuses: number[] = [];
    await page.route('**/api/ordinary/workspaces/commands/first', async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) {
        const actual = await route.fetch();
        committed.push(await actual.json());
        committedStatuses.push(actual.status());
        await route.abort('failed');
      } else await route.continue();
    });
    await page.goto(front.origin + '/chat/' + sessionId);
    const prompt =
      'Perform only the reviewed recording slice; retain uncertainty until a result exists.';
    await composer.fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await vi.waitFor(() => expect(committed).toHaveLength(1));
    const original = requests[0];
    await record('actual-worker-first-command-response', {
      original,
      committed,
      committedStatuses,
      effects: await h.effects(),
    });
    expect(committedStatuses).toEqual([202]);
    expect(committed[0]).toMatchObject({
      sessionId,
      clientMsgId: original.clientMsgId,
      state: 'consumed',
      dispatched: true,
    });
    await vi.waitFor(async () =>
      expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1),
    );
    const outbox = () =>
      page.evaluate(() =>
        Object.keys(localStorage)
          .filter((key) => key.startsWith('mitzo-local-first-command-outbox:'))
          .map((key) => JSON.parse(localStorage.getItem(key)!)),
      );
    await vi.waitFor(async () =>
      expect(
        (await outbox()).find((entry) => entry.body?.clientMsgId === original.clientMsgId),
      ).toMatchObject({ uncertain: true, body: original }),
    );
    const laterDraft = 'Keep this newer draft while the original result remains unknown.';
    await composer.fill(laterDraft);
    const before = await h.snapshot(sessionId, original.clientMsgId),
      workBefore = await api.read('recording-slice');
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
    expect(before.tasks).toHaveLength(1);
    expect(before.tasks[0].id).toBe(taskId);
    expect(['done', 'pending_review']).not.toContain(before.tasks[0].status);
    expect(before.preparation?.allocationOperationId).toBe(allocation.attempt.allocationReceiptId);
    expect(before.preparation?.delegationAttemptId).toBe(allocation.attempt.attemptId);
    expect(before.executionBindings).toEqual([
      {
        taskId,
        binding: expect.objectContaining({
          attemptId: allocation.attempt.attemptId,
          childItemId: 'recording-slice',
          leadConversationId: leadId,
          workerConversationId: sessionId,
          contextSnapshotId: allocation.attempt.contextSnapshotId,
        }),
      },
    ]);
    expect(before.roleContext).toMatchObject({
      itemId: 'recording-slice',
      role: 'worker',
      leadConversationId: leadId,
    });
    await record('real-admission-native-accepted-with-no-terminal-result', {
      original,
      committed,
      before,
      workBefore,
      peerBefore,
      peerId,
      taskBefore,
      allocation,
      allocationInput,
      leadId,
      taskId,
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
    await page.reload();
    await browserExpect(composer).toHaveValue(laterDraft);
    await vi.waitFor(async () =>
      expect(
        (await outbox()).find((entry) => entry.body?.clientMsgId === original.clientMsgId),
      ).toMatchObject({ uncertain: true, body: original }),
    );
    expect(requests).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    await capture('fresh-app-real-ui-retains-uncertainty');
    await openChatSetting(page, 'more');
    const recover = page.getByRole('button', {
      name: 'Recover original Local command',
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
      await browserExpect(recover).toBeDisabled();
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
    await page.getByRole('button', { name: /^Workspace controls/ }).click();
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
    expect(await api.read('recording-slice')).toEqual(workBefore);
    expect(after.executionBindings).toEqual(before.executionBindings);
    expect(after.roleContext).toEqual(before.roleContext);
    expect(after.allSessionIdentities).toEqual(before.allSessionIdentities);
    // Replay the original allocation request through its real canonical owner;
    // this must retain the original worker/task/attempt rather than provision a replacement.
    const allocationReplayResponse = await h.http('/api/telos/work/delegation/ordinary/start', {
      method: 'POST',
      body: JSON.stringify(allocationInput),
    });
    const allocationReplay = await allocationReplayResponse.json();
    await record('real-delegation-replay-after-worker-process-recovery', {
      status: allocationReplayResponse.status,
      allocationReplay,
      allocation,
      allocationInput,
      after,
    });
    expect(allocationReplayResponse.status).toBe(200);
    expect(allocationReplay).toEqual(allocation);
    const afterAllocationReplay = await h.snapshot(sessionId, original.clientMsgId);
    expect(afterAllocationReplay.workspace).toEqual(before.workspace);
    expect(afterAllocationReplay.preparation).toEqual(before.preparation);
    expect(afterAllocationReplay.executionBindings).toEqual(before.executionBindings);
    expect(afterAllocationReplay.allSessionIdentities).toEqual(before.allSessionIdentities);
    expect(afterAllocationReplay.tasks).toEqual(before.tasks);
    expect(afterAllocationReplay.native.commands).toEqual(cold.native.commands);
    expect(await api.read('recording-slice')).toEqual(workBefore);
    expect(await api.read('quiet-job')).toEqual(peerBefore);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    await page.goto(front.origin + '/tasks?highlight=' + taskId);
    await browserExpect(page.getByText(taskBefore.title, { exact: true }).first()).toBeVisible();
    await capture('actual-delegated-task-progress-after-recovery');
    await page.goto(front.origin + '/chat/' + leadId);
    await browserExpect(composer).toHaveValue(leadDraft);
    await page.goto(front.origin + '/chat/' + peerId);
    await browserExpect(composer).toHaveValue(peerDraft);
    await capture('unrelated-job-draft-after-real-process-restart');
    expect(h.pageErrors).toEqual([]);
    await record('complete-delegated-worker-process-restart-journey', {
      after,
      before,
      allocation,
      allocationReplay,
      allocationInput,
      taskId,
      leadId,
      peerBefore,
      peerAfter: await api.read('quiet-job'),
      recovery,
      lifecycle: h.lifecycle,
      effects: await h.effects(),
      pageErrors: h.pageErrors,
      limitations:
        'One real canonical delegated-worker allocation and bound execution TaskBoard task, actual first native command accepted then process crash before result. No TaskComplete/terminal/provider success was fabricated. Running unrelated native peer, result production/verification, backup/revocation/repository loss, real provider/native binary, index lifecycle, bundle/main/device/fullUX/live remain pending.',
    });
  } finally {
    await h.close();
  }
}, 150_000);
