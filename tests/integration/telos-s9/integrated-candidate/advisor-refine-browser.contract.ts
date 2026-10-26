import { it, expect, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createAdvisorChildProcessFixture } from './advisor-child-process-fixture';
import { openChatSetting, chooseSetting, chooseAgent } from '../../../support/chat-settings';

it('refines the same existing work item through its normal advisor and reviewed proposal UI, preserving exact source return across App restart', async () => {
  const h = await createAdvisorChildProcessFixture();
  const { page, front, api, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'advisor-refine-observations.json'),
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
  const workspace = page.locator('.telos-item-workspace');
  const composer = page.getByRole('textbox', { name: 'Message Mitzo', exact: true });
  const proposal = page.getByRole('region', { name: 'Advisor proposal', exact: true });
  try {
    await api.execute({
      operation: 'classify',
      itemId: 'studio',
      kind: 'outcome',
      requestId: randomUUID(),
      expectedRevision: (await api.read('studio')).revision,
    });
    await api.execute({
      operation: 'classify',
      itemId: 'recording-slice',
      kind: 'work_item',
      requestId: randomUUID(),
      expectedRevision: (await api.read('recording-slice')).revision,
    });
    const parentBefore = await api.readRecord('studio'),
      parentWorkBefore = await api.read('studio'),
      itemBefore = await api.readRecord('recording-slice'),
      quietBefore = await api.readRecord('quiet-job'),
      workBefore = await api.read('recording-slice');
    expect(workBefore.sources).toEqual([]);
    expect(workBefore.assignments).toEqual([]);
    await page.goto(front.origin + '/todos/studio');
    await browserExpect(
      workspace.getByRole('heading', { name: 'Home studio', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await workspace.getByRole('link', { name: /^Acoustic plan ·/ }).click();
    await browserExpect(page.locator('.viewer-content')).toContainText(
      'The reviewed panel layout.',
    );
    await capture('actual-existing-material-inspection-before-advisor');
    await page.locator('.viewer-header').getByRole('button', { name: 'Back', exact: true }).click();
    await browserExpect(
      workspace.getByRole('heading', { name: 'Home studio', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.goto(front.origin + '/todos/recording-slice');
    await browserExpect(
      workspace.getByRole('heading', { name: itemBefore.summary, exact: true }),
    ).toBeVisible();
    await workspace.getByRole('button', { name: 'Refine item', exact: true }).click();
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
    await browserExpect(
      page.getByRole('button', { name: 'Start chat', exact: true }),
    ).toBeEnabled();
    const setup = page.getByRole('region', { name: 'Work conversation setup', exact: true });
    await setup.getByText('Linked work context', { exact: true }).click();
    const setupContext = setup
      .locator('details')
      .filter({ has: page.getByText('Linked work context', { exact: true }) });
    await browserExpect(setupContext).toContainText('Record music');
    await browserExpect(setupContext).toContainText('Approved plan');
    await browserExpect(setupContext).toContainText(itemBefore.summary);
    await browserExpect(setupContext).toContainText(itemBefore.intent);
    await browserExpect(setupContext).toContainText('Exact smallest child only');
    await browserExpect(setupContext).toContainText('Retain sample evidence');
    await capture('actual-refine-reviewed-item-parent-goal-setup');
    const [setupResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/telos/work/roles/ordinary/setup-reviewed'),
      ),
      page.getByRole('button', { name: 'Start chat', exact: true }).click(),
    ]);
    const setupSubmitted = setupResponse.request().postDataJSON(),
      setupBody = await setupResponse.json();
    await record('actual-ui-advisor-setup-response', {
      status: setupResponse.status(),
      setupSubmitted,
      setupBody,
    });
    expect(setupResponse.status()).toBe(200);
    await browserExpect(page).toHaveURL(/\/chat\/[a-f0-9-]+/);
    const advisorId = new URL(page.url()).pathname.split('/').at(-1)!;
    const initial = await h.snapshot(advisorId, 'not-yet-admitted');
    expect(initial.roleContext).toMatchObject({
      itemId: 'recording-slice',
      role: 'advisor',
      advisorPurpose: 'refine',
      overallGoal: { itemId: 'studio', text: 'Record music' },
    });
    expect(initial.roleContext?.parentCriteria).toEqual([
      {
        itemId: 'studio',
        revision: parentWorkBefore.revision,
        criteria: parentBefore.acceptanceCriteria,
      },
    ]);
    expect(JSON.parse(initial.roleContext!.brief.text)).toMatchObject({
      summary: itemBefore.summary,
      intent: itemBefore.intent,
      rationale: itemBefore.rationale,
      acceptanceCriteria: itemBefore.acceptanceCriteria,
    });
    expect(initial.roleContext?.sources).toEqual([]);
    expect(initial.roleContext?.artifacts).toEqual([]);
    const roleSourcesBeforeSave = await api.read('recording-slice');
    const linkedBrief = page
      .locator('details')
      .filter({ has: page.getByText('Linked brief · goal & parent context', { exact: true }) });
    await linkedBrief.locator('summary').click();
    await browserExpect(linkedBrief).toContainText('Record music');
    await browserExpect(linkedBrief).toContainText('Approved plan');
    await browserExpect(linkedBrief).toContainText('Retain sample evidence');
    await browserExpect(linkedBrief).toContainText(itemBefore.summary);
    await capture('actual-refine-normal-chat-reviewed-linked-brief');
    await record('actual-retained-item-parent-goal-context', {
      initial,
      parentBefore,
      parentWorkBefore,
      itemBefore,
      workBefore,
      roleSourcesBeforeSave,
      selectedSourceSnapshots: 0,
      selectedMaterialPins: 0,
      contextPickerAvailableInRoleSetup: false,
    });
    await linkedBrief.locator('summary').click();
    expect(initial.runtimeBinding).toEqual(setupSubmitted.input.settings.binding);
    expect(initial.runtimeBinding).toBeTruthy();
    expect(initial.session.agentProfile).toEqual(f.agentProfile);
    expect(initial.session.agentProfile).toBeTruthy();
    expect(initial.tasks).toEqual([]);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toEqual([]);
    const userText =
      'Refine Record one acoustic sample against Home studio and its Approved plan: retain one reviewed sample with documented listening notes. Do not create a child or dispatch a worker.';
    const assistantText =
      'Agreed refinement: Review one acoustic sample. Desired outcome: retain one reviewed sample and its listening notes against the approved studio plan. Update this existing item only; do not create a child or start a worker.';
    await h.waitForPreparedConversation(advisorId);
    await composer.fill(userText);
    const [sendResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    const command = sendResponse.request().postDataJSON(),
      firstReceipt = await sendResponse.json();
    expect(sendResponse.status()).toBe(202);
    expect(firstReceipt).toMatchObject({
      sessionId: advisorId,
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
    const providerInputs = await h.providerReply(assistantText);
    await browserExpect(
      page.getByText('Agreed refinement:', { exact: false }).first(),
    ).toBeVisible();
    const transcriptPath = '/api/sessions/' + advisorId + '/messages?transcript=1';
    let completedTranscript: Record<string, unknown> | undefined;
    await vi.waitFor(async () => {
      const response = await h.http(transcriptPath);
      expect(response.status).toBe(200);
      const history = await response.json();
      expect(history.current).toBeNull();
      expect(history.currents ?? []).toEqual([]);
      expect(history.messages.length).toBeGreaterThan(0);
      expect(history.messages.at(-1).completedSeq).toBeGreaterThan(0);
      expect(JSON.stringify(history)).toContain(userText);
      expect(JSON.stringify(history)).toContain(assistantText);
      completedTranscript = history;
    });
    await browserExpect(
      proposal.getByRole('button', { name: 'Propose refinement', exact: true }),
    ).toBeEnabled();
    await capture('actual-refine-normal-advisor-completed-exchange');
    await proposal.getByRole('button', { name: 'Propose refinement', exact: true }).click();
    await browserExpect(
      proposal.getByRole('heading', { name: 'Proposed item refinement', exact: true }),
    ).toBeVisible();
    await browserExpect(proposal.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
      itemBefore.summary,
    );
    await browserExpect(
      proposal.getByRole('textbox', { name: 'Desired outcome', exact: true }),
    ).toHaveValue(itemBefore.intent);
    await browserExpect(
      proposal.getByRole('textbox', { name: 'Category', exact: true }),
    ).toHaveValue(itemBefore.categories[0] ?? '');
    await browserExpect(
      proposal.getByRole('combobox', { name: 'Item type', exact: true }),
    ).toHaveCount(0);
    const name = 'Review one acoustic sample',
      desiredOutcome =
        'Retain one reviewed sample and its listening notes against the approved studio plan.';
    await proposal.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await proposal
      .getByRole('textbox', { name: 'Desired outcome', exact: true })
      .fill(desiredOutcome);
    await proposal.getByRole('textbox', { name: 'Category', exact: true }).fill('Music');
    await capture('actual-operator-reviewed-refinement-proposal-card');
    const [previewResponse, savedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/preview'),
      ),
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/save'),
      ),
      proposal.getByRole('button', { name: 'Save refinement', exact: true }).click(),
    ]);
    const previewSubmitted = previewResponse.request().postDataJSON(),
      previewBody = await previewResponse.json(),
      savedSubmitted = savedResponse.request().postDataJSON(),
      savedBody = await savedResponse.json();
    await record('actual-proposal-ui-preview-and-save-responses', {
      previewStatus: previewResponse.status(),
      previewSubmitted,
      previewBody,
      saveStatus: savedResponse.status(),
      savedSubmitted,
      savedBody,
      advisorId,
      command,
      firstReceipt,
      providerInputs,
      completedTranscript,
    });
    expect(previewResponse.status()).toBe(200);
    expect(savedResponse.status()).toBe(200);
    expect(savedSubmitted).toMatchObject({
      operation: 'refine',
      itemId: 'recording-slice',
      parentId: 'studio',
      advisorConversationId: advisorId,
      proposed: { name, desiredOutcome, type: 'work_item', category: 'Music' },
      selection: { sourceConversationId: advisorId, mode: 'conversation_so_far' },
      previewSha256: previewBody.sha256,
    });
    expect(previewSubmitted.expectedRevision).toBe(roleSourcesBeforeSave.revision);
    expect(previewSubmitted.expectedParentRevision).toBe(parentWorkBefore.revision);
    expect(savedSubmitted.selection.artifacts).toEqual([]);
    const last = (
      completedTranscript as { messages: Array<{ messageId: string; completedSeq: number }> }
    ).messages.at(-1)!;
    expect(savedSubmitted.selection.boundary).toEqual({
      messageId: last.messageId,
      sequence: last.completedSeq,
    });
    const itemId = savedBody.work.itemId;
    expect(itemId).toBe('recording-slice');
    await browserExpect(page).toHaveURL(new RegExp('/todos/' + itemId));
    await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    const itemRecord = await api.readRecord(itemId),
      itemWork = await api.read(itemId);
    expect(itemRecord).toMatchObject({
      itemId: itemId,
      kind: 'work_item',
      parentId: 'studio',
      summary: name,
      intent: desiredOutcome,
      status: 'active',
      categories: ['Music'],
    });
    expect(itemRecord.createdAt).toBe(itemBefore.createdAt);
    expect(itemRecord.createdAt).toBeTruthy();
    expect(itemRecord.updatedAt).not.toBe(itemBefore.updatedAt);
    for (const field of [
      'kind',
      'parentId',
      'rationale',
      'acceptanceCriteria',
      'profile',
      'status',
      'starred',
      'priority',
      'contextHints',
    ] as const)
      expect(itemRecord[field]).toEqual(itemBefore[field]);
    const priorLegacy = { ...(itemBefore.legacyFields.item as Record<string, unknown>) },
      currentLegacy = { ...(itemRecord.legacyFields.item as Record<string, unknown>) };
    for (const field of ['summary', 'intent', 'categories', 'updated_at']) {
      delete priorLegacy[field];
      delete currentLegacy[field];
    }
    expect(currentLegacy).toEqual(priorLegacy);
    expect(itemWork.assignments).toEqual([]);
    expect(itemWork.attempts).toEqual([]);
    expect(itemWork.links.filter((l) => l.role === 'worker' || l.role === 'lead')).toEqual([]);
    expect(itemWork.sources).toHaveLength(1);
    expect(await api.readRecord('studio')).toEqual(parentBefore);
    expect(await api.read('studio')).toEqual(parentWorkBefore);
    expect(await api.readRecord('quiet-job')).toEqual(quietBefore);
    const source = await api.readSource(itemId, itemWork.sources[0].snapshotId);
    expect(source.available).toBe(true);
    if (!source.available || !source.packet)
      throw Error('Actual retained advisor source unavailable');
    expect(source.snapshot.source).toMatchObject({ namespace: 'mitzo', conversationId: advisorId });
    expect(source.packet.selection.sourceConversationId).toBe(advisorId);
    expect(source.packet.selection).toEqual(savedSubmitted.selection);
    expect(source.packet.context.artifacts).toEqual([]);
    expect(source.snapshot.itemId).toBe('recording-slice');
    expect(JSON.stringify(source.packet)).toContain(userText);
    expect(JSON.stringify(source.packet)).toContain(assistantText);
    const afterSave = await h.snapshot(advisorId, command.clientMsgId);
    expect(afterSave.runtimeBinding).toEqual(initial.runtimeBinding);
    expect(afterSave.session.agentProfile).toEqual(f.agentProfile);
    expect(afterSave.tasks).toEqual([]);
    expect((await api.readRecord('studio')).legacyFields.item).toEqual(
      parentBefore.legacyFields.item,
    );
    expect((await api.read('studio')).assignments).toEqual([]);
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await browserExpect(
      workspace.getByRole('button', { name: 'Open original chat', exact: true }),
    ).toBeVisible();
    await capture('refined-item-retains-exact-advisor-source');
    const inspectSourceReturn = async (phase: string) => {
      await workspace.getByRole('button', { name: 'Open original chat', exact: true }).click();
      await browserExpect(page).toHaveURL(new RegExp('/chat/' + advisorId));
      expect(new URL(page.url()).searchParams.get('telosSource')).toBe(source.snapshot.snapshotId);
      await browserExpect(
        page.getByText('Agreed refinement:', { exact: false }).first(),
      ).toBeVisible();
      await browserExpect(proposal.getByRole('link', { name, exact: true })).toBeVisible();
      await capture('actual-refine-originating-advisor-exchange-and-item-backlink-' + phase);
      await page.getByRole('link', { name: 'Back', exact: true }).click();
      await browserExpect(page).toHaveURL(new RegExp('/todos/' + itemId));
      await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    };
    await inspectSourceReturn('before-restart');
    await h.crash();
    const cold = await h.restart();
    expect(cold.pid).not.toBe(h.initialReady.pid);
    expect(cold.statePaths).toEqual(h.initialReady.statePaths);
    expect(cold.authId).toBe(h.initialReady.authId);
    await page.reload();
    await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await inspectSourceReturn('after-restart');
    expect(await api.readRecord(itemId)).toEqual(itemRecord);
    expect(await api.read(itemId)).toEqual(itemWork);
    expect(await api.readSource(itemId, source.snapshot.snapshotId)).toEqual(source);
    expect(await api.readRecord('studio')).toEqual(parentBefore);
    expect(await api.read('studio')).toEqual(parentWorkBefore);
    expect(await api.readRecord('quiet-job')).toEqual(quietBefore);
    const afterRestart = await h.snapshot(advisorId, command.clientMsgId);
    expect(afterRestart.runtimeBinding).toEqual(initial.runtimeBinding);
    expect(afterRestart.session.agentProfile).toEqual(f.agentProfile);
    expect(afterRestart.tasks).toEqual([]);
    await record('actual-after-restart-source-and-runtime-readback', {
      initial,
      afterSave,
      afterRestart,
      itemRecord,
      itemWork,
      source,
      cold,
    });
    // Completion/recovery may append an actual idle lifecycle event. Preserve
    // every prior event exactly; no new content/source/terminal is permitted here.
    expect(afterRestart.events.slice(0, afterSave.events.length)).toEqual(afterSave.events);
    const appendedLifecycle = afterRestart.events.slice(afterSave.events.length);
    for (const event of appendedLifecycle)
      expect(event).toMatchObject({
        sessionId: advisorId,
        type: 'session_state_changed',
        payload: { sessionId: advisorId, internalState: 'ENDED', state: 'idle' },
      });
    const effects = await h.effects();
    expect(effects.filter((e) => e.kind === 'native.launch')).toHaveLength(1);
    expect(effects.filter((e) => e.kind === 'turn/start')).toHaveLength(1);
    expect(
      effects.filter(
        (e) => e.kind === 'provider.notification.input' && e.method === 'turn/completed',
      ),
    ).toHaveLength(1);
    expect(h.pageErrors).toEqual([]);
    await record('complete-normal-advisor-refine-ui-save-source-return', {
      advisorId,
      itemId,
      parentBefore,
      parentWorkBefore,
      itemBefore,
      quietBefore,
      workBefore,
      roleSourcesBeforeSave,
      setupSubmitted,
      setupBody,
      initial,
      command,
      firstReceipt,
      providerInputs,
      completedTranscript,
      previewSubmitted,
      previewBody,
      savedSubmitted,
      savedBody,
      itemRecord,
      itemWork,
      source,
      afterSave,
      afterRestart,
      appendedLifecycle,
      cold,
      initialReady: h.initialReady,
      lifecycle: h.lifecycle,
      effects,
      limits:
        'Real existing-item Refine entry/operator proposal UI preview/save, completed advisor transcript and exact source-return/Apprestart. Item,parentcriteria,overallgoal inspected in actual setup/chat linkedbrief; parent material inspected through actual Files. Baseline reviewed sources/materialpins EMPTY, role setup has no source/material picker; no selection/adoption/materialinheritance claim. External native message/completion simulated; actual owner projections. Same item/parent/kind/profile/createdAt/unknown fields retained; no workerdispatch/task/outcomecompletion/nativecanonicalartifactsave/live/fullUX/main claim. Negative/stale/nonempty source/material and deeper-ancestor variants pending.',
    });
  } catch (error) {
    await capture('actual-failure-boundary').catch(() => {});
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
