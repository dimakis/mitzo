import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { telosChatRows } from '../../../../frontend/src/lib/telos-chat-rows';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TelosWorkApiClient, TelosWorkApiError, OrdinaryWorkspaceApiClient } from '@mitzo/client';
import {
  TelosOrdinaryWorkDelegationInputSchema,
  TelosWorkAdvisorDraftPreviewRequestSchema,
} from '@mitzo/protocol';
import { createJoinedOrdinaryApplication } from '../integrated-candidate/joined-ordinary-application';
import { initializeReadinessData, selectedModel, createExternalInventory } from './synthetic-data';

const clone = <T>(value: T): T => structuredClone(value);
const inventorySchema = z
  .object({
    capabilityRevision: z.string().min(1),
    accounts: z.array(
      z
        .object({
          account: z.object({
            accountId: z.string(),
            provider: z.string(),
            profileRevision: z.string(),
          }),
          models: z.array(z.object({ id: z.string() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

it('CT10 preserves the running attempt and refuses a newly reviewed retry while its selected model is unavailable, then admits an explicitly refreshed retry', async () => {
  const evidence = process.env.S9_JOINED_SCREENSHOT_DIR;
  if (!evidence) throw Error('A fresh evidence directory is required');
  const external = createExternalInventory();
  const h = await createJoinedOrdinaryApplication(
    { viewport: { width: 1280, height: 900 } },
    initializeReadinessData,
    external.modelList,
  );
  const { f, page, front, chat, application } = h;
  expect(f.binding.model).toBe(selectedModel);
  const records: Array<{ stage: string; facts: unknown }> = [];
  const record = async (stage: string, facts: unknown) => {
    records.push({ stage, facts });
    await writeFile(join(evidence, 'model-readiness.json'), JSON.stringify(records, null, 2));
  };
  // Actual cookie-authenticated loopback HTTP; preserve non-2xx responses for the
  // real typed client. The shared success-only JSON adapter cannot witness this.
  const observedFetch = async (url: string, init?: RequestInit) => {
    const response = await page.request.fetch(front.origin + url, {
      method: init?.method ?? 'GET',
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        Authorization: 'Bearer ' + f.token,
        'X-Connection-Id': f.operatorConnectionId,
      },
      ...(init?.body ? { data: JSON.parse(String(init.body)) } : {}),
    });
    const text = await response.text();
    await record('actual-operator-http', {
      method: init?.method ?? 'GET',
      url,
      submitted: init?.body ? JSON.parse(String(init.body)) : null,
      status: response.status(),
      body: text,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    return new Response(text, { status: response.status(), headers: response.headers() });
  };
  const api = new TelosWorkApiClient(observedFetch),
    ordinary = new OrdinaryWorkspaceApiClient(observedFetch);
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
      broadcastStatus: (status) => h.connections.broadcastAll({ type: 'loop_status', ...status }),
      broadcastTasks: () => {
        const event = { type: 'task_state' as const, tasks: application.taskStore.getTree() };
        h.connections.broadcastAll(event);
        application.sseRegistry.broadcast('task_state', event);
      },
    }),
  );
  const prepareSettings = async () => {
    const receipt = await ordinary.prepare({
      version: 1,
      model: selectedModel,
      runOn: 'local',
      runtime: {
        account: f.first.request.runtime.account,
        harness: f.first.request.runtime.harness,
        targetId: f.first.request.runtime.targetId,
      },
    });
    return {
      version: 2 as const,
      binding: receipt.runtimeBinding,
      selection: clone(f.first.request.selection),
      workspace: { kind: 'ordinary' as const, preparationId: receipt.preparationId },
    };
  };
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
  const setupRole = async (itemId: string, role: 'lead' | 'advisor') => {
    const review = await api.reviewRoleContext({
      itemId,
      role,
      ...(role === 'advisor' ? { advisorPurpose: 'refine' as const } : {}),
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const receipt = await api.setupReviewedOrdinaryRole({
      version: 2,
      presentationRef: review.presentationRef,
      input: {
        version: 2,
        requestId: randomUUID(),
        itemId,
        role,
        expectedRevision: review.selection.brief.revision,
        expectedAssignmentRevision: role === 'lead' ? 0 : null,
        contextSelection: review.selection,
        settings: await prepareSettings(),
      },
    });
    const match = receipt.work.links.filter((link) => link.role === role);
    expect(match).toHaveLength(1);
    return match[0].conversation.conversationId;
  };
  const leadId = await setupRole('studio', 'lead');
  const advisorId = await setupRole('recording-slice', 'advisor');
  const { getCodexConversationStore } = await import('../../../../server/codex-chat-session.js');
  const { resolveTelosWorkRoleContext } =
    await import('../../../../server/telos-work-role-context.js');
  const native = getCodexConversationStore();
  const start = async (sessionId: string, text: string, navigate?: () => Promise<void>) => {
    if (navigate) await navigate();
    else await page.goto(front.origin + '/chat/' + sessionId);
    await page.getByRole('textbox', { name: 'Message Mitzo', exact: true }).fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    const submitted = response.request().postDataJSON();
    expect(response.status()).toBe(202);
    expect(await response.json()).toMatchObject({ sessionId, state: 'consumed', dispatched: true });
    expect(submitted.selection).toEqual(f.first.request.selection);
    const session = chat.eventStore.getSession(sessionId)!;
    const conversation = native.read(sessionId, session.accountBinding!);
    const actors = h.nativeSessions.filter((a) => a.threadId === conversation.threadId);
    expect(actors).toHaveLength(1);
    const actor = actors[0];
    await vi.waitFor(() =>
      expect(actor.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1),
    );
    expect(native.commands(sessionId, session.accountBinding!)).toContainEqual(
      expect.objectContaining({ id: submitted.clientMsgId, status: 'running' }),
    );
    await record('actual-first-command', {
      sessionId,
      submitted,
      session,
      threadId: actor.threadId,
      turnId: actor.turnId,
    });
    return { sessionId, commandId: submitted.clientMsgId as string, actor };
  };
  const advisor = await start(
    advisorId,
    'Refine this existing recording slice under its existing parent to require documented listening notes.',
  );
  const desiredOutcome = 'Retain one reviewed acoustic sample with documented listening notes.';
  const reply = 'Agreed same-item refinement: ' + desiredOutcome;
  const notifications = [
    {
      method: 'item/agentMessage/delta',
      params: {
        threadId: advisor.actor.threadId,
        turnId: advisor.actor.turnId,
        itemId: 'readiness-advisor-output',
        delta: reply,
      },
    },
    {
      method: 'item/completed',
      params: {
        threadId: advisor.actor.threadId,
        turnId: advisor.actor.turnId,
        item: { type: 'agentMessage', id: 'readiness-advisor-output', text: reply },
      },
    },
    {
      method: 'turn/completed',
      params: {
        threadId: advisor.actor.threadId,
        turn: { id: advisor.actor.turnId, status: 'completed' },
      },
    },
  ];
  for (const notification of notifications) {
    await record('fake-external-provider-notification-input', notification);
    advisor.actor.lifecycle.onNotification(notification.method, notification.params);
  }
  const transcriptSchema = z
    .object({
      current: z.null(),
      currents: z.array(z.unknown()).optional(),
      messages: z
        .array(
          z.object({ messageId: z.string(), completedSeq: z.number().positive() }).passthrough(),
        )
        .min(1),
    })
    .passthrough();
  let boundary: { messageId: string; sequence: number } | undefined;
  await vi.waitFor(async () => {
    const response = await observedFetch('/api/sessions/' + advisorId + '/messages?transcript=1');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).toContain(reply);
    const transcript = transcriptSchema.parse(body);
    expect(transcript.currents ?? []).toEqual([]);
    const last = transcript.messages.at(-1)!;
    boundary = { messageId: last.messageId, sequence: last.completedSeq };
  });
  const makeRetry = async (predecessorAttemptId: string | null) => {
    const review = await api.reviewRoleContext({
      itemId: 'recording-slice',
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    return TelosOrdinaryWorkDelegationInputSchema.parse({
      version: 2,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: 'recording-slice',
      leadConversationId: leadId,
      expectedRevision: review.selection.brief.revision,
      mode: predecessorAttemptId ? 'retry' : 'start',
      predecessorAttemptId,
      settings: await prepareSettings(),
      contextSelection: review.selection,
    });
  };
  const firstInput = await makeRetry(null),
    first = await api.delegateOrdinarySlice(firstInput);
  expect(await api.delegateOrdinarySlice(firstInput)).toEqual(first);
  expect(first.execution).toBe('not_started');
  const original = await start(
    first.workerConversationId,
    'Work only under the originally reviewed acoustic sample brief; do not adopt future changes silently.',
  );
  const originalContext = resolveTelosWorkRoleContext(
    chat.eventStore,
    original.sessionId,
    chat.eventStore.getSession(original.sessionId)!.accountBinding!,
  );
  expect(originalContext).toMatchObject({ role: 'worker', itemId: 'recording-slice' });
  expect(first.attempt.executionTaskId).toBeTruthy();
  expect(
    application.taskStore.getTelosExecutionBinding(first.attempt.executionTaskId!),
  ).toMatchObject({
    workerConversationId: original.sessionId,
    leadConversationId: leadId,
  });
  const old = await api.readRecord('recording-slice');
  const proposal = TelosWorkAdvisorDraftPreviewRequestSchema.parse({
    requestId: randomUUID(),
    operation: 'refine',
    itemId: 'recording-slice',
    advisorConversationId: advisorId,
    expectedRevision: (await api.read('recording-slice')).revision,
    parentId: 'studio',
    expectedParentRevision: (await api.read('studio')).revision,
    proposed: { name: old.summary, desiredOutcome, type: 'work_item', category: 'Music' },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      messageIds: [],
      purpose: 'Reviewed CT10 model-readiness refinement',
      joiningBrief: '',
      sourceConversationId: advisorId,
      mode: 'conversation_so_far',
      boundary: boundary!,
      artifacts: [],
    },
  });
  const preview = await api.previewAdvisorDraft(proposal);
  const saved = await api.saveAdvisorDraft({ ...proposal, previewSha256: preview.sha256 });
  expect(saved.work.itemId).toBe('recording-slice');
  expect((await api.readRecord('recording-slice')).intent).toBe(desiredOutcome);
  const deniedInput = await makeRetry(first.attempt.attemptId);
  expect(deniedInput.contextSelection.brief).not.toEqual(originalContext!.brief);
  expect(JSON.parse(deniedInput.contextSelection.brief.text).intent).toBe(desiredOutcome);
  const immutableOriginal = () => {
    const session = chat.eventStore.getSession(original.sessionId)!;
    return clone({
      session,
      context: resolveTelosWorkRoleContext(
        chat.eventStore,
        original.sessionId,
        session.accountBinding!,
      ),
      native: native.read(original.sessionId, session.accountBinding!),
      commands: native.commands(original.sessionId, session.accountBinding!),
      admission: chat.eventStore.getOrdinaryCommandAdmission(original.commandId),
      runtime: chat.eventStore.getSessionRuntimeBinding(original.sessionId),
      task: application.taskStore.get(first.attempt.executionTaskId!),
      mapping: application.taskStore.getTelosExecutionBinding(first.attempt.executionTaskId!),
      workspace: f.workspaces.getOrdinaryWorkspaceForConversation(original.sessionId),
    });
  };
  const runningBeforeDiscovery = immutableOriginal();
  expect(runningBeforeDiscovery.context).toEqual(originalContext);
  const allTurns = () =>
    h.nativeSessions.flatMap((a) =>
      a.rpc.request.mock.calls
        .filter(([m]) => m === 'turn/start')
        .map((call) => ({ threadId: a.threadId, call })),
    );
  const snapshot = async () =>
    clone({
      original: immutableOriginal(),
      child: await api.read('recording-slice'),
      childRecord: await api.readRecord('recording-slice'),
      parent: await api.read('studio'),
      parentRecord: await api.readRecord('studio'),
      sessions: chat.eventStore.listSessions(),
      tasks: application.taskStore.getTree(),
      nativeActorThreads: h.nativeSessions.map((a) => a.threadId),
      turns: allTurns(),
      permissions: h.streamMessages.filter((frame) => frame.type === 'permission_request'),
    });
  const inventory = async () => {
    const response = await observedFetch('/api/chat/runtime/capabilities?workspaceDefaults=1');
    expect(response.status).toBe(200);
    return inventorySchema.parse(await response.json());
  };
  const beforeInventory = await inventory();
  const account = (value: z.infer<typeof inventorySchema>) => {
    const matches = value.accounts.filter((a) => a.account.accountId === f.binding.accountId);
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  expect(account(beforeInventory).models.map((m) => m.id)).toContain(selectedModel);
  external.setPhase('unavailable');
  const refresh = await observedFetch('/api/accounts?refresh=1');
  expect(refresh.status).toBe(200);
  const unavailableInventory = await inventory();
  expect(unavailableInventory.capabilityRevision).not.toBe(beforeInventory.capabilityRevision);
  expect(account(unavailableInventory).account).toEqual(account(beforeInventory).account);
  expect(account(unavailableInventory).models.map((m) => m.id)).toEqual([external.alternateModel]);
  expect(immutableOriginal()).toEqual(runningBeforeDiscovery);
  const { AccountProfiles } = await import('../../../../server/account-profiles.js');
  // Read-only wrappers observe genuine per-request instances, never replace owners.
  const resolve = vi.spyOn(AccountProfiles.prototype, 'resolve');
  const reserve = vi.spyOn(f.workspaces, 'reserveOrdinaryWorkspace');
  const { TelosWorkStore } = await import('../../../../server/telos-work-store.js');
  const prepare = vi.spyOn(TelosWorkStore.prototype, 'prepareOrdinaryDelegation');
  const beforeRefusal = await snapshot();
  let failure: unknown;
  try {
    await api.delegateOrdinarySlice(deniedInput);
  } catch (error) {
    failure = error;
  }
  await record('actual-selected-model-retry-refusal', {
    input: deniedInput,
    error:
      failure instanceof TelosWorkApiError
        ? {
            name: failure.name,
            status: failure.status,
            code: failure.code,
            message: failure.message,
            recovery: failure.recovery ?? null,
          }
        : String(failure),
    actualResolve: resolve.mock.results.map((result, i) => ({
      arguments: resolve.mock.calls[i],
      type: result.type,
      value:
        result.value instanceof Error
          ? { name: result.value.name, message: result.value.message }
          : result.value,
    })),
    externalMetadata: external.observations(),
    beforeInventory,
    unavailableInventory,
  });
  expect(failure).toBeInstanceOf(TelosWorkApiError);
  expect(failure).toMatchObject({
    status: 503,
    code: 'unavailable',
    message: 'Ordinary work delegation unavailable',
  });
  expect((failure as TelosWorkApiError).recovery).toBeUndefined();
  expect(resolve.mock.calls).toContainEqual([f.binding.accountId, selectedModel]);
  expect(resolve.mock.results).toContainEqual({
    type: 'throw',
    value: expect.objectContaining({
      message: 'Model is unavailable for this account. Select a model from its catalog.',
    }),
  });
  expect(reserve).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  const afterRefusal = await snapshot();
  expect(afterRefusal).toEqual(beforeRefusal);
  await record('exact-unchanged-state-and-zero-allocation-after-refusal', {
    beforeRefusal,
    afterRefusal,
    reserveCalls: reserve.mock.calls,
    prepareCalls: prepare.mock.calls,
  });
  resolve.mockRestore();
  reserve.mockRestore();
  prepare.mockRestore();
  external.setPhase('restored');
  const restoredResponse = await observedFetch('/api/accounts?refresh=1');
  expect(restoredResponse.status).toBe(200);
  const restoredInventory = await inventory();
  expect(restoredInventory.capabilityRevision).not.toBe(unavailableInventory.capabilityRevision);
  expect(account(restoredInventory).account).toEqual(account(beforeInventory).account);
  expect(account(restoredInventory).models.map((m) => m.id)).toEqual([selectedModel]);
  // Explicit operator choices/current review and NEW preparation/request. Never
  // retry the unavailable request implicitly or assume a terminal rejection.
  const positiveInput = await makeRetry(first.attempt.attemptId);
  expect(positiveInput.requestId).not.toBe(deniedInput.requestId);
  expect(positiveInput.settings.workspace.preparationId).not.toBe(
    deniedInput.settings.workspace.preparationId,
  );
  expect(positiveInput.settings.selection).toEqual(deniedInput.settings.selection);
  expect(positiveInput.settings.binding).toEqual(deniedInput.settings.binding);
  expect(positiveInput.contextSelection).toEqual(deniedInput.contextSelection);
  const turnsBeforeAllocation = clone(allTurns());
  const positive = await api.delegateOrdinarySlice(positiveInput);
  expect(await api.delegateOrdinarySlice(positiveInput)).toEqual(positive);
  expect(positive.execution).toBe('not_started');
  expect(allTurns()).toEqual(turnsBeforeAllocation);
  expect(positive.workerConversationId).not.toBe(original.sessionId);
  expect(positive.attempt.attemptId).not.toBe(first.attempt.attemptId);
  expect(positive.attempt.executionTaskId).not.toBe(first.attempt.executionTaskId);
  expect((await api.read('recording-slice')).attempts).toHaveLength(2);
  const current = await start(
    positive.workerConversationId,
    'Execute this explicit new attempt under the reviewed listening-notes brief.',
    async () => {
      // The positive trajectory changes chats in this same App/document. A full
      // page.goto unload legitimately suspends the old transport on pagehide.
      const documentBefore = await page.evaluate(() => performance.timeOrigin);
      const work = await api.read('recording-slice');
      const rows = telosChatRows(work);
      const selected = rows.findIndex(
        (row) =>
          row.conversation.namespace === 'mitzo' &&
          row.conversation.conversationId === positive.workerConversationId,
      );
      expect(selected).toBeGreaterThanOrEqual(0);
      await page.getByRole('button', { name: /^Chats for this item: / }).click();
      const chooser = page.getByRole('region', { name: 'Chats for ' + old.summary, exact: true });
      const openers = chooser.getByRole('button', { name: /^Open / });
      await browserExpect(openers).toHaveCount(rows.length);
      const [metadata] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.status() === 200 &&
            new URL(response.url()).pathname ===
              '/api/sessions/' + positive.workerConversationId + '/meta',
        ),
        openers.nth(selected).click(),
      ]);
      expect((await metadata.json()).sessionId).toBe(positive.workerConversationId);
      await browserExpect(page).toHaveURL(
        new RegExp('/chat/' + positive.workerConversationId + '(?:\\?|$)'),
      );
      await browserExpect(page.getByText('Loading conversation…', { exact: true })).toHaveCount(0);
      await browserExpect(
        page.getByRole('button', { name: /^Workspace controls,/ }),
      ).toHaveAccessibleDescription('First command');
      const documentAfter = await page.evaluate(() => performance.timeOrigin);
      expect(documentAfter).toBe(documentBefore);
      await record('actual-same-document-positive-worker-chooser-navigation', {
        selectedRowKey: rows[selected].key,
        selectedConversationId: positive.workerConversationId,
        actualRoute: page.url(),
        documentBefore,
        documentAfter,
        realMetadataStatus: metadata.status(),
      });
    },
  );
  expect(allTurns()).toHaveLength(turnsBeforeAllocation.length + 1);
  const currentSession = chat.eventStore.getSession(current.sessionId)!;
  const currentContext = resolveTelosWorkRoleContext(
    chat.eventStore,
    current.sessionId,
    currentSession.accountBinding!,
  );
  expect(currentContext!.brief).toEqual(positiveInput.contextSelection.brief);
  expect(
    application.taskStore.getTelosExecutionBinding(positive.attempt.executionTaskId!)!,
  ).toMatchObject({ workerConversationId: current.sessionId, leadConversationId: leadId });
  expect(f.workspaces.getOrdinaryWorkspaceForConversation(current.sessionId)!.id).not.toBe(
    runningBeforeDiscovery.workspace!.id,
  );
  expect(immutableOriginal()).toEqual(runningBeforeDiscovery);
  expect(h.pageErrors).toEqual([]);
  await record('explicit-restored-selection-new-attempt-positive-control', {
    positiveInput,
    positive,
    restoredInventory,
    currentContext,
    original: immutableOriginal(),
    metadata: external.observations(),
    turns: allTurns(),
    scope:
      'Operator API review/retry; UI first command only. Generic503 admission refusal, no durable rejection/UI-specific model diagnosis/cold/wholeCT10/native composition/verified outcome claim.',
    realModelCalls: 0,
  });
}, 120_000);
