import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TelosWorkControlViewSchema, type TelosWorkControlCommand } from '@mitzo/protocol';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';
import { observeNavigatedControlInbox } from './navigated-control-inbox';
import { observeSurfaceControlInbox } from './surface-control-inbox';

it('coordinates six actual outcomes through UI requests, native recipient ACKs, host safe-point evidence and durable release while unrelated Job completes', async () => {
  const hostFetch = globalThis.fetch;
  const h = await createJoinedOrdinaryApplication({ viewport: { width: 320, height: 900 } });
  const { canonical, api, ordinary, f, page, front, chat, nativeSessions } = h;
  const { TaskOrchestrator } = await import('../../../../server/task-orchestrator.js');
  h.application.setOrchestrator(
    new TaskOrchestrator({
      store: h.application.taskStore,
      getClientId: () => {
        throw Error('Legacy scheduler must not choose a worker');
      },
      setTaskContext: () => {},
      clearTaskContext: () => {},
      broadcastStatus: () => {},
      broadcastTasks: () => {
        const event = { type: 'task_state', tasks: h.application.taskStore.getTree() };
        h.connections.broadcastAll(event);
        h.application.sseRegistry.broadcast('task_state', event);
      },
    }),
  );

  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.port !== String(front.port) ||
      url.pathname !== '/api/internal/telos/work/control'
    )
      throw Error('No external/provider or alternate owned fetch');
    return hostFetch(input, init);
  });
  const observationStarted = performance.now();
  const facts: Array<Record<string, unknown>> = [];
  const browserControls: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/telos/work/controls')
      browserControls.push(req.postDataJSON());
  });
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'coordinator-observations.json'),
        JSON.stringify(
          {
            facts,
            browserControls,
            nativeLaunches: nativeSessions.length,
            nativeStarts: nativeSessions.map((n) => ({
              threadId: n.threadId,
              turns: n.rpc.request.mock.calls.filter(([m]) => m === 'turn/start').length,
              interrupts: n.rpc.request.mock.calls.filter(([m]) => m === 'turn/interrupt').length,
            })),
            pageErrors: h.pageErrors,
            realModelCalls: 0,
          },
          null,
          2,
        ),
      );
  };
  const record = async (stage: string, values: Record<string, unknown> = {}) => {
    facts.push({ stage, elapsedMs: performance.now() - observationStarted, ...values });
    await save();
  };
  const capture = async (stage: string) => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, stage + '.png'),
        fullPage: true,
      });
  };
  const control = async (command: Exclude<TelosWorkControlCommand, { operation: 'acknowledge' }>) =>
    TelosWorkControlViewSchema.parse(await api.control(command));
  const insert = canonical.db.prepare(
    `INSERT INTO items (id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,categories,context_hints,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',5,?,'{}',?,?,?,?)`,
  );
  const add = async (
    id: string,
    parent: string | null,
    title: string,
    kind: 'coordinator' | 'outcome' | 'work_item',
    categories = ['Mitzo'],
  ) => {
    insert.run(
      id,
      parent,
      title,
      'Retain exact scope and review evidence',
      'Synthetic shared-main coordination',
      JSON.stringify(['Scoped receipt retained', 'Unrelated work continues']),
      JSON.stringify(categories),
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
  const settings = async () => {
    const p = await ordinary.prepare({
      version: 1,
      model: f.binding.model,
      runOn: 'local',
      runtime: {
        account: f.first.request.runtime.account,
        harness: 'codex',
        targetId: f.first.request.runtime.targetId,
      },
    });
    return {
      version: 2 as const,
      binding: p.runtimeBinding,
      selection: f.first.request.selection,
      workspace: { kind: 'ordinary' as const, preparationId: p.preparationId },
    };
  };
  const lead = async (itemId: string) => {
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
        settings: await settings(),
      },
    });
    return receipt.work.assignments[0].conversation.conversationId;
  };
  const delegate = async (itemId: string, childId: string, leadId: string) => {
    const review = await api.reviewRoleContext({
      itemId: childId,
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const receipt = await api.delegateOrdinarySlice({
      version: 2,
      requestId: randomUUID(),
      leadItemId: itemId,
      childItemId: childId,
      leadConversationId: leadId,
      expectedRevision: review.selection.brief.revision,
      mode: 'start',
      predecessorAttemptId: null,
      settings: await settings(),
      contextSelection: review.selection,
    });
    expect(receipt.execution).toBe('not_started');
    return receipt;
  };
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  const start = async (id: string, label: string) => {
    await page.goto(front.origin + '/chat/' + id);
    const before = nativeSessions.length;
    await h.waitForPreparedConversation(id);
    await composer.fill('Synthetic native turn for ' + label + '; retain scoped authority.');
    const [sent] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(sent.status()).toBe(202);
    expect(await sent.json()).toMatchObject({ state: 'consumed', dispatched: true, sessionId: id });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(before + 1));
    const native = nativeSessions.at(-1)!;
    await vi.waitFor(() =>
      expect(native.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1),
    );
    expect(native.tools.some((tool) => tool.name === 'TelosWorkControl')).toBe(true);
    return native;
  };
  const ack = async (
    native: (typeof nativeSessions)[number],
    sessionId: string,
    command: TelosWorkControlCommand,
  ) => {
    const before = h.streamMessages.length;
    const pending = native.lifecycle.onRequest(
      'item/tool/call',
      {
        threadId: native.threadId,
        turnId: native.turnId,
        callId: randomUUID(),
        tool: 'TelosWorkControl',
        arguments: { command },
      },
      new AbortController().signal,
    ) as Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
    // Preserve the original rejection even if a UI wait fails, without resolving
    // a permission or fabricating any owned request/receipt in the test.
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(
        h.streamMessages
          .slice(before)
          .some((m) => m.type === 'permission_request' && m.sessionId === sessionId),
      ).toBe(true),
    );
    await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
    const receipt = await pending;
    expect(receipt.success, JSON.stringify(receipt)).toBe(true);
    const view = TelosWorkControlViewSchema.parse(JSON.parse(receipt.contentItems[0].text));
    await record('native-ack', { sessionId, command, view });
    return view;
  };
  const coordinatorRegion = page.getByRole('region', { name: 'Coordinator controls', exact: true });
  const publication = () =>
    coordinatorRegion.getByRole('article', {
      name: 'Coordination receipt: Publishing to shared main',
      exact: true,
    });
  const safePoint = () =>
    coordinatorRegion.getByRole('article', {
      name: 'Coordination receipt: Stop at a safe point',
      exact: true,
    });
  const uiRequest = async (scope: 'publication' | 'safe_point' | 'new_worker_dispatch') => {
    await coordinatorRegion.getByRole('button', { name: 'Feature 0', exact: true }).click();
    await coordinatorRegion
      .getByRole('combobox', { name: 'Hold scope', exact: true })
      .selectOption(scope);
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'request',
      ),
      coordinatorRegion
        .getByRole('button', { name: 'Send hold to five leads', exact: true })
        .click(),
    ]);
    expect(response.status()).toBe(200);
    const view = TelosWorkControlViewSchema.parse(await response.json());
    expect(view.scope).toBe(scope);
    expect(view.priorityItemId).toBe('feature-0');
    expect(view.targets.map((t) => t.itemId).sort()).toEqual(
      [1, 2, 3, 4, 5].map((i) => 'feature-' + i),
    );
    expect(view.stage).toBe('requested');
    expect(view.history).toEqual([]);
    expect(
      view.targets.every(
        (t) =>
          t.stage === 'requested' && t.workers.length === 1 && t.workers[0].stage === 'requested',
      ),
    ).toBe(true);
    await record('UI-request-' + scope, { command: response.request().postDataJSON(), view });
    return view;
  };
  try {
    await add('coordination-root', null, 'Coordination programme', 'coordinator');
    const coordinatorId = await lead('coordination-root');
    const features: Array<{ itemId: string; childId: string; leadId: string; workerId: string }> =
      [];
    for (let i = 0; i < 6; i++) {
      const itemId = 'feature-' + i,
        childId = 'feature-worker-' + i;
      await add(itemId, 'coordination-root', 'Feature ' + i, 'outcome');
      await add(childId, itemId, 'Feature ' + i + ' child', 'work_item');
      const leadId = await lead(itemId),
        receipt = await delegate(itemId, childId, leadId);
      features.push({ itemId, childId, leadId, workerId: receipt.workerConversationId });
    }
    await add('job-outcome', null, 'Unrelated quarterly connections', 'outcome', ['Job']);
    await add('job-worker', 'job-outcome', 'Unrelated quarterly draft', 'work_item', ['Job']);
    const jobLeadId = await lead('job-outcome'),
      job = await delegate('job-outcome', 'job-worker', jobLeadId);
    const sessionCount = chat.eventStore.listSessions().length;
    const workspaceIds = [
      coordinatorId,
      ...features.flatMap((f) => [f.leadId, f.workerId]),
      jobLeadId,
      job.workerConversationId,
    ].map((id) => chat.eventStore.getSession(id)!.ordinaryWorkspaceId);
    expect(new Set(workspaceIds).size).toBe(workspaceIds.length);
    await record('fixture-real-reviewed-and-delegated', {
      coordinatorId,
      features,
      job,
      sessionCount,
      workspaceIds,
    });
    await page.goto(front.origin + '/chat/' + coordinatorId);
    await composer.fill('Keep coordinator decision draft.');
    await browserExpect(
      coordinatorRegion.getByRole('button', { name: 'Feature 0', exact: true }),
    ).toBeEnabled();
    await capture('coordinator-priority-and-scope');
    const requested = await uiRequest('publication');
    expect(nativeSessions).toHaveLength(0);
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Hold requested · acknowledgements pending',
        exact: true,
      }),
    ).toBeVisible();
    const [readResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'read',
      ),
      publication().getByRole('button', { name: 'Check acknowledgements', exact: true }).click(),
    ]);
    expect(readResponse.request().postDataJSON()).toEqual({
      operation: 'read',
      controlId: requested.controlId,
    });
    expect(TelosWorkControlViewSchema.parse(await readResponse.json())).toEqual(requested);
    await capture('publication-requested-read-only');
    const deniedAck = await page.request.post(front.origin + '/api/telos/work/controls', {
      headers: { Origin: front.origin },
      data: {
        operation: 'acknowledge',
        requestId: randomUUID(),
        controlId: requested.controlId,
        itemId: features[1].itemId,
        assignmentRevision: 1,
      },
    });
    expect(deniedAck.status()).toBe(403);
    expect((await control({ operation: 'read', controlId: requested.controlId })).history).toEqual(
      [],
    );
    await record('operator-ack-denied', {
      status: deniedAck.status(),
      body: await deniedAck.json(),
    });
    const jobNative = await start(job.workerConversationId, 'unrelated Job');
    await composer.fill('Keep unrelated Job draft.');
    for (const [index, feature] of features.slice(1).entries()) {
      for (const recipient of [
        { itemId: feature.itemId, sessionId: feature.leadId, revision: 1 },
        { itemId: feature.childId, sessionId: feature.workerId, revision: 0 },
      ]) {
        const native = await start(recipient.sessionId, recipient.itemId);
        const command = {
          operation: 'acknowledge' as const,
          requestId: randomUUID(),
          controlId: requested.controlId,
          itemId: recipient.itemId,
          assignmentRevision: recipient.revision,
        };
        const view = await ack(native, recipient.sessionId, command);
        expect(view.targets.every((t) => t.itemId === feature.itemId)).toBe(true);
        if (recipient.itemId === feature.childId) expect(view.targets[0].workers).toHaveLength(1);
        if (index === 0 && recipient.itemId === feature.itemId) {
          expect(view.targets[0].stage).toBe('acknowledged');
          expect(view.targets[0].workers[0].stage).toBe('requested');
          const before = (await control({ operation: 'read', controlId: requested.controlId }))
            .history;
          await ack(native, recipient.sessionId, command);
          expect(
            (await control({ operation: 'read', controlId: requested.controlId })).history,
          ).toEqual(before);
        }
      }
    }
    const acknowledged = await control({ operation: 'read', controlId: requested.controlId });
    expect(acknowledged.stage).toBe('acknowledged');
    expect(acknowledged.history).toHaveLength(10);
    expect(acknowledged.history.every((e) => e.stage === 'acknowledged')).toBe(true);
    expect(
      acknowledged.targets.every(
        (t) => t.stage === 'acknowledged' && t.workers.every((w) => w.stage === 'acknowledged'),
      ),
    ).toBe(true);
    const acknowledgedInboxResponse = await observeNavigatedControlInbox(
      page,
      acknowledged.coordinatorItemId,
      () => page.goto(front.origin + '/chat/' + coordinatorId),
    );
    expect(acknowledgedInboxResponse.status).toBe(200);
    const acknowledgedInbox = TelosWorkControlViewSchema.array().parse(
      acknowledgedInboxResponse.body,
    );
    expect(acknowledgedInbox).toEqual([acknowledged]);
    await record('browser-loaded-exact-acknowledged-inbox', { acknowledgedInbox });
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Acknowledged · application pending',
        exact: true,
      }),
    ).toBeVisible();
    await browserExpect(composer).toHaveValue('Keep coordinator decision draft.');
    await capture('actual-native-ack-application-pending');
    await coordinatorRegion.getByRole('button', { name: 'Inspect work tree', exact: true }).focus();
    await page.keyboard.press('Enter');
    await browserExpect(
      page.getByRole('button', { name: 'Toggle work tree', exact: true }),
    ).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: 'Close work tree', exact: true }).click();
    await browserExpect(
      page.getByRole('button', { name: 'Toggle work tree', exact: true }),
    ).toBeFocused();
    const reply =
      'Unrelated quarterly work completed while five publication holds remained active.';
    jobNative.lifecycle.onNotification('item/agentMessage/delta', {
      threadId: jobNative.threadId,
      turnId: jobNative.turnId,
      itemId: 'job-result',
      delta: reply,
    });
    jobNative.lifecycle.onNotification('item/completed', {
      threadId: jobNative.threadId,
      turnId: jobNative.turnId,
      item: { type: 'agentMessage', id: 'job-result', text: reply },
    });
    jobNative.lifecycle.onNotification('turn/completed', {
      threadId: jobNative.threadId,
      turn: { id: jobNative.turnId, status: 'completed' },
    });
    await page.goto(front.origin + '/chat/' + job.workerConversationId);
    await page.reload();
    await browserExpect(page.getByText(reply, { exact: true })).toBeVisible();
    await browserExpect(composer).toHaveValue('Keep unrelated Job draft.');
    await capture('unrelated-job-completed-reloaded');
    canonical.restartOwners();
    await page.goto(front.origin + '/chat/' + coordinatorId);
    // The restarted inbox hydrates after the document commits. Start the
    // existing heading oracle only after that document reads its exact receipt.
    const restartedAcknowledgedInboxResponse = await observeNavigatedControlInbox(
      page,
      acknowledged.coordinatorItemId,
      () => page.reload(),
    );
    expect(restartedAcknowledgedInboxResponse.status).toBe(200);
    const restartedAcknowledgedInbox = TelosWorkControlViewSchema.array().parse(
      restartedAcknowledgedInboxResponse.body,
    );
    expect(restartedAcknowledgedInbox).toEqual([acknowledged]);
    await record('browser-loaded-exact-restarted-acknowledged-inbox', {
      restartedAcknowledgedInbox,
    });
    expect(await control({ operation: 'read', controlId: requested.controlId })).toEqual(
      acknowledged,
    );
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Acknowledged · application pending',
        exact: true,
      }),
    ).toBeVisible();
    await record('canonical-owner-restart-retained', {
      view: acknowledged,
      nativeLaunches: nativeSessions.length,
    });
    const [releasedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'release',
      ),
      publication().getByRole('button', { name: 'Release held leads', exact: true }).click(),
    ]);
    const released = TelosWorkControlViewSchema.parse(await releasedResponse.json());
    expect(released.stage).toBe('released');
    expect(released.publicationRevalidation).toBe('required');
    expect(released.history).toEqual(acknowledged.history);
    expect(await control(releasedResponse.request().postDataJSON())).toEqual(released);
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Hold released · revalidation required',
        exact: true,
      }),
    ).toBeVisible();
    await browserExpect(publication()).toContainText(
      'Completion is not confirmed by this receipt.',
    );
    expect(() =>
      canonical.work.assertControlAction(features[1].childId, 'publication', 'a'.repeat(40)),
    ).toThrow(/revalidation/i);
    await capture('publication-released-unvalidated');
    await record('publication-released-still-unvalidated', {
      released,
      limitation:
        'No connected/approved main action owner. Private denial ledger is not completed current-main publication qualification.',
    });
    const safe = await uiRequest('safe_point');
    const held = features[1];
    await page.goto(front.origin + '/chat/' + held.leadId);
    await composer.fill('New command refused at the declared safe point.');
    const beforeTurns = nativeSessions.map(
      (n) => n.rpc.request.mock.calls.filter(([m]) => m === 'turn/start').length,
    );
    const [refused] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/ordinary/workspaces/commands/continue') &&
          r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Queue message', exact: true }).click(),
    ]);
    const refusal = await refused.json();
    // Existing ordinary entry catch preserves a retained command as uncertain;
    // control application must be proved from the independently committed host
    // evidence, never inferred from this deliberately generic error text.
    expect(refused.status()).toBe(409);
    expect(refusal).toMatchObject({
      ok: false,
      code: 'retained_command',
      state: 'uncertain',
      sessionId: held.leadId,
    });
    expect(
      nativeSessions.map(
        (n) => n.rpc.request.mock.calls.filter(([m]) => m === 'turn/start').length,
      ),
    ).toEqual(beforeTurns);
    const applied = await control({ operation: 'read', controlId: safe.controlId });
    await record('safe-point-owner-checkpoint', {
      status: refused.status(),
      refusal,
      view: applied,
    });
    expect(applied.history).toHaveLength(1);
    expect(applied.history[0]).toMatchObject({
      itemId: held.itemId,
      conversationId: held.leadId,
      stage: 'applied',
      role: 'lead',
    });
    expect(applied.targets.find((t) => t.itemId === held.itemId)).toMatchObject({
      stage: 'acknowledged',
      workers: [{ stage: 'requested' }],
    });
    expect(
      applied.targets.filter((t) => t.itemId !== held.itemId).every((t) => t.stage === 'requested'),
    ).toBe(true);
    expect(applied.stage).toBe('requested');
    await record('actual-host-safe-point-denial-applied-one-recipient', {
      status: refused.status(),
      request: refused.request().postDataJSON(),
      view: applied,
    });
    await page.goto(front.origin + '/chat/' + coordinatorId);
    await safePoint().getByRole('button', { name: 'Check acknowledgements', exact: true }).click();
    await safePoint().getByText('Recorded control evidence', { exact: true }).click();
    await browserExpect(safePoint()).toContainText('host-denial:safe_point');
    await capture('real-host-applied-mixed-receipts');
    await safePoint().getByRole('button', { name: 'Release held leads', exact: true }).click();
    await browserExpect(
      safePoint().getByRole('heading', { name: 'Hold released', exact: true }),
    ).toBeVisible();
    canonical.restartOwners();
    // Reload resolves before the linked-role reads have hydrated this inbox.
    // Observe its actual retained response before starting the heading oracle;
    // keep the full-case and UI assertion bounds unchanged.
    const retainedInboxResponse = await observeNavigatedControlInbox(
      page,
      requested.coordinatorItemId,
      () => page.reload(),
    );
    expect(retainedInboxResponse.status).toBe(200);
    const retainedInbox = TelosWorkControlViewSchema.array().parse(retainedInboxResponse.body);
    expect(retainedInbox.find((receipt) => receipt.controlId === requested.controlId)).toEqual(
      released,
    );
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Hold released · revalidation required',
        exact: true,
      }),
    ).toBeVisible();
    expect(await control({ operation: 'read', controlId: requested.controlId })).toEqual(released);
    const releasedSafe = await control({ operation: 'read', controlId: safe.controlId });
    expect(releasedSafe.stage).toBe('released');
    expect(releasedSafe.publicationRevalidation).toBe('not_applicable');
    expect(retainedInbox.find((receipt) => receipt.controlId === safe.controlId)).toEqual(
      releasedSafe,
    );
    const desktopInboxResponse = await observeSurfaceControlInbox(
      page,
      requested.coordinatorItemId,
      '.desktop-chat-center',
      () => page.setViewportSize({ width: 1280, height: 900 }),
    );
    expect(desktopInboxResponse.status).toBe(200);
    const desktopInbox = TelosWorkControlViewSchema.array().parse(desktopInboxResponse.body);
    expect(desktopInbox).toEqual(retainedInbox);
    await record('browser-loaded-exact-desktop-released-inbox', { desktopInbox });
    await browserExpect(
      publication().getByRole('heading', {
        name: 'Hold released · revalidation required',
        exact: true,
      }),
    ).toBeVisible();
    await browserExpect(
      safePoint().getByRole('heading', { name: 'Hold released', exact: true }),
    ).toBeVisible();
    await capture('desktop-retained-two-distinct-scope-releases');
    // Additive desktop interaction only: reuse the already-proved native ACK
    // cycle and inspect real requested/read/released dispatch receipts here.
    const desktopRequested = await uiRequest('new_worker_dispatch');
    const dispatchReceipt = coordinatorRegion.getByRole('article', {
      name: 'Coordination receipt: New worker dispatch',
      exact: true,
    });
    await browserExpect(
      dispatchReceipt.getByRole('heading', {
        name: 'Hold requested · acknowledgements pending',
        exact: true,
      }),
    ).toBeVisible();
    const [desktopRead] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'read' &&
          r.request().postDataJSON().controlId === desktopRequested.controlId,
      ),
      dispatchReceipt.getByRole('button', { name: 'Check acknowledgements', exact: true }).click(),
    ]);
    expect(TelosWorkControlViewSchema.parse(await desktopRead.json())).toEqual(desktopRequested);
    await dispatchReceipt
      .getByRole('heading', { name: 'Hold requested · acknowledgements pending', exact: true })
      .scrollIntoViewIfNeeded();
    await capture('desktop-actual-dispatch-request-read');
    const [desktopReleaseResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith('/api/telos/work/controls') &&
          r.request().postDataJSON().operation === 'release' &&
          r.request().postDataJSON().controlId === desktopRequested.controlId,
      ),
      dispatchReceipt.getByRole('button', { name: 'Release held leads', exact: true }).click(),
    ]);
    const desktopReleased = TelosWorkControlViewSchema.parse(await desktopReleaseResponse.json());
    expect(desktopReleased).toMatchObject({
      stage: 'released',
      scope: 'new_worker_dispatch',
      publicationRevalidation: 'not_applicable',
      history: [],
    });
    await browserExpect(
      dispatchReceipt.getByRole('heading', { name: 'Hold released', exact: true }),
    ).toBeVisible();
    expect(() =>
      canonical.work.assertControlAction(features[1].childId, 'new_worker_dispatch'),
    ).not.toThrow();
    expect(await control({ operation: 'read', controlId: requested.controlId })).toEqual(released);
    await browserExpect(
      dispatchReceipt.getByRole('button', { name: 'Release held leads', exact: true }),
    ).toHaveCount(0);
    await dispatchReceipt
      .getByRole('heading', { name: 'Hold released', exact: true })
      .scrollIntoViewIfNeeded();
    await capture('desktop-actual-dispatch-released');
    await record('desktop-actual-request-read-release-no-extra-native', {
      desktopRequested,
      desktopReleased,
      nativeLaunches: nativeSessions.length,
    });

    expect(chat.eventStore.listSessions()).toHaveLength(sessionCount);
    expect(nativeSessions).toHaveLength(11);
    for (const native of nativeSessions) {
      expect(native.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1);
      expect(native.rpc.request.mock.calls.filter(([m]) => m === 'turn/interrupt')).toHaveLength(0);
    }
    expect(h.pageErrors).toEqual([]);
    await record('completed-bounded-journey', {
      requested,
      acknowledged,
      released,
      applied,
      releasedSafe,
      sessionCount,
      remaining:
        'Actual main-publication/revalidation owner and accepted-main/fullUX/device/live gates pending. Canonical-owner restart only, not server/nativeprocess restart. No model/providercalls.',
    });
  } finally {
    await save();
  }
  // The retained a19 CI180s RED had all eleven native ACKs; complete local
  // owner/permission/safe-point/release execution takes81s and observed CI paths
  // run roughly3x slower. This5min harness bound retains every original oracle;
  // it is not a product latency allowance or a retry of a failed assertion.
}, 300_000);
