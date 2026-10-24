import { it, expect, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createAdvisorChildProcessFixture } from './advisor-child-process-fixture';
import { openChatSetting, chooseSetting, chooseAgent } from '../../../support/chat-settings';

it('saves a child through a normal advisor planning exchange and actual proposal UI, then returns to its exact source after restart', async () => {
  const h = await createAdvisorChildProcessFixture();
  const { page, front, api, f } = h;
  const observations: Array<Record<string, unknown>> = [];
  const save = async () => {
    if (process.env.S9_JOINED_SCREENSHOT_DIR)
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'advisor-child-observations.json'),
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
    const parentBefore = await api.readRecord('studio'),
      workBefore = await api.read('studio');
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
    await workspace.getByRole('button', { name: 'Add child with advisor', exact: true }).click();
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
    await capture('actual-normal-child-advisor-reviewed-setup');
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
      itemId: 'studio',
      role: 'advisor',
      advisorPurpose: 'child',
      overallGoal: { itemId: 'studio', text: 'Record music' },
    });
    expect(initial.runtimeBinding).toEqual(setupSubmitted.input.settings.binding);
    expect(initial.runtimeBinding).toBeTruthy();
    expect(initial.session.agentProfile).toEqual(f.agentProfile);
    expect(initial.session.agentProfile).toBeTruthy();
    expect(initial.tasks).toEqual([]);
    expect((await h.effects()).filter((e) => e.kind === 'native.launch')).toEqual([]);
    const userText =
      'Help me plan one child for Home studio: review the acoustic panel layout. Do not dispatch any worker.';
    const assistantText =
      'Agreed draft: Review acoustic panels. Desired outcome: a reviewed panel placement plan linked to Home studio. This is a planning draft; do not start a worker.';
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
    await browserExpect(page.getByText('Agreed draft:', { exact: false }).first()).toBeVisible();
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
      proposal.getByRole('button', { name: 'Suggest a draft', exact: true }),
    ).toBeEnabled();
    await capture('actual-normal-advisor-completed-planning-exchange');
    await proposal.getByRole('button', { name: 'Suggest a draft', exact: true }).click();
    const name = 'Review acoustic panels',
      desiredOutcome = 'A reviewed panel placement plan linked to Home studio.';
    await proposal
      .getByRole('combobox', { name: 'Item type', exact: true })
      .selectOption('work_item');
    await proposal.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await proposal
      .getByRole('textbox', { name: 'Desired outcome', exact: true })
      .fill(desiredOutcome);
    await proposal.getByRole('textbox', { name: 'Category', exact: true }).fill('Music');
    await capture('actual-operator-reviewed-child-proposal-card');
    const [previewResponse, savedResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/preview'),
      ),
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/api/telos/work/advisor/save'),
      ),
      proposal.getByRole('button', { name: 'Save child draft', exact: true }).click(),
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
      operation: 'child',
      itemId: 'studio',
      parentId: 'studio',
      advisorConversationId: advisorId,
      proposed: { name, desiredOutcome, type: 'work_item', category: 'Music' },
      selection: { sourceConversationId: advisorId, mode: 'conversation_so_far' },
      previewSha256: previewBody.sha256,
    });
    const childId = savedBody.work.itemId;
    expect(childId).not.toBe('studio');
    await browserExpect(page).toHaveURL(new RegExp('/todos/' + childId));
    await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    const childRecord = await api.readRecord(childId),
      childWork = await api.read(childId);
    expect(childRecord).toMatchObject({
      itemId: childId,
      kind: 'work_item',
      parentId: 'studio',
      summary: name,
      intent: desiredOutcome,
      status: 'active',
      categories: ['Music'],
    });
    expect(childWork.assignments).toEqual([]);
    expect(childWork.attempts).toEqual([]);
    expect(childWork.links.filter((l) => l.role === 'worker' || l.role === 'lead')).toEqual([]);
    expect(childWork.sources).toHaveLength(1);
    const source = await api.readSource(childId, childWork.sources[0].snapshotId);
    expect(source.available).toBe(true);
    if (!source.available || !source.packet)
      throw Error('Actual retained advisor source unavailable');
    expect(source.snapshot.source).toMatchObject({ namespace: 'mitzo', conversationId: advisorId });
    expect(source.packet.selection.sourceConversationId).toBe(advisorId);
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
    await capture('created-child-retains-actual-advisor-source');
    const inspectSourceReturn = async () => {
      await workspace.getByRole('button', { name: 'Open original chat', exact: true }).click();
      await browserExpect(page).toHaveURL(new RegExp('/chat/' + advisorId));
      expect(new URL(page.url()).searchParams.get('telosSource')).toBe(source.snapshot.snapshotId);
      await browserExpect(page.getByText('Agreed draft:', { exact: false }).first()).toBeVisible();
      await browserExpect(proposal.getByRole('link', { name, exact: true })).toBeVisible();
      await capture('actual-originating-advisor-exchange-and-child-backlink');
      await page.getByRole('link', { name: 'Back', exact: true }).click();
      await browserExpect(page).toHaveURL(new RegExp('/todos/' + childId));
      await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    };
    await inspectSourceReturn();
    await h.crash();
    const cold = await h.restart();
    expect(cold.pid).not.toBe(h.initialReady.pid);
    expect(cold.statePaths).toEqual(h.initialReady.statePaths);
    expect(cold.authId).toBe(h.initialReady.authId);
    await page.reload();
    await browserExpect(workspace.getByRole('heading', { name, exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: 'Materials', exact: true }).click();
    await inspectSourceReturn();
    expect(await api.readRecord(childId)).toEqual(childRecord);
    expect(await api.read(childId)).toEqual(childWork);
    expect(await api.readSource(childId, source.snapshot.snapshotId)).toEqual(source);
    const afterRestart = await h.snapshot(advisorId, command.clientMsgId);
    expect(afterRestart.runtimeBinding).toEqual(initial.runtimeBinding);
    expect(afterRestart.session.agentProfile).toEqual(f.agentProfile);
    expect(afterRestart.tasks).toEqual([]);
    await record('actual-after-restart-source-and-runtime-readback', {
      initial,
      afterSave,
      afterRestart,
      childRecord,
      childWork,
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
    await record('complete-normal-advisor-child-ui-save-source-return', {
      advisorId,
      childId,
      parentBefore,
      workBefore,
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
      childRecord,
      childWork,
      source,
      afterSave,
      afterRestart,
      appendedLifecycle,
      cold,
      initialReady: h.initialReady,
      lifecycle: h.lifecycle,
      effects,
      limits:
        'Real operator proposal card/preview/save caller, completed planning transcript and actual source-return; simulated external native message/completion only, actual owner projections. Existing material inspected but no material pin beyond actual role-selectedrefs is inferred. No workerdispatch/task/outcomecompletion/nativecanonicalartifactsave/live/fullUX/main claim; other Refine path remains pending.',
    });
  } catch (error) {
    await capture('actual-failure-boundary').catch(() => {});
    throw error;
  } finally {
    await save();
    await h.close();
  }
}, 180_000);
