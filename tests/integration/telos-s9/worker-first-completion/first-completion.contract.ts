import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { expect as browserExpect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from '../integrated-candidate/joined-ordinary-application';
import { prepareNativeProviderToolCall } from '../../../../server/__tests__/fixtures/native-provider-tool-call';
import { artifactDefinition, initializeFirstCompletionFixtures } from './initial-fixtures';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const completeName = 'mcp__task-board__TaskComplete';

it('CT11 FIRST completion from an eligible started worker is refused after explicit retry replacement; current replacement can complete its own task', async () => {
  const h = await createJoinedOrdinaryApplication(
    { viewport: { width: 1280, height: 900 } },
    initializeFirstCompletionFixtures,
  );
  const { api, ordinary, f, page, front, application, chat, connections } = h;
  const evidence = process.env.S9_JOINED_SCREENSHOT_DIR;
  if (!evidence) throw Error('A fresh evidence directory is required');
  const records: Array<{ stage: string; facts: unknown }> = [];
  const requests: Array<{ sessionId: string; name: string; request: unknown }> = [];
  const record = async (stage: string, facts: unknown) => {
    records.push({ stage, facts });
    await writeFile(join(evidence, 'first-completion.json'), JSON.stringify(records, null, 2));
  };
  const capture = async (name: string) => {
    await page.screenshot({ path: join(evidence, name + '.png'), fullPage: true });
    await writeFile(join(evidence, name + '.ax.txt'), await page.locator('body').ariaSnapshot());
  };
  const { TaskOrchestrator } = await import('../../../../server/task-orchestrator.js');
  application.setOrchestrator(
    new TaskOrchestrator({
      store: application.taskStore,
      getClientId: () => {
        throw Error('Legacy scheduler must not select a worker');
      },
      setTaskContext: () => {
        throw Error('Legacy scheduler must not supply task authority');
      },
      clearTaskContext: () => {},
      broadcastStatus: (status) => connections.broadcastAll({ type: 'loop_status', ...status }),
      broadcastTasks: () => {
        const event = { type: 'task_state' as const, tasks: application.taskStore.getTree() };
        connections.broadcastAll(event);
        application.sseRegistry.broadcast('task_state', event);
      },
    }),
  );
  const artifactAgent = f.library.version('user', 's9-artifact-worker', 1)!;
  expect(artifactAgent.definition).toEqual(artifactDefinition);
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
  const workerSettings = {
    version: 2 as const,
    binding: prepared.runtimeBinding,
    selection: {
      ...f.first.request.selection,
      agent: { profileId: artifactAgent.profileId, revision: artifactAgent.revision },
    },
    workspace: { kind: 'ordinary' as const, preparationId: prepared.preparationId },
  };
  const leadSettings = { ...workerSettings, selection: f.first.request.selection };
  for (const [itemId, kind] of [
    ['studio', 'outcome'],
    ['recording-slice', 'work_item'],
  ] as const)
    await api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
  const leadReview = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const leadReceipt = await api.setupReviewedOrdinaryRole({
    version: 2,
    presentationRef: leadReview.presentationRef,
    input: {
      version: 2,
      requestId: randomUUID(),
      itemId: 'studio',
      role: 'lead',
      expectedRevision: leadReview.selection.brief.revision,
      expectedAssignmentRevision: 0,
      contextSelection: leadReview.selection,
      settings: leadSettings,
    },
  });
  const leadId = leadReceipt.work.assignments[0].conversation.conversationId;
  const parentBefore = await api.readRecord('studio');
  const allocate = async (predecessorAttemptId: string | null) => {
    const review = await api.reviewRoleContext({
      itemId: 'recording-slice',
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const input = {
      version: 2 as const,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: 'recording-slice',
      leadConversationId: leadId,
      expectedRevision: review.selection.brief.revision,
      mode: predecessorAttemptId === null ? ('start' as const) : ('retry' as const),
      predecessorAttemptId,
      settings: workerSettings,
      contextSelection: review.selection,
    };
    const receipt = await api.delegateOrdinarySlice(input);
    expect(await api.delegateOrdinarySlice(input)).toEqual(receipt);
    expect(receipt.execution).toBe('not_started');
    expect(receipt.attempt.executionTaskId).toBeTruthy();
    await record('real-reviewed-operator-allocation', {
      input,
      receipt,
      attribution: 'Operator before allocation; not native TelosStartSlice evidence',
    });
    return receipt;
  };
  const { getCodexConversationStore } = await import('../../../../server/codex-chat-session.js');
  const nativeStore = getCodexConversationStore();
  const { resolveTelosWorkRoleContext } =
    await import('../../../../server/telos-work-role-context.js');
  const start = async (sessionId: string, taskId: string) => {
    await page.goto(front.origin + '/chat/' + sessionId);
    await page
      .getByRole('textbox', { name: 'Message Mitzo', exact: true })
      .fill('Perform only this exact reviewed task and retain an attributed report.');
    const [first] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(first.status()).toBe(202);
    expect(await first.json()).toMatchObject({ state: 'consumed', dispatched: true, sessionId });
    const commandId = first.request().postDataJSON().clientMsgId as string;
    const meta = chat.eventStore.getSession(sessionId)!;
    expect(meta.agentProfile).toEqual(artifactAgent);
    const conversation = nativeStore.read(sessionId, meta.accountBinding!);
    const matching = h.nativeSessions.filter((actor) => actor.threadId === conversation.threadId);
    expect(matching).toHaveLength(1);
    const actor = matching[0];
    await vi.waitFor(() =>
      expect(
        actor.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(1),
    );
    expect(nativeStore.commands(sessionId, meta.accountBinding!)).toContainEqual(
      expect.objectContaining({ id: commandId, status: 'running' }),
    );
    expect(chat.registry.findBySessionId(sessionId)!.session.taskContext?.currentTaskId).toBe(
      taskId,
    );
    expect(application.taskStore.getTelosExecutionBinding(taskId)).toMatchObject({
      workerConversationId: sessionId,
      leadConversationId: leadId,
    });
    await record('actual-first-worker-command', {
      sessionId,
      taskId,
      commandId,
      threadId: actor.threadId,
      turnId: actor.turnId,
      meta,
    });
    return { sessionId, taskId, commandId, actor };
  };
  type Started = Awaited<ReturnType<typeof start>>;
  const invoke = async (
    worker: Started,
    name: string,
    args: Record<string, unknown>,
    approval: boolean,
  ) => {
    const preparedCall = await prepareNativeProviderToolCall(worker.actor, name, args);
    await record('actual-provider-discovery', {
      sessionId: worker.sessionId,
      name,
      contract: preparedCall.contract ?? null,
      discovery: preparedCall.discovery,
    });
    requests.push({ sessionId: worker.sessionId, name, request: preparedCall.request });
    await record('actual-provider-effect-request', requests.at(-1));
    const before = h.streamMessages.filter((frame) => frame.type === 'permission_request').length;
    const pending = worker.actor.lifecycle.onRequest(
      'item/tool/call',
      preparedCall.request,
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const allow = page.getByRole('button', { name: 'Allow Once', exact: true });
    await vi.waitFor(async () => expect(settled || (await allow.count()) > 0).toBe(true), {
      timeout: 10_000,
    });
    if (approval) {
      await browserExpect(allow).toBeVisible();
      const [permission] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().endsWith('/api/chat/permission'),
        ),
        allow.click(),
      ]);
      expect(permission.status()).toBe(200);
      await record('actual-once-permission', {
        sessionId: worker.sessionId,
        name,
        request: permission.request().postDataJSON(),
        status: permission.status(),
        body: await permission.json(),
      });
    }
    const result = await pending;
    await record('actual-provider-effect-result', { sessionId: worker.sessionId, name, result });
    const actual = z
      .object({
        success: z.boolean(),
        contentItems: z.array(
          z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
        ),
      })
      .passthrough()
      .parse(result);
    expect(actual.success, JSON.stringify(result)).toBe(true);
    if (!approval)
      expect(h.streamMessages.filter((frame) => frame.type === 'permission_request')).toHaveLength(
        before,
      );
    return actual.contentItems.map((item) => item.text ?? '').join('');
  };
  const retainEligibleOutput = async (worker: Started, suffix: string) => {
    const filename = 'first-completion-' + suffix + '.md';
    const report = '# Eligible report\n\nExact reviewed task evidence: ' + suffix + '.\n';
    const cwd = chat.eventStore.getSession(worker.sessionId)!.cwd!;
    await invoke(
      worker,
      'Write',
      { file_path: join(cwd, filename), content: report, require_approval: true },
      true,
    );
    const file = await h.http(
      '/api/files/read?' +
        new URLSearchParams({ sessionId: worker.sessionId, path: join(cwd, filename) }),
    );
    expect(file.status).toBe(200);
    expect((await file.json()).content).toBe(report);
    const input = {
      requestId: randomUUID(),
      itemId: 'recording-slice',
      filename,
      title: 'Eligible ' + suffix + ' report',
      path: filename,
    };
    const output = JSON.parse(await invoke(worker, 'TelosSaveArtifact', input, true)).artifact as {
      id: string;
      revision: number;
      sha256: string;
      sessionId: string;
      itemId: string;
    };
    expect(output).toMatchObject({
      itemId: 'recording-slice',
      sessionId: worker.sessionId,
      revision: 1,
      sha256: hash(report),
    });
    expect(JSON.parse(await invoke(worker, 'TelosSaveArtifact', input, false)).artifact).toEqual(
      output,
    );
    // The generic JSON command adapter serializes Buffer bodies. Use the real
    // authenticated browser request context for the public binary download.
    const response = await page.request.get(
      front.origin + '/api/telos/artifacts/' + output.id + '?revision=' + output.revision,
    );
    const actualBytes = await response.body();
    await record('actual-operator-exact-revision-download', {
      sessionId: worker.sessionId,
      artifact: output,
      status: response.status(),
      contentType: response.headers()['content-type'],
      text: actualBytes.toString('utf8'),
      sha256: createHash('sha256').update(actualBytes).digest('hex'),
    });
    expect(response.status()).toBe(200);
    expect(actualBytes.toString('utf8')).toBe(report);
    expect(createHash('sha256').update(actualBytes).digest('hex')).toBe(output.sha256);
    const reference = `artifact:${output.id}@${output.revision}`;
    expect(
      await invoke(
        worker,
        'mcp__task-board__TaskArtifact',
        { key: 'report', value: reference },
        true,
      ),
    ).toContain('Artifact stored: report');
    expect(application.taskStore.get(worker.taskId)!.artifacts).toMatchObject({
      report: reference,
    });
    await record('genuinely-eligible-canonical-output-before-first-completion', {
      workerId: worker.sessionId,
      taskId: worker.taskId,
      output,
      report,
      reference,
      readAuthority:
        'Actual operator exact-revision GET; Save does not grant native Read authority',
    });
    return { output, report, reference };
  };
  const snapshot = async (worker: Started) => {
    const session = chat.eventStore.getSession(worker.sessionId)!;
    return {
      work: await api.read('recording-slice'),
      childRecord: await api.readRecord('recording-slice'),
      parentRecord: await api.readRecord('studio'),
      task: application.taskStore.get(worker.taskId),
      mapping: application.taskStore.getTelosExecutionBinding(worker.taskId),
      context: resolveTelosWorkRoleContext(
        chat.eventStore,
        worker.sessionId,
        session.accountBinding!,
      ),
      runtime: chat.eventStore.getSessionRuntimeBinding(worker.sessionId),
      admission: chat.eventStore.getOrdinaryCommandAdmission(worker.commandId),
      cwd: session.cwd,
      profile: session.agentProfile,
      native: {
        conversation: nativeStore.read(worker.sessionId, session.accountBinding!),
        commands: nativeStore.commands(worker.sessionId, session.accountBinding!),
      },
    };
  };

  const originalAllocation = await allocate(null);
  const original = await start(
    originalAllocation.workerConversationId,
    originalAllocation.attempt.executionTaskId!,
  );
  const originalOutput = await retainEligibleOutput(original, 'original');
  expect(['pending', 'running']).toContain(application.taskStore.get(original.taskId)!.status);
  expect(application.taskStore.get(original.taskId)!.completedAt).toBeNull();
  expect(requests.filter((request) => request.name === completeName)).toHaveLength(0);
  const beforeAssign = await api.read('recording-slice');
  expect(beforeAssign.assignments).toEqual([]);
  await api.execute({
    operation: 'assign',
    itemId: 'recording-slice',
    role: 'worker',
    conversationId: original.sessionId,
    requestId: randomUUID(),
    expectedRevision: beforeAssign.revision,
    expectedAssignmentRevision: 0,
  });
  // Obtain the actual opaque contract while the original actor is current.
  // After replacement, submit this first effectful invocation to that same actor;
  // rediscovery after retirement must not turn this into merely a List refusal.
  const staleComplete = await prepareNativeProviderToolCall(original.actor, completeName, {
    summary: 'First completion of the retained original report.',
  });
  expect(staleComplete.contract?.name).toBe(completeName);
  expect(staleComplete.request.tool).toBe('InvokeIntegrationTool');
  await record('first-completion-prepared-while-current-not-yet-invoked', {
    sessionId: original.sessionId,
    request: staleComplete.request,
    contract: staleComplete.contract,
    discovery: staleComplete.discovery,
    previousFinalTaskCompleteRequests: 0,
    snapshot: await snapshot(original),
  });

  const replacementAllocation = await allocate(originalAllocation.attempt.attemptId);
  expect(replacementAllocation.workerConversationId).not.toBe(original.sessionId);
  expect(replacementAllocation.attempt.executionTaskId).not.toBe(original.taskId);
  expect(replacementAllocation.attempt.predecessorAttemptId).toBe(
    originalAllocation.attempt.attemptId,
  );
  const beforeReplace = await api.read('recording-slice');
  const replaced = await api.execute({
    operation: 'assign',
    itemId: 'recording-slice',
    role: 'worker',
    conversationId: replacementAllocation.workerConversationId,
    requestId: randomUUID(),
    expectedRevision: beforeReplace.revision,
    expectedAssignmentRevision: 1,
  });
  expect(replaced.work.assignments).toMatchObject([
    {
      role: 'worker',
      revision: 2,
      conversation: { conversationId: replacementAllocation.workerConversationId },
    },
  ]);
  const immediatelyBefore = await snapshot(original);
  expect(immediatelyBefore.native.commands).toContainEqual(
    expect.objectContaining({ id: original.commandId, status: 'running' }),
  );
  expect(requests.filter((request) => request.name === completeName)).toHaveLength(0);
  const permissionsBefore = h.streamMessages.filter(
    (frame) => frame.type === 'permission_request',
  ).length;
  await record('replacement-and-eligible-original-immediately-before-first-completion', {
    originalAllocation,
    replacementAllocation,
    replaced,
    immediatelyBefore,
    originalOutput,
    previousFinalTaskCompleteRequests: 0,
  });
  requests.push({
    sessionId: original.sessionId,
    name: completeName,
    request: staleComplete.request,
  });
  await record('original-first-final-completion-request', requests.at(-1));
  let refusal:
    | { kind: 'result'; result: Awaited<ReturnType<typeof original.actor.lifecycle.onRequest>> }
    | { kind: 'lifecycle-rejection'; error: { name: string; message: string; stack?: string } };
  let refusalPermission: { permId: string; request: unknown; status: number } | null = null;
  try {
    const pending = original.actor.lifecycle.onRequest(
      'item/tool/call',
      staleComplete.request,
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const allow = page.getByRole('button', { name: 'Allow Once', exact: true });
    await vi.waitFor(async () => expect(settled || (await allow.count()) > 0).toBe(true), {
      timeout: 10_000,
    });
    if (await allow.count()) {
      // If this actual owner exposes a request before its final denial, consume
      // only that real old-worker Once. Never supply a permission result.
      const [permission] = await Promise.all([
        page.waitForResponse(
          (r) => r.request().method() === 'POST' && r.url().endsWith('/api/chat/permission'),
        ),
        allow.click(),
      ]);
      const request = permission.request().postDataJSON();
      expect(request.sessionId).toBe(original.sessionId);
      expect(request.decision).toBe('once');
      expect(permission.status()).toBe(200);
      refusalPermission = { permId: request.permId, request, status: permission.status() };
      await record('actual-original-first-completion-once-before-final-refusal', refusalPermission);
    }
    refusal = { kind: 'result', result: await pending };
  } catch (error) {
    await record(
      'original-first-completion-raw-rejection',
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    );
    if (!(error instanceof Error) || error.message !== 'Owned Codex lifecycle unavailable')
      throw error;
    refusal = {
      kind: 'lifecycle-rejection',
      error: { name: error.name, message: error.message, stack: error.stack },
    };
  }
  const after = await snapshot(original);
  const retained = await page.request.get(
    front.origin + '/api/telos/artifacts/' + originalOutput.output.id + '?revision=1',
  );
  const retainedBytes = await retained.text();
  await record('first-completion-actual-refusal-and-postconditions-before-assertions', {
    refusal,
    refusalPermission,
    before: immediatelyBefore,
    after,
    retainedStatus: retained.status(),
    retainedBytes,
    permissionFramesBefore: permissionsBefore,
    permissionFramesAfter: h.streamMessages.filter((frame) => frame.type === 'permission_request')
      .length,
  });
  if (refusal.kind === 'result') expect(refusal.result.success).toBe(false);
  expect(
    requests.filter(
      (request) => request.sessionId === original.sessionId && request.name === completeName,
    ),
  ).toHaveLength(1);
  const oldPermissionFrames = h.streamMessages.filter(
    (frame) => frame.type === 'permission_request' && frame.sessionId === original.sessionId,
  );
  if (refusalPermission) {
    expect(oldPermissionFrames.some((frame) => frame.permId === refusalPermission!.permId)).toBe(
      true,
    );
  } else {
    expect(h.streamMessages.filter((frame) => frame.type === 'permission_request')).toHaveLength(
      permissionsBefore,
    );
  }
  await browserExpect(page.getByRole('button', { name: 'Allow Once', exact: true })).toHaveCount(0);
  expect(after.task).toEqual(immediatelyBefore.task);
  expect(after.work).toEqual(immediatelyBefore.work);
  for (const key of [
    'mapping',
    'context',
    'runtime',
    'admission',
    'cwd',
    'profile',
    'childRecord',
    'parentRecord',
  ] as const)
    expect(after[key]).toEqual(immediatelyBefore[key]);
  if (refusal.kind === 'lifecycle-rejection') {
    expect(after.native.commands).toEqual(
      immediatelyBefore.native.commands.map((command) =>
        command.id === original.commandId ? { ...command, status: 'interrupted' } : command,
      ),
    );
    expect(after.native.conversation).toEqual({
      ...immediatelyBefore.native.conversation,
      recovery: 1,
    });
  } else expect(after.native).toEqual(immediatelyBefore.native);
  expect(retained.status()).toBe(200);
  expect(retainedBytes).toBe(originalOutput.report);
  expect(hash(retainedBytes)).toBe(originalOutput.output.sha256);
  await capture('original-first-completion-refused-after-real-retry-replacement');

  const replacement = await start(
    replacementAllocation.workerConversationId,
    replacementAllocation.attempt.executionTaskId!,
  );
  const replacementOutput = await retainEligibleOutput(replacement, 'replacement');
  expect(
    await invoke(
      replacement,
      completeName,
      { summary: 'Current replacement report retained for explicit verification.' },
      true,
    ),
  ).toContain('pending_review');
  expect(application.taskStore.get(replacement.taskId)).toMatchObject({
    status: 'pending_review',
    completedAt: null,
    artifacts: { report: replacementOutput.reference },
  });
  expect(application.taskStore.get(original.taskId)).toEqual(after.task);
  expect(
    requests.filter(
      (request) => request.sessionId === replacement.sessionId && request.name === completeName,
    ),
  ).toHaveLength(1);
  expect((await api.read('recording-slice')).attempts).toHaveLength(2);
  expect((await api.readRecord('recording-slice')).status).toBe('active');
  expect((await api.readRecord('studio')).status).toBe(parentBefore.status);
  expect(parentBefore.status).toBe('active');
  expect(h.pageErrors).toEqual([]);
  await capture('current-replacement-first-completion-pending-review');
  await record('bounded-ct11-first-completion-case-complete', {
    original,
    replacement,
    originalOutput,
    replacementOutput,
    requests,
    originalTask: application.taskStore.get(original.taskId),
    replacementTask: application.taskStore.get(replacement.taskId),
    pageErrors: h.pageErrors,
    realModelCalls: 0,
    limits:
      'Operator-before-allocation explicit retry attempt and guarded current assignment. Not native StartSlice, same-attempt UI-only replacement, cold restart, TaskApprove/done, canonical verified completion or whole CT11/main acceptance.',
  });
}, 120_000);
