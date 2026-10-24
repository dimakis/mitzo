import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createTaskReviewProcessFixture,
  type NativeToolResult,
} from './task-review-process-fixture';
import {
  inspectTaskReadability,
  assertTaskReadability,
  tabToTaskControl,
} from './task-chat-tree-geometry';

it('retains readable real task review and the exact attempt-associated worker chat-tree row across restart and approval', async () => {
  const h = await createTaskReviewProcessFixture();
  const { page, front, api, ordinary, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  // This separately identified child case preserves the original f04 RED and
  // corrects only its unsupported unconditional NULL-legacy TaskBoard suffix.
  const chatTree: Array<Record<string, unknown>> = [];
  const browserReads: Array<Record<string, unknown>> = [];
  const browserWorkRequests: Array<{
    path: string;
    method: string;
    body: unknown;
    readOnlyOperation: boolean;
  }> = [];
  const pendingReads: Array<Promise<void>> = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== 'GET' &&
      (path.startsWith('/api/telos/work/') || path.startsWith('/api/tasks'))
    ) {
      const body = request.postDataJSON();
      // These actual host routes use POST for authenticated reads. Classify
      // only the exact known read operations, not every call to these paths.
      const readOnlyOperation =
        request.method() === 'POST' &&
        ((path === '/api/telos/work/links' &&
          body?.namespace === 'mitzo' &&
          typeof body?.conversationId === 'string') ||
          (path === '/api/telos/work/controls' && ['inbox', 'read'].includes(body?.operation)));
      browserWorkRequests.push({ path, method: request.method(), body, readOnlyOperation });
    }
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.request().method() === 'GET' &&
      (path === '/api/tasks' ||
        path.startsWith('/api/telos/work/') ||
        (path.startsWith('/api/sessions/') && path.endsWith('/meta')))
    )
      pendingReads.push(
        (async () => {
          try {
            browserReads.push({ path, status: response.status(), body: await response.json() });
          } catch (error) {
            browserReads.push({ path, status: response.status(), bodyReadError: String(error) });
          }
        })(),
      );
  });
  const toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    approvalShown: boolean;
    response: NativeToolResult;
  }> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'task-chat-tree-app-observations.json'),
        JSON.stringify(
          {
            observations,
            chatTree,
            browserReads,
            browserWorkRequests,
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
    await composer.fill(peerDraft);
    await page.goto(front.origin + '/chat/' + leadId);
    await composer.fill(leadDraft);
    await page.goto(front.origin + allocation.workerPath);
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
    const readability: Array<Awaited<ReturnType<typeof inspectTaskReadability>>> = [];
    const keyboard: Array<Record<string, unknown>> = [];
    const inspect = async (stage: string, widths: number[]) => {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        const result = await inspectTaskReadability(page, {
          taskId,
          title: pendingTask.title,
          summary,
          evidenceValue,
          workerId,
          legacySessionId: (await readTask()).sessionId,
          stage,
          width,
        });
        readability.push(result);
        await record('actual-task-readability-' + stage + '-' + width, { result });
        await capture('actual-task-readability-' + stage + '-' + width);
        assertTaskReadability(result);
        const link = page.locator('#task-' + taskId + ' > .task-node-row .task-node-session-link');
        if (result.sessionLinks.length) {
          const trace = await tabToTaskControl(page, link);
          await page.keyboard.press('Enter');
          await browserExpect(page).toHaveURL(front.origin + '/chat/' + result.legacySessionId);
          if (result.legacySessionId === workerId)
            await browserExpect(composer).toHaveValue(workerDraft);
          keyboard.push({
            stage,
            width,
            action: 'naturalTabEnterSessionLink',
            trace,
            actualDestination: page.url(),
          });
          await page.goBack();
          await browserExpect(page.locator('#task-' + taskId)).toBeVisible();
        } else {
          // NULL legacy identity legitimately has no optional TaskBoard suffix.
          // Record actual data; never manufacture a display association.
          const status = page.locator('#task-' + taskId + ' > .task-node-row .task-node-status');
          const trace = await tabToTaskControl(page, status);
          keyboard.push({
            stage,
            width,
            action: 'naturalTabStatusOnlyOptionalLegacyLinkAbsent',
            trace,
            actualTaskSessionId: (await readTask()).sessionId,
            durableExecutionBinding: beforeCrash.executionBindings,
          });
        }
      }
    };
    const inspectChatTree = async (stage: string, expectedStatus: 'pending_review' | 'done') => {
      const effectsBefore = await h.effects();
      const workBeforeTree = await api.read('recording-slice');
      const taskBeforeTree = await readTask();
      expect(taskBeforeTree.status).toBe(expectedStatus);
      const exactAttempts = workBeforeTree.attempts.filter(
        (attempt) =>
          attempt.childItemId === 'recording-slice' &&
          attempt.workerConversationId === workerId &&
          attempt.executionTaskId === taskId &&
          attempt.attemptId === allocation.attempt.attemptId,
      );
      expect(exactAttempts).toHaveLength(1);
      const snapshotBeforeTree = await h.snapshot(workerId, command.clientMsgId);
      expect(snapshotBeforeTree.executionBindings).toEqual(beforeCrash.executionBindings);
      const links = await api.links({ namespace: 'mitzo', conversationId: workerId });
      expect(
        links.some(
          (link) =>
            link.itemId === 'recording-slice' &&
            link.conversation.namespace === 'mitzo' &&
            link.conversation.conversationId === workerId,
        ),
      ).toBe(true);
      const readStart = browserReads.length,
        writeStart = browserWorkRequests.length;
      await page.goto(front.origin + allocation.workerPath);
      const toggle = page.getByRole('button', { name: 'Toggle work tree', exact: true });
      const region = page.getByRole('region', { name: 'Work tree', exact: true });
      await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
      await browserExpect(region).not.toBeVisible();
      await browserExpect(composer).toHaveValue(workerDraft);
      const toggleTrace = await tabToTaskControl(page, toggle);
      await page.keyboard.press('Enter');
      await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
      await browserExpect(region).toBeVisible();
      // Real browser GET /api/tasks completes before judging this consumer.
      // Poll only retained response observations; never seed frontend/store state.
      await vi.waitFor(
        async () => {
          await Promise.all(pendingReads);
          expect(
            browserReads
              .slice(readStart)
              .some(
                (read) =>
                  read.path === '/api/tasks' &&
                  read.status === 200 &&
                  JSON.stringify(read.body).includes(taskId),
              ),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
      const expectedText =
        (expectedStatus === 'pending_review' ? 'Awaiting review' : 'Task done') +
        ' · ' +
        taskBeforeTree.title;
      const rows = region.locator('.telos-chat-execution');
      // A soft failing row check retains RED while the same real review flow finishes.
      let rowWaitFailure: string | null = null;
      try {
        await browserExpect(rows).toHaveText([expectedText], { timeout: 3_000 });
      } catch (error) {
        rowWaitFailure = String(error);
      }
      const actualRows = (await rows.allTextContents()).map((text) =>
        text.replace(/\s+/g, ' ').trim(),
      );
      const observation = {
        stage,
        expectedStatus,
        expectedText,
        actualRows,
        rowWaitFailure,
        allocation,
        exactAttempts,
        actualTask: taskBeforeTree,
        executionBindings: snapshotBeforeTree.executionBindings,
        links,
        actualWorkerPath: allocation.workerPath,
        actualRoute: page.url(),
        initiallyCollapsed: true,
        toggleTrace,
        regionText: await region.innerText(),
        browserReads: browserReads.slice(readStart),
        browserWorkRequests: browserWorkRequests.slice(writeStart),
      };
      chatTree.push(observation);
      await record('actual-worker-chat-tree-' + stage, { observation });
      await capture('actual-worker-chat-tree-' + stage);
      expect
        .soft(actualRows, stage + ': exact attempt-associated task row in worker chat tree')
        .toEqual([expectedText]);
      // Reach the existing close control by normal keyboard navigation.
      const close = page.getByRole('button', { name: 'Close work tree', exact: true });
      const closeTrace = await tabToTaskControl(page, close);
      await page.keyboard.press('Enter');
      await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
      await browserExpect(region).not.toBeVisible();
      await browserExpect(toggle).toBeFocused();
      await browserExpect(composer).toHaveValue(workerDraft);
      expect(
        browserWorkRequests.slice(writeStart).filter((request) => !request.readOnlyOperation),
      ).toEqual([]);
      expect(await api.read('recording-slice')).toEqual(workBeforeTree);
      expect(await readTask()).toEqual(taskBeforeTree);
      const snapshotAfterTree = await h.snapshot(workerId, command.clientMsgId);
      expect(snapshotAfterTree.allSessionIdentities).toEqual(
        snapshotBeforeTree.allSessionIdentities,
      );
      expect(snapshotAfterTree.executionBindings).toEqual(snapshotBeforeTree.executionBindings);
      expect(snapshotAfterTree.native.commands).toEqual(snapshotBeforeTree.native.commands);
      expect(await h.effects()).toEqual(effectsBefore);
      await record('actual-worker-chat-tree-closed-' + stage, {
        closeTrace,
        focusReturned: true,
        draftRetained: true,
        noWorkOrTaskMutation: true,
        noExtraAllocationAssignmentOrNativeLaunch: true,
        snapshotBeforeTree,
        snapshotAfterTree,
        effectsBefore,
      });
      await capture('actual-worker-chat-tree-closed-' + stage);
      await page.goto(front.origin + '/tasks?highlight=' + taskId);
    };
    await page.goto(front.origin + '/tasks?highlight=' + taskId);
    await browserExpect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await inspect('pending-before-restart', [320, 390]);
    await inspectChatTree('pending-before-restart', 'pending_review');
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
    await inspectChatTree('pending-after-restart', 'pending_review');
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
    const approve = page.getByRole('button', { name: 'Approve', exact: true });
    const approvalTrace = await tabToTaskControl(page, approve);
    keyboard.push({
      stage: 'pending-after-restart',
      width: 390,
      action: 'naturalTabEnterApprove',
      trace: approvalTrace,
    });
    const [approval] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith('/api/tasks/' + taskId + '/approve'),
      ),
      page.keyboard.press('Enter'),
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
    await inspect('done-after-explicit-approval', [320, 390]);
    await inspectChatTree('done-after-explicit-approval', 'done');
    await capture('explicit-task-done-outcome-still-unverified');
    await page.goto(front.origin + '/chat/' + leadId);
    await browserExpect(composer).toHaveValue(leadDraft);
    await page.goto(front.origin + '/chat/' + peerId);
    await browserExpect(composer).toHaveValue(peerDraft);
    await page.goto(front.origin + '/chat/' + workerId);
    await browserExpect(composer).toHaveValue(workerDraft);
    const effects = await h.effects();
    expect(effects.filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'thread/start')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'provider.tool.request')).toHaveLength(5);
    expect(effects.filter((e) => e.kind === 'provider.tool.result')).toHaveLength(5);
    expect(h.pageErrors).toEqual([]);
    await record('complete-actual-app-task-chat-tree-review-journey', {
      readability,
      keyboard,
      chatTree,
      browserReads,
      browserWorkRequests,
      approvalStatus: approval.status(),
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
        'Same frozen8b3 actualnative Write/TaskArtifact/TaskComplete/pendingreview/restart/operatorApprove owners. Added read-only actualDOM text/range/scroll/control geometry at320/390 pending+done, natural Tab to status, optional exact legacy-session navigation only if present, Tab/Enter taskapproval. Added actual worker chat/initially collapsed work tree/exact attempt-task row/close focus/draft/isolation observations. Original f04 assertion disagreement explicitly scoped by root disposition; no old result rewritten. Rawreport/evidence opaque bytes unchanged; no parsing/render/data/JSX/callback/backend invention. Actual provider tools simulated only at externalboundary; all permissions/nativehost/MCPstdio/task/file/state/HTTP real. No providerterminal or fabricatedownedreceipt. WorkingfileTaskArtifact isnotcanonicalartifactrevision and taskdone isnotcanonicaloutcomecompletion. NarrowChromium privatecomposition only; no11profile campaign/main/device/theme/accessibility/fullUX24/live claim.',
    });
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
