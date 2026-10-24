import { expect, it, vi } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createJoinedOrdinaryApplication } from './joined-ordinary-application';
import { openChatSetting, chooseSetting, chooseAgent } from '../../../support/chat-settings';

it('CT15/16 actual App: chooser and explicit replacement preserve independent state and truthful assignment labels after reconnect', async () => {
  const h = await createJoinedOrdinaryApplication();
  const { f, canonical, chat, page, api, http, ordinary, front, nativeSessions } = h;
  f.library.saveDraft('user', {
    profileId: 'independent-reviewer',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'reviewer-draft',
    definition: {
      name: 'Independent reviewer',
      descriptor: 'Separate reviewed settings',
      role: 'agent',
      instructions: 'Review the original sources independently.',
      expectedOutput: 'Independent observations',
      acceptanceCriteria: ['Retain independent context'],
      modelPolicyRole: 'agent',
    },
  });
  f.library.publish('user', {
    profileId: 'independent-reviewer',
    expectedVersion: 1,
    idempotencyKey: 'publish-reviewer',
  });
  await api.execute({
    operation: 'classify',
    itemId: 'studio',
    kind: 'outcome',
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
  });
  chat.eventStore.upsertSession({
    ...canonical.events.getSession('planning')!,
    accountBinding: f.binding,
  });
  const sequence = chat.eventStore.append('planning', 'user_message', {
    messageId: 'chooser-origin',
    text: 'Keep the original acoustic source while comparing ordinary collaborators.',
  });
  const material = {
    artifactId: canonical.material.id,
    revision: canonical.material.revision,
    sha256: canonical.material.sha256,
  };
  const sourceSelection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'planning',
    mode: 'selected' as const,
    boundary: { sequence, messageId: 'chooser-origin' },
    messageIds: ['chooser-origin'],
    artifacts: [material],
    purpose: 'Original chooser evidence',
    joiningBrief: '',
  };
  const preview = await api.previewSource({ itemId: 'studio', selection: sourceSelection });
  await api.adoptSource({
    itemId: 'studio',
    selection: sourceSelection,
    requestId: randomUUID(),
    expectedRevision: preview.packet.workRevision,
    previewSha256: preview.sha256,
  });
  const sources = (await api.read('studio')).sources;
  const originalSource = await api.readSource('studio', sources[0].snapshotId);
  const baselineSessions = chat.eventStore.listSessions().length;
  const assignmentLabels: Array<{
    stage: string;
    conversationId: string;
    title: string;
    expectedLabel: string;
    actualLabel: string;
    accessibleName: string | null;
  }> = [];
  const catalogTitles = async () => {
    const catalog = (await (await http('/api/sessions')).json()).sessions as Array<{
      id: string;
      summary: string;
    }>;
    return (id: string) => {
      const entry = catalog.find((row) => row.id === id);
      expect(entry).toBeDefined();
      return entry!.summary;
    };
  };
  const observeAssignmentLabels = async (
    stage: string,
    entries: Array<{ id: string; expectedLabel: string }>,
  ) => {
    const titleFor = await catalogTitles();
    const work = await api.read('studio');
    for (const entry of entries) {
      // Profile names are not roles. In particular, Independent reviewer is an
      // additional lead chat and must never be relabelled as a Reviewer role.
      expect(work.links.find((link) => link.conversation.conversationId === entry.id)?.role).toBe(
        'lead',
      );
      const title = titleFor(entry.id);
      // A silent replacement has no message/title yet. Its current assignment
      // is authoritative; the existing UI renders its label as the heading.
      if (!title)
        expect(work.assignments).toMatchObject([
          { role: 'lead', conversation: { conversationId: entry.id } },
        ]);
      const row = title
        ? page.locator('.telos-chat-row').filter({ hasText: title })
        : page.getByRole('button', { name: 'Open ' + entry.expectedLabel, exact: true });
      await browserExpect(row).toHaveCount(1);
      assignmentLabels.push({
        stage,
        conversationId: entry.id,
        title,
        expectedLabel: entry.expectedLabel,
        actualLabel: await row
          .locator(title ? '.telos-chat-copy small' : '.telos-chat-copy strong')
          .first()
          .innerText(),
        accessibleName: await row.getAttribute('aria-label'),
      });
    }
    if (process.env.S9_JOINED_SCREENSHOT_DIR) {
      await writeFile(
        join(process.env.S9_JOINED_SCREENSHOT_DIR, 'assignment-labels.json'),
        JSON.stringify({ observations: assignmentLabels, work }, null, 2),
      );
      await page.screenshot({
        path: join(process.env.S9_JOINED_SCREENSHOT_DIR, stage + '-assignment-labels.png'),
        fullPage: true,
      });
    }
  };
  const configure = async (label: string, profileId: string) => {
    await browserExpect(
      page.getByRole('region', { name: 'Work conversation setup' }),
    ).toBeVisible();
    await openChatSetting(page, 'execution');
    await page.getByRole('button', { name: 'Local Mac', exact: true }).click();
    await chooseSetting(page, 'Account', 'ordinary-personal');
    await chooseSetting(page, 'Model', 'fixture-model');
    await chooseSetting(page, 'Thinking level', 'low');
    await chooseAgent(page, JSON.stringify(['saved', profileId, 1]));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/telos/work/roles/ordinary/setup-reviewed'),
      ),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    const submitted = response.request().postDataJSON();
    await browserExpect(page).toHaveURL(/\/chat\/[a-f0-9-]+/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(chat.eventStore.getSession(id)?.agentProfile?.profileId).toBe(profileId);
    return { id, submitted };
  };
  const firstSend = async (id: string, text: string) => {
    const before = nativeSessions.length;
    await page.getByRole('textbox', { name: 'Message Mitzo' }).fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          r.url().endsWith('/api/ordinary/workspaces/commands/first'),
      ),
      page.getByRole('button', { name: 'Send message', exact: true }).click(),
    ]);
    expect(await response.json()).toMatchObject({
      state: 'consumed',
      dispatched: true,
      sessionId: id,
    });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(before + 1));
    const owned = nativeSessions[before];
    await vi.waitFor(() =>
      expect(
        owned.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
      ).toHaveLength(1),
    );
    owned.lifecycle.onNotification('turn/completed', {
      threadId: owned.threadId,
      turn: { id: owned.turnId, status: 'completed' },
    });
  };
  await page.goto(front.origin + '/todos/studio?view=Chat');
  await browserExpect(page.getByRole('heading', { name: 'Chats · 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose lead collaborator', exact: true }).click();
  const first = await configure('Assign lead & open chat', 'ordinary-worker');
  expect(first.submitted.input.expectedAssignmentRevision).toBe(0);
  expect((await api.read('studio')).assignments).toMatchObject([
    { role: 'lead', revision: 1, conversation: { conversationId: first.id } },
  ]);
  expect(nativeSessions).toHaveLength(0);
  await firstSend(first.id, 'First lead reviews only the original plan.');
  const leadDraft = 'Keep the first lead unsent draft.';
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill(leadDraft);
  await page.getByRole('button', { name: 'Chats for this item: 2', exact: true }).click();
  await browserExpect(page.getByRole('heading', { name: 'Chats · 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const additional = await configure('Start chat', 'independent-reviewer');
  expect(additional.submitted.input.expectedAssignmentRevision).toBeNull();
  expect((await api.read('studio')).assignments).toMatchObject([
    { role: 'lead', revision: 1, conversation: { conversationId: first.id } },
  ]);
  expect(nativeSessions).toHaveLength(1);
  await firstSend(additional.id, 'Independent reviewer keeps a separate discussion.');
  const extraDraft = 'Keep the reviewer unsent draft.';
  await page.getByRole('textbox', { name: 'Message Mitzo' }).fill(extraDraft);
  await page.getByRole('button', { name: 'Chats for this item: 3', exact: true }).click();
  await browserExpect(page.getByRole('heading', { name: 'Chats · 3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Open Assigned lead/ }).click();
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + first.id));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(leadDraft);
  await openChatSetting(page, 'agent');
  await browserExpect(
    page.getByRole('region', { name: 'Agent settings', exact: true }),
  ).toContainText('Ordinary work');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Chats for this item: 3', exact: true }).click();
  const reviewerRow = page.locator('.telos-chat-row').filter({ hasText: 'Independent reviewer' });
  await browserExpect(reviewerRow).toHaveCount(1);
  await reviewerRow.click();
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + additional.id));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(extraDraft);
  await page.getByRole('button', { name: 'Chats for this item: 3', exact: true }).click();
  await page.getByRole('button', { name: 'Change lead collaborator', exact: true }).click();
  const replacement = await configure('Assign lead & open chat', 'ordinary-worker');
  expect(replacement.submitted.input.expectedAssignmentRevision).toBe(1);
  expect((await api.read('studio')).assignments).toMatchObject([
    { role: 'lead', revision: 2, conversation: { conversationId: replacement.id } },
  ]);
  expect(new Set([first.id, additional.id, replacement.id]).size).toBe(3);
  expect(
    new Set(
      [first.id, additional.id, replacement.id].map((id) => chat.eventStore.getSession(id)!.cwd),
    ).size,
  ).toBe(3);
  expect(nativeSessions).toHaveLength(2);
  await page.goto(front.origin + '/todos/studio?view=Chat');
  await browserExpect(page.getByRole('heading', { name: 'Chats · 4', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/todos/studio');
  expect(chat.eventStore.listSessions()).toHaveLength(baselineSessions + 3);
  const expectedLabels = [
    { id: first.id, expectedLabel: 'Previous conversation' },
    { id: additional.id, expectedLabel: 'Additional lead conversation' },
    { id: replacement.id, expectedLabel: 'Assigned lead' },
  ];
  await observeAssignmentLabels('after-replacement', expectedLabels);
  await page.getByRole('button', { name: 'Materials', exact: true }).click();
  await page.getByRole('button', { name: 'Open original chat', exact: true }).click();
  await browserExpect(page).toHaveURL(/\/chat\/planning\?/);
  expect(new URL(page.url()).searchParams.get('telosSource')).toBe(sources[0].snapshotId);
  await browserExpect(
    page.getByRole('button', { name: 'View item: Home studio', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await browserExpect(page).toHaveURL(/\/todos\/studio\?view=Materials/);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await browserExpect(page.getByRole('heading', { name: 'Chats · 4', exact: true })).toBeVisible();
  // Exercise real broadcast EventSource failure/reconnection, with no fabricated
  // work or visibility event. A second authorized device adds an ordinary chat.
  let broadcastFailures = 0;
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === '/api/events') broadcastFailures++;
  });
  const offline = async (route: import('@playwright/test').Route) => route.abort('failed');
  await page.route('**/api/events', offline);
  front.server.closeAllConnections();
  await vi.waitFor(() => expect(broadcastFailures).toBeGreaterThan(0), { timeout: 10000 });
  const prepared = await ordinary.prepare({
    version: 1,
    model: f.binding.model,
    runOn: 'local',
    runtime: {
      account: f.first.request.runtime.account,
      harness: 'codex',
      targetId: f.first.request.runtime.targetId,
    },
  });
  const previousSettings = additional.submitted.input.settings;
  expect(previousSettings).toHaveProperty('version', 2);
  const reviewed = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: sources.map((s) => s.snapshotId),
    artifactRefs: [material],
  });
  const external = await api.setupReviewedOrdinaryRole({
    version: 2,
    input: {
      version: 2,
      requestId: randomUUID(),
      itemId: 'studio',
      role: 'lead',
      expectedRevision: reviewed.selection.brief.revision,
      expectedAssignmentRevision: null,
      settings: {
        ...previousSettings,
        version: 2,
        binding: prepared.runtimeBinding,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
      contextSelection: reviewed.selection,
    },
    presentationRef: reviewed.presentationRef,
  });
  expect(external.work.assignments).toMatchObject([
    { role: 'lead', revision: 2, conversation: { conversationId: replacement.id } },
  ]);
  await page.unroute('**/api/events', offline);
  await browserExpect(page.getByRole('heading', { name: 'Chats · 5', exact: true })).toBeVisible({
    timeout: 15000,
  });
  expect(new URL(page.url()).pathname).toBe('/todos/studio');
  await observeAssignmentLabels('after-reconnect', expectedLabels);
  const titleFor = await catalogTitles();
  await page
    .locator('.telos-chat-row')
    .filter({ hasText: titleFor(first.id) })
    .click();
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + first.id));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(leadDraft);
  await page.getByRole('button', { name: 'Chats for this item: 5', exact: true }).click();
  await page
    .locator('.telos-chat-row')
    .filter({ hasText: titleFor(additional.id) })
    .click();
  await browserExpect(page).toHaveURL(new RegExp('/chat/' + additional.id));
  await browserExpect(page.getByRole('textbox', { name: 'Message Mitzo' })).toHaveValue(extraDraft);
  await page.getByRole('button', { name: 'Chats for this item: 5', exact: true }).click();
  await browserExpect(page.getByRole('heading', { name: 'Chats · 5', exact: true })).toBeVisible();
  expect(nativeSessions).toHaveLength(2);
  expect(chat.eventStore.listSessions()).toHaveLength(baselineSessions + 4);
  expect((await api.read('studio')).sources).toEqual(sources);
  expect((await api.read('studio')).assignments).toMatchObject([
    { role: 'lead', revision: 2, conversation: { conversationId: replacement.id } },
  ]);
  expect(await api.readSource('studio', sources[0].snapshotId)).toEqual(originalSource);
  expect(h.pageErrors).toEqual([]);
  for (const owned of nativeSessions)
    expect(owned.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
      1,
    );
  if (process.env.S9_JOINED_SCREENSHOT_DIR) {
    await page.screenshot({
      path: join(process.env.S9_JOINED_SCREENSHOT_DIR, 'actual-chooser-after-reconnect.png'),
      fullPage: true,
    });
    await writeFile(
      join(process.env.S9_JOINED_SCREENSHOT_DIR, 'chooser-proof.json'),
      JSON.stringify(
        {
          first,
          additional,
          replacement,
          current: await api.read('studio'),
          nativeLaunches: nativeSessions.length,
          broadcastFailures,
          originalSources: sources,
          leadDraft,
          extraDraft,
          assignmentLabels,
        },
        null,
        2,
      ),
    );
  }
  // Retain both checkpoints and execute the existing draft/source/native
  // assertions before reporting every visible and accessible label mismatch.
  expect(assignmentLabels).toHaveLength(6);
  for (const observation of assignmentLabels) {
    const at = observation.stage + ': ' + observation.conversationId;
    expect.soft(observation.actualLabel, at).toBe(observation.expectedLabel);
    expect
      .soft(observation.accessibleName, at)
      .toBe(
        'Open ' + observation.expectedLabel + (observation.title ? ': ' + observation.title : ''),
      );
  }
}, 120_000);
