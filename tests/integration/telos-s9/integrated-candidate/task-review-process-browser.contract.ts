import { navigateToChatMetadata } from './task-chat-read-observer';
import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createTaskReviewProcessFixture,
  type NativeToolResult,
} from './task-review-process-fixture';

it('retains actual native task-tool evidence and pending review across App process death, then explicitly approves only the task', async () => {
  const h = await createTaskReviewProcessFixture();
  const { page, front, api, ordinary, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    approvalShown: boolean;
    response: NativeToolResult;
  }> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'task-review-process-observations.json'),
        JSON.stringify(
          {
            observations,
            toolCalls,
            pageErrors: h.pageErrors,
            realModelProviderCalls: 0,
            simulatedProviderTerminalEvents: 0,
          },
          null,
          2,
        ),
      );
  };
  const record = async (stage: string, detail: Record<string, unknown>) => {
    observations.push({ stage, ...detail });
    await save();
  };
  const capture = async (name: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, name + '.png'),
        fullPage: true,
      });
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const pending = h.nativeTool(name, args);
    const allow = page.getByRole('button', { name: 'Allow Once', exact: true });
    const first = await Promise.race([
      pending.then((response) => ({ kind: 'result' as const, response })),
      allow
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => ({ kind: 'approval' as const })),
    ]);
    const approvalShown = first.kind === 'approval';
    if (name === 'Write' && args.require_approval === true) expect(approvalShown).toBe(true);
    if (approvalShown) {
      await capture('native-permission-' + name.replace(/[^a-zA-Z0-9]/g, '-'));
      await allow.click();
    }
    const response = first.kind === 'result' ? first.response : await pending;
    toolCalls.push({ name, args, approvalShown, response });
    await save();
    expect(response.result.success, JSON.stringify(response)).toBe(true);
    const text = response.result.contentItems.map((item) => item.text ?? '').join('\n');
    expect(text).not.toMatch(
      /Error:|Tool failed or was interrupted|Previously attempted tool call/,
    );
    return { response, text };
  };
  try {
    expect((await h.http('/api/todos')).status).toBe(200);
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
    const settings = {
      version: 2 as const,
      binding: prepared.runtimeBinding,
      selection: f.first.request.selection,
      workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
    };
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
      const result = await api.setupReviewedOrdinaryRole({
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
          settings,
        },
      });
      return result.work.assignments[0].conversation.conversationId;
    };
    const leadId = await setup('studio'),
      peerId = await setup('quiet-job');
    await api.execute({
      operation: 'classify',
      itemId: 'recording-slice',
      kind: 'work_item',
      requestId: randomUUID(),
      expectedRevision: (await api.read('recording-slice')).revision,
    });
    const workerReview = await api.reviewRoleContext({
      itemId: 'recording-slice',
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const allocation = await api.delegateOrdinarySlice({
      version: 2,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: 'recording-slice',
      leadConversationId: leadId,
      expectedRevision: workerReview.selection.brief.revision,
      mode: 'start',
      predecessorAttemptId: null,
      settings,
      contextSelection: workerReview.selection,
    });
    const workerId = allocation.workerConversationId,
      taskId = allocation.attempt.executionTaskId!;
    const readTask = async () => {
      const response = await h.http('/api/tasks/' + taskId);
      expect(response.status).toBe(200);
      return (await response.json()).task;
    };
    const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
    const peerDraft = 'Keep this unrelated draft while the worker task is reviewed.';
    const leadDraft = 'Task approval is separate from verifying the outcome.';
    const workerDraft = 'Keep the worker follow-up draft; do not rerun the completed task tools.';
    await page.goto(front.origin + '/chat/' + peerId);
    await h.waitForPreparedConversation(peerId);
    await composer.fill(peerDraft);
    await page.goto(front.origin + '/chat/' + leadId);
    await h.waitForPreparedConversation(leadId);
    await composer.fill(leadDraft);
    await page.goto(front.origin + allocation.workerPath);
    await h.waitForPreparedConversation(workerId);
    await composer.fill(
      'Produce the deterministic recording report through the exposed native tools and submit it for task review.',
    );
    const [first] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    const command = first.request().postDataJSON();
    const firstReceipt = await first.json();
    expect(first.status()).toBe(202);
    expect(firstReceipt).toMatchObject({
      sessionId: workerId,
      clientMsgId: command.clientMsgId,
      state: 'consumed',
      dispatched: true,
    });
    // Admission precedes the provider ACK; observe the real turn before continuing.
    await vi.waitFor(
      async () =>
        expect((await h.effects()).filter((e) => e.kind === 'turn/start')).toHaveLength(1),
      { timeout: 10_000 },
    );
    await composer.fill(workerDraft);
    const allocated = await h.snapshot(workerId, command.clientMsgId),
      workBefore = await api.read('recording-slice'),
      peerBefore = await api.read('quiet-job');
    expect(allocated.session.agentProfile?.definition.tools).toEqual(
      f.agentProfile.definition.tools,
    );
    expect(allocated.executionBindings[0]).toMatchObject({
      taskId,
      binding: {
        attemptId: allocation.attempt.attemptId,
        workerConversationId: workerId,
        leadConversationId: leadId,
      },
    });
    const initialStatus = await tool('mcp__task-board__TaskStatus', {});
    expect(initialStatus.text).toContain('[pending]');
    const reportText =
      '# Recording result\n\nSynthetic acoustic sample checked against the reviewed child criteria. Retain this report for explicit task review.\n';
    const filename = 'recording-review-report.md',
      filePath = join(allocated.session.cwd!, filename);
    await tool('Write', { file_path: filePath, content: reportText, require_approval: true });
    const fileReadPath =
      '/api/files/read?' + new URLSearchParams({ sessionId: workerId, path: filePath });
    const fileResponse = await h.http(fileReadPath);
    const fileBefore = await fileResponse.json();
    await record('actual-native-output-file-response', {
      status: fileResponse.status,
      fileBefore,
      filePath,
    });
    expect(fileResponse.status).toBe(200);
    expect(fileBefore.content).toBe(reportText);
    const fileHash = createHash('sha256').update(fileBefore.content).digest('hex');
    const evidenceValue = JSON.stringify({
      kind: 'worker-working-file',
      path: filePath,
      sha256: fileHash,
      sessionId: workerId,
      taskId,
    });
    const artifactResult = await tool('mcp__task-board__TaskArtifact', {
      key: 'report',
      value: evidenceValue,
    });
    expect(artifactResult.text).toContain('Artifact stored: report');
    const summary =
      'Synthetic recording report submitted with attributed working-file evidence; task review remains explicit and the outcome is unverified.';
    const completeResult = await tool('mcp__task-board__TaskComplete', { summary });
    expect(completeResult.text).toContain('pending_review');
    const reviewStatus = await tool('mcp__task-board__TaskStatus', {});
    expect(reviewStatus.text).toContain('[pending_review]');
    const pendingTask = await readTask();
    expect(pendingTask).toMatchObject({
      id: taskId,
      status: 'pending_review',
      summary,
      completedAt: null,
      artifacts: { report: evidenceValue },
    });
    await vi.waitFor(async () => {
      const snapshot = await h.snapshot(workerId, command.clientMsgId);
      // Discovery results are durable too. Match original effects through their
      // actual public tool IDs; also require the complete sequence and all results.
      const allResults = snapshot.events.filter((e) => e.type === 'tool_result');
      const calls = snapshot.events
        .filter((e) => e.type === 'block_end' && e.payload.blockType === 'tool_use')
        .map((e) => e.payload);
      expect(calls.map((call) => call.toolName)).toEqual(
        toolCalls.flatMap(({ name }) =>
          name.startsWith('mcp__')
            ? ['ListIntegrationTools', 'DescribeIntegrationTool', name]
            : [name],
        ),
      );
      const originalIds = new Set(
        calls
          .filter((call) => toolCalls.some(({ name }) => name === call.toolName))
          .map((call) => call.toolId),
      );
      const results = allResults.filter((e) => originalIds.has(e.payload.toolId));
      expect(allResults).toHaveLength(13);
      expect(allResults.every((e) => e.payload.isError === false)).toBe(true);
      expect(results).toHaveLength(5);
      expect(results.every((e) => (e.payload as { isError?: boolean }).isError === false)).toBe(
        true,
      );
    });
    const beforeCrash = await h.snapshot(workerId, command.clientMsgId);
    expect(beforeCrash.native.commands[0].status).toBe('running');
    expect(beforeCrash.native.conversation.lastCompletedTurnId).toBeNull();
    await record('actual-task-tools-produced-durable-pending-review-before-crash', {
      allocation,
      command,
      firstReceipt,
      beforeCrash,
      pendingTask,
      reportText,
      filePath,
      fileHash,
      evidenceValue,
      summary,
      effects: await h.effects(),
      workBefore,
    });
    await page.goto(front.origin + '/tasks?highlight=' + taskId);
    await browserExpect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await capture('real-pending-review-before-process-crash');
    await h.crash();
    const restarted = await h.restart();
    expect(restarted.pid).not.toBe(h.initialReady.pid);
    expect(restarted.statePaths).toEqual(h.initialReady.statePaths);
    expect(restarted.authId).toBe(f.auth.id);
    await page.reload();
    await browserExpect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    const afterRestartTask = await readTask();
    expect(afterRestartTask).toEqual(pendingTask);
    const cold = await h.snapshot(workerId, command.clientMsgId);
    expect(cold.native.commands[0]).toMatchObject({
      id: command.clientMsgId,
      status: 'interrupted',
      attempt: beforeCrash.native.commands[0].attempt,
    });
    expect(cold.native.conversation.threadId).toBe(beforeCrash.native.conversation.threadId);
    expect(cold.native.conversation.lastCompletedTurnId).toBeNull();
    expect(cold.executionBindings).toEqual(beforeCrash.executionBindings);
    expect(cold.workspace).toEqual(beforeCrash.workspace);
    expect(cold.preparation).toEqual(beforeCrash.preparation);
    expect(cold.events.filter((e) => e.type === 'tool_result')).toEqual(
      beforeCrash.events.filter((e) => e.type === 'tool_result'),
    );
    const coldFileResponse = await h.http(fileReadPath),
      coldFile = await coldFileResponse.json();
    await record('actual-cold-pending-review-evidence-file-readback', {
      afterRestartTask,
      cold,
      fileStatus: coldFileResponse.status,
      coldFile,
      lifecycle: h.lifecycle,
      effects: await h.effects(),
    });
    expect(coldFileResponse.status).toBe(200);
    expect(coldFile.content).toBe(reportText);
    expect(createHash('sha256').update(coldFile.content).digest('hex')).toBe(fileHash);
    await capture('pending-review-retained-after-real-process-restart');
    await page.goto(
      front.origin +
        '/files?' +
        new URLSearchParams({
          sessionId: workerId,
          path: filePath,
          from: '/tasks?highlight=' + taskId,
        }),
    );
    await browserExpect(page.locator('.viewer-content')).toContainText(
      'Synthetic acoustic sample checked',
    );
    await capture('actual-worker-file-evidence-after-restart');
    await page.goto(front.origin + '/tasks?highlight=' + taskId);
    const [approval] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith('/api/tasks/' + taskId + '/approve'),
      ),
      page.getByRole('button', { name: 'Approve', exact: true }).click(),
    ]);
    expect(approval.status()).toBe(200);
    expect(await approval.json()).toEqual({ ok: true });
    const doneTask = await readTask();
    expect(doneTask).toMatchObject({
      id: taskId,
      status: 'done',
      summary,
      artifacts: { report: evidenceValue },
    });
    expect(doneTask.completedAt).not.toBeNull();
    expect((await api.readRecord('recording-slice')).status).toBe('active');
    expect((await api.readRecord('studio')).status).toBe('active');
    expect(await api.read('recording-slice')).toEqual(workBefore);
    expect(await api.read('quiet-job')).toEqual(peerBefore);
    const afterApproval = await h.snapshot(workerId, command.clientMsgId);
    expect(afterApproval.executionBindings).toEqual(beforeCrash.executionBindings);
    expect(afterApproval.native.commands).toEqual(cold.native.commands);
    expect(afterApproval.native.conversation.lastCompletedTurnId).toBeNull();
    await capture('explicit-task-done-outcome-still-unverified');
    await navigateToChatMetadata(page, front.origin + '/chat/' + leadId, leadId);
    await browserExpect(composer).toHaveValue(leadDraft);
    await navigateToChatMetadata(page, front.origin + '/chat/' + peerId, peerId);
    await browserExpect(composer).toHaveValue(peerDraft);
    await navigateToChatMetadata(page, front.origin + '/chat/' + workerId, workerId);
    await browserExpect(composer).toHaveValue(workerDraft);
    const effects = await h.effects();
    expect(effects.filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'thread/start')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'provider.tool.request')).toHaveLength(5);
    expect(effects.filter((e) => e.kind === 'provider.tool.result')).toHaveLength(5);
    expect(h.pageErrors).toEqual([]);
    await record('complete-native-task-evidence-review-restart-journey', {
      allocation,
      command,
      firstReceipt,
      beforeCrash,
      cold,
      afterApproval,
      pendingTask,
      afterRestartTask,
      doneTask,
      reportText,
      filePath,
      fileHash,
      evidenceValue,
      summary,
      toolCalls,
      effects,
      lifecycle: h.lifecycle,
      workBefore,
      workAfter: await api.read('recording-slice'),
      canonicalChildAfter: await api.readRecord('recording-slice'),
      canonicalParentAfter: await api.readRecord('studio'),
      peerBefore,
      peerAfter: await api.read('quiet-job'),
      limitations:
        'Native/provider inputs and tool requests are deterministic fakes at the external RPC boundary; all host tool results/state/HTTP/permission/stdio/file effects are real. No simulated provider terminal input or owned terminal write. Working file + task evidence is not canonical retained-artifact revision. One explicit task approval does not verify canonical outcome, real provider completion, merge/deployment, fullUX/main/device/live.',
    });
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
