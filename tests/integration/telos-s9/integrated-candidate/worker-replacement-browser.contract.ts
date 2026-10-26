import { it, expect } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createWorkerReplacementProcessFixture } from './worker-replacement-process-fixture';
import { openChatSetting, chooseSetting, chooseAgent } from '../../../support/chat-settings';

it('keeps an additional worker distinct from explicit replacement and retains the original delegation receipt across App restart', async () => {
  const h = await createWorkerReplacementProcessFixture();
  const { page, front, api, ordinary, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'worker-replacement-observations.json'),
        JSON.stringify(
          { observations, pageErrors: h.pageErrors, realProviderModelCalls: 0 },
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
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  const fillDraft = async (text: string) => {
    await composer.fill(text);
    await browserExpect(composer).toHaveValue(text);
  };
  const workerRow = (label: string) =>
    page.locator('.telos-chat-row').filter({ has: page.getByText(label, { exact: true }) });
  const chooserRows: Array<Record<string, unknown>> = [];
  const configure = async (label: string) => {
    await browserExpect(
      page.getByRole('region', { name: 'Work conversation setup', exact: true }),
    ).toBeVisible();
    await openChatSetting(page, 'execution');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Account', 'ordinary-personal');
    await chooseSetting(page, 'Model', 'fixture-model');
    await chooseSetting(page, 'Thinking level', 'low');
    await chooseAgent(page, JSON.stringify(['saved', 'ordinary-worker', 1]));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
    await capture(
      label === 'Start chat'
        ? 'actual-additional-worker-reviewed-setup'
        : 'actual-replacement-worker-reviewed-setup',
    );
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/telos/work/roles/ordinary/setup-reviewed'),
      ),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    const submitted = response.request().postDataJSON(),
      body = await response.json();
    await record('actual-worker-reviewed-setup-response', {
      label,
      status: response.status(),
      submitted,
      body,
    });
    expect(response.status()).toBe(200);
    await browserExpect(page).toHaveURL(/\/chat\/[a-f0-9-]+/);
    // A changed URL precedes BrowserRouter's committed conversation render.
    await browserExpect(
      page.getByRole('region', { name: 'Work conversation setup', exact: true }),
    ).not.toBeVisible();
    return { id: new URL(page.url()).pathname.split('/').at(-1)!, submitted, body };
  };
  const chooser = async () => {
    await page.getByRole('button', { name: /^Chats for this item: / }).click();
    expect(new URL(page.url()).pathname).toBe('/todos/recording-slice');
  };
  try {
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
    const setupLead = async (itemId: string) => {
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
    const leadId = await setupLead('studio'),
      peerId = await setupLead('quiet-job');
    await api.execute({
      operation: 'classify',
      itemId: 'recording-slice',
      kind: 'work_item',
      requestId: randomUUID(),
      expectedRevision: (await api.read('recording-slice')).revision,
    });
    const reviewed = await api.reviewRoleContext({
      itemId: 'recording-slice',
      role: 'worker',
      sourceSnapshotIds: [],
      artifactRefs: [],
    });
    const delegation = {
      version: 2 as const,
      requestId: randomUUID(),
      leadItemId: 'studio',
      childItemId: 'recording-slice',
      leadConversationId: leadId,
      expectedRevision: reviewed.selection.brief.revision,
      mode: 'start' as const,
      predecessorAttemptId: null,
      settings,
      contextSelection: reviewed.selection,
    };
    const allocation = await api.delegateOrdinarySlice(delegation),
      originalId = allocation.workerConversationId,
      taskId = allocation.attempt.executionTaskId!;
    const delegatedWork = await api.read('recording-slice');
    expect(delegatedWork.assignments).toEqual([]);
    // Existing guarded operator command, not a DB seed or inferred assignment.
    // Allocation links the reviewed worker; explicitly selecting it as current is separate.
    const initialAssignmentRequest = {
      operation: 'assign' as const,
      itemId: 'recording-slice',
      role: 'worker' as const,
      conversationId: originalId,
      requestId: randomUUID(),
      expectedRevision: delegatedWork.revision,
      expectedAssignmentRevision: 0,
    };
    const initialAssignment = await api.execute(initialAssignmentRequest);
    await record('actual-linked-worker-explicitly-assigned-through-guarded-owner', {
      allocation,
      chooserRows,
      delegatedWork,
      initialAssignmentRequest,
      initialAssignment,
    });
    const original = await h.snapshot(originalId, 'never-admitted'),
      workOriginal = await api.read('recording-slice'),
      parentBefore = await api.read('studio'),
      peerBefore = await api.read('quiet-job');
    expect(original.executionBindings).toMatchObject([
      {
        taskId,
        binding: {
          attemptId: allocation.attempt.attemptId,
          workerConversationId: originalId,
          leadConversationId: leadId,
        },
      },
    ]);
    expect(workOriginal.assignments).toMatchObject([
      { role: 'worker', revision: 1, conversation: { conversationId: originalId } },
    ]);
    await page.goto(front.origin + '/chat/' + peerId);
    await fillDraft('Keep the unrelated item draft through worker replacement.');
    await page.goto(front.origin + '/chat/' + leadId);
    await fillDraft(
      'Keep the lead planning draft; replacing a worker is not a new delegation attempt.',
    );
    await page.goto(front.origin + allocation.workerPath);
    await fillDraft('Keep the original delegated worker draft.');
    await chooser();
    await browserExpect(
      page.getByRole('heading', { name: 'Chats · 1', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const additional = await configure('Start chat');
    expect(additional.submitted.input.role).toBe('worker');
    expect(additional.submitted.input.expectedAssignmentRevision).toBeNull();
    const afterAdditional = await api.read('recording-slice');
    expect(afterAdditional.assignments).toEqual(workOriginal.assignments);
    expect(afterAdditional.attempts).toEqual(workOriginal.attempts);
    await fillDraft('Keep the additional worker draft without assigning it.');
    await chooser();
    await browserExpect(
      page.getByRole('heading', { name: 'Chats · 2', exact: true }),
    ).toBeVisible();
    await browserExpect(workerRow('Assigned worker')).toHaveCount(1);
    await browserExpect(workerRow('Additional worker')).toHaveCount(1);
    await capture('additional-worker-does-not-replace-current');
    await page.getByRole('button', { name: 'Change worker', exact: true }).click();
    const replacement = await configure('Assign worker & open chat');
    expect(replacement.submitted.input.role).toBe('worker');
    expect(replacement.submitted.input.expectedAssignmentRevision).toBe(1);
    await fillDraft('Keep the explicitly assigned replacement draft.');
    const replaced = await api.read('recording-slice');
    expect(replaced.assignments).toMatchObject([
      { role: 'worker', revision: 2, conversation: { conversationId: replacement.id } },
    ]);
    expect(replaced.attempts).toEqual(workOriginal.attempts);
    expect(new Set([originalId, additional.id, replacement.id]).size).toBe(3);
    expect(
      replaced.links
        .filter((x) => x.role === 'worker')
        .map((x) => x.conversation.conversationId)
        .sort(),
    ).toEqual([originalId, additional.id, replacement.id].sort());
    const entries = [
      {
        id: originalId,
        label: 'Previous conversation',
        draft: 'Keep the original delegated worker draft.',
      },
      {
        id: additional.id,
        label: 'Additional worker',
        draft: 'Keep the additional worker draft without assigning it.',
      },
      {
        id: replacement.id,
        label: 'Assigned worker',
        draft: 'Keep the explicitly assigned replacement draft.',
      },
    ];
    await chooser();
    const checkChooserAndDrafts = async () => {
      await browserExpect(
        page.getByRole('heading', { name: 'Chats · 3', exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/todos/recording-slice');
      for (const entry of entries) {
        const row = workerRow(entry.label);
        await browserExpect(row).toHaveCount(1);
        chooserRows.push({
          expectedId: entry.id,
          label: entry.label,
          text: await row.innerText(),
          accessibleName: await row.getAttribute('aria-label'),
        });
        await row.click();
        await browserExpect(page).toHaveURL(new RegExp('/chat/' + entry.id));
        await browserExpect(composer).toHaveValue(entry.draft);
        await chooser();
      }
    };
    await checkChooserAndDrafts();
    await capture('three-distinct-worker-labels-after-explicit-replacement');
    const snapshots = [];
    for (const entry of entries) snapshots.push(await h.snapshot(entry.id, 'never-admitted'));
    expect(new Set(snapshots.map((x) => x.session.cwd)).size).toBe(3);
    expect(new Set(snapshots.map((x) => x.session.ordinaryWorkspaceId)).size).toBe(3);
    for (const snapshot of snapshots) {
      expect(snapshot.roleContext).toMatchObject({
        itemId: 'recording-slice',
        role: 'worker',
        leadConversationId: leadId,
      });
      expect(snapshot.nativeOwnerObservation).toBe('not_read_no_native_admission');
    }
    expect(snapshots[0].executionBindings).toEqual(original.executionBindings);
    expect(snapshots[0].events).toEqual(original.events);
    const taskBefore = (await (await h.http('/api/tasks/' + taskId)).json()).task;
    expect(taskBefore.status).toBe('pending');
    expect(taskBefore.completedAt).toBeNull();
    await record('actual-worker-additional-versus-replacement-before-restart', {
      allocation,
      delegation,
      original,
      workOriginal,
      additional,
      afterAdditional,
      replacement,
      replaced,
      entries,
      snapshots,
      taskBefore,
      leadId,
      peerId,
      parentBefore,
      peerBefore,
      effects: await h.effects(),
    });
    await h.crash();
    const cold = await h.restart();
    expect(cold.pid).not.toBe(h.initialReady.pid);
    expect(cold.statePaths).toEqual(h.initialReady.statePaths);
    expect(cold.authId).toBe(h.initialReady.authId);
    await page.reload();
    await checkChooserAndDrafts();
    await capture('three-worker-chats-drafts-and-current-assignment-after-app-restart');
    const afterCold = await api.read('recording-slice');
    expect(afterCold).toEqual(replaced);
    const replay = await api.delegateOrdinarySlice(delegation);
    expect(replay).toEqual(allocation);
    expect(await api.read('recording-slice')).toEqual(replaced);
    const afterSnapshots = [];
    for (const entry of entries) afterSnapshots.push(await h.snapshot(entry.id, 'never-admitted'));
    for (let i = 0; i < snapshots.length; i++) {
      expect(afterSnapshots[i].workspace).toEqual(snapshots[i].workspace);
      expect(afterSnapshots[i].roleContext).toEqual(snapshots[i].roleContext);
      expect(afterSnapshots[i].events).toEqual(snapshots[i].events);
      expect(afterSnapshots[i].nativeOwnerObservation).toBe('not_read_no_native_admission');
      expect(afterSnapshots[i].executionBindings).toEqual(snapshots[i].executionBindings);
    }
    expect((await (await h.http('/api/tasks/' + taskId)).json()).task).toEqual(taskBefore);
    expect(await api.read('studio')).toEqual(parentBefore);
    expect(await api.read('quiet-job')).toEqual(peerBefore);
    await page.goto(front.origin + '/chat/' + leadId);
    await browserExpect(composer).toHaveValue(
      'Keep the lead planning draft; replacing a worker is not a new delegation attempt.',
    );
    await page.goto(front.origin + '/chat/' + peerId);
    await browserExpect(composer).toHaveValue(
      'Keep the unrelated item draft through worker replacement.',
    );
    const effects = await h.effects();
    expect(effects.every((e) => e.kind === 'preflight.close')).toBe(true);
    expect(
      effects.filter(
        (e) => e.kind === 'native.launch' || e.kind === 'turn/start' || e.kind === 'thread/start',
      ),
    ).toEqual([]);
    expect(h.pageErrors).toEqual([]);
    await record('complete-actual-worker-replacement-and-historical-allocation-replay', {
      chooserRows,
      delegatedWork,
      initialAssignmentRequest,
      initialAssignment,
      allocation,
      replay,
      delegation,
      original,
      workOriginal,
      additional,
      afterAdditional,
      replacement,
      replaced,
      afterCold,
      entries,
      snapshots,
      afterSnapshots,
      taskBefore,
      leadId,
      peerId,
      parentBefore,
      peerBefore,
      cold,
      initialReady: h.initialReady,
      lifecycle: h.lifecycle,
      effects,
      limitations:
        'Actual worker-role Newchat versus Change worker, retained original provision-only delegation and task/context/drafts across App restart. No native inference or provider terminal, assistant history, canonical native artifact save, task completion/outcome verification/fullUX/main/live claim.',
    });
  } catch (error) {
    await capture('actual-failure-boundary').catch(() => {});
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
