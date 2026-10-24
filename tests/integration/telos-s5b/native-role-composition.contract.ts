import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OrdinaryWorkspaceFirstCommandSchema,
  TelosWorkDelegationReceiptSchema,
} from '@mitzo/protocol';
import { createJoinedOrdinaryApplication } from '../telos-s9/integrated-candidate/joined-ordinary-application';
import { prepareNativeProviderToolCall } from '../../../server/__tests__/fixtures/native-provider-tool-call.js';

// Requires the reviewed PR1117 fixture dependency on the final combined base.
// External provider input is synthetic; App, admission, roles, tasks and approvals are real.
const originalFetch = globalThis.fetch;
it('composes native worker evidence, explicit source review and Read Once with canonical Get/Update and retired-lead refusal', async () => {
  const h = await createJoinedOrdinaryApplication();
  const { f, api, chat, application, canonical, prepared, streamMessages, nativeSessions } = h;
  const { TaskOrchestrator } = await import('../../../server/task-orchestrator.js');
  const getClientId = vi.fn(() => {
    throw Error('The legacy scheduler must never select this exact worker');
  });
  // The App factory leaves startup injection to index.ts. Install the same real
  // dispatcher; native delegation still uses its original exact-allocation owner.
  application.setOrchestrator(
    new TaskOrchestrator({
      store: application.taskStore,
      getClientId,
      setTaskContext: () => {},
      clearTaskContext: () => {},
      broadcastStatus: () => {},
      broadcastTasks: () => {},
    }),
  );
  const { resolvePending } = await import('@mitzo/harness');
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      ![h.front.origin, 'http://localhost:' + h.front.port].includes(url.origin) ||
      !['/api/internal/telos/work/delegate', '/api/internal/telos/source/execute'].includes(
        url.pathname,
      ) ||
      init?.method !== 'POST' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('Only the original private native delegation callback is permitted');
    return originalFetch(input, { ...init, redirect: 'error' });
  });
  const profileDraft = f.library.saveDraft('user', {
    profileId: 'shared-lead-worker',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'profile-draft',
    definition: {
      name: 'Shared role-scoped worker',
      role: 'agent',
      instructions: 'Keep the retained role and exact task authority.',
      expectedOutput: 'Retained task evidence',
      acceptanceCriteria: ['No task execution by the lead'],
      modelPolicyRole: 'agent',
      tools: [
        'Write',
        'TelosStartSlice',
        'TelosSaveArtifact',
        'TelosReadArtifact',
        'TelosAdoptSource',
        'TelosGetItem',
        'TelosUpdateItem',
        'TaskStatus',
        'TaskArtifact',
        'TaskComplete',
      ].map((name) => ({ id: 'mitzo:' + name, version: 1 })),
    },
  });
  const profile = f.library.publish('user', {
    profileId: profileDraft.profileId,
    expectedVersion: profileDraft.version,
    idempotencyKey: 'profile-publish',
  });
  const originalProfile = structuredClone(profile);
  const selection = {
    ...f.first.request.selection,
    agent: { profileId: profile.profileId, revision: profile.revision },
  };
  for (const [id, title] of [
    ['role-slice', 'Exact recording slice'],
    ['role-sibling', 'Unselected sibling'],
  ]) {
    canonical.db
      .prepare(
        `INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at)
      VALUES(?,'studio',?,'Retain evidence','Keep exact scope','["Save a report"]','manual',5,?,?,?,?)`,
      )
      .run(id, title, canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  }
  for (const [itemId, kind] of [
    ['studio', 'outcome'],
    ['role-slice', 'work_item'],
    ['role-sibling', 'work_item'],
  ] as const)
    await api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: randomUUID(),
      expectedRevision: (await api.read(itemId)).revision,
    });
  const review = await api.reviewRoleContext({
    itemId: 'studio',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const lead = await api.setupReviewedOrdinaryRole({
    version: 2,
    presentationRef: review.presentationRef,
    input: {
      version: 2,
      itemId: 'studio',
      role: 'lead',
      requestId: randomUUID(),
      expectedRevision: review.selection.brief.revision,
      expectedAssignmentRevision: 0,
      contextSelection: review.selection,
      settings: {
        version: 2,
        binding: prepared.runtimeBinding,
        selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      },
    },
  });
  const leadId = lead.work.assignments[0].conversation.conversationId;
  const start = async (sessionId: string) => {
    const metadata = chat.eventStore.getSession(sessionId)!;
    const inventory = await (await h.http('/api/ordinary/workspaces/commands/capabilities')).json();
    const command = OrdinaryWorkspaceFirstCommandSchema.parse({
      version: 2,
      runOn: 'local',
      sessionId,
      workspace: { kind: 'ordinary', workspaceId: metadata.ordinaryWorkspaceId },
      clientMsgId: randomUUID(),
      capabilityRevision: inventory.capabilityRevision,
      runtime: f.first.request.runtime,
      selection,
      payload: {
        text: 'Use only the current retained role.',
        intent: 'Explicit role-scoped command',
      },
    });
    const count = nativeSessions.length;
    const response = await h.http('/api/ordinary/workspaces/commands/first', {
      method: 'POST',
      body: JSON.stringify(command),
    });
    expect(await response.json()).toMatchObject({ sessionId, state: 'consumed', dispatched: true });
    await vi.waitFor(() => expect(nativeSessions).toHaveLength(count + 1), { timeout: 10_000 });
    const actor = nativeSessions[count];
    await vi.waitFor(
      () =>
        expect(
          actor.rpc.request.mock.calls.filter(([method]) => method === 'turn/start'),
        ).toHaveLength(1),
      { timeout: 10_000 },
    );
    return actor;
  };
  type Actor = (typeof nativeSessions)[number];
  type Result = { success: boolean; contentItems: Array<{ type: string; text?: string }> };
  const approvals: Array<{ sessionId: string; name: string; decision: string; scope: unknown }> =
    [];
  const call = async (
    actor: Actor,
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    decision:
      'once' | 'deny' | 'review-source' | 'browser-once' | 'refuse-before-approval' = 'once',
    beforeDecision?: () => Promise<void>,
  ) => {
    const preparedCall = await prepareNativeProviderToolCall(actor, name, args);
    const before = streamMessages.length;
    let result: Result | undefined, error: unknown;
    const pending = actor.lifecycle
      .onRequest('item/tool/call', preparedCall.request, new AbortController().signal)
      .then(
        (value) => {
          result = value as Result;
        },
        (value) => {
          error = value;
        },
      );
    const permission = () =>
      streamMessages
        .slice(before)
        .find((entry) => entry.type === 'permission_request' && entry.sessionId === sessionId);
    await vi.waitFor(() => expect(result || error || permission()).toBeTruthy(), {
      timeout: 10_000,
    });
    const prompt = permission();
    if (decision === 'refuse-before-approval') {
      expect(name).toBe('TelosReadArtifact');
      expect(prompt).toBeUndefined();
      expect(beforeDecision).toBeUndefined();
    } else if (
      [
        'TelosSaveArtifact',
        'TelosReadArtifact',
        'TelosGetItem',
        'TelosUpdateItem',
        'TelosAdoptSource',
      ].includes(name)
    )
      expect(prompt).toMatchObject({ approvalScope: 'request', allowSessionGrant: false });
    if (decision === 'review-source' || decision === 'browser-once' || beforeDecision)
      expect(prompt).toBeTruthy();
    if (prompt) {
      expect(prompt.toolName).toBe(name);
      if (name === 'TelosAdoptSource')
        expect(prompt.description).toBe(
          'This adds the reviewed source to the selected Telos item.',
        );
      approvals.push({ sessionId, name, decision, scope: prompt.approvalScope });
      await beforeDecision?.();
      if (decision === 'once' || decision === 'deny')
        expect(resolvePending(prompt.permId as string, decision, undefined, sessionId)).toBe(true);
    }
    await pending;
    if (error) throw error;
    expect(result).toBeTruthy();
    return result!;
  };
  const json = (result: Result) =>
    JSON.parse(result.contentItems.map((entry) => entry.text ?? '').join('')) as Record<
      string,
      unknown
    >;
  const leadActor = await start(leadId);
  expect(chat.registry.findBySessionId(leadId)!.session.taskContext).toBeFalsy();
  const leadNames = leadActor.tools.map(({ name }) => name);
  expect(leadNames).toEqual(
    expect.arrayContaining(['TelosStartSlice', 'TelosSaveArtifact', 'TelosReadArtifact']),
  );
  expect(
    leadNames.some((name) =>
      /Task(Status|Artifact|Complete)|IntegrationTool|ReadToolOutput/.test(name),
    ),
  ).toBe(false);
  const request = {
    requestId: randomUUID(),
    childItemId: 'role-slice',
    mode: 'start',
    predecessorAttemptId: null,
    sourceSnapshotIds: [],
    artifactRefs: [],
  };
  const denied = await call(leadActor, leadId, 'TelosStartSlice', request, 'deny');
  expect(denied.success).toBe(false);
  expect(denied.contentItems.map((entry) => entry.text ?? '').join('')).toMatch(
    /denied|not allowed/i,
  );
  expect(application.taskStore.getTree()).toEqual([]);
  const allocated = await call(leadActor, leadId, 'TelosStartSlice', request);
  expect(allocated.success, JSON.stringify(allocated)).toBe(true);
  const receipt = TelosWorkDelegationReceiptSchema.parse(json(allocated));
  expect(receipt.execution).toBe('not_started');
  expect(json(await call(leadActor, leadId, 'TelosStartSlice', request))).toEqual(receipt);
  const workerId = receipt.workerConversationId,
    taskId = receipt.attempt.executionTaskId;
  if (!taskId) throw Error('The validated allocation receipt must retain its exact task');
  expect(workerId).not.toBe(leadId);
  expect(application.taskStore.getTree()).toHaveLength(1);
  expect((await api.read('role-sibling')).attempts).toEqual([]);
  expect(nativeSessions).toHaveLength(1);
  expect(chat.eventStore.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  expect(chat.eventStore.getSession(leadId)!.agentProfile).toEqual(originalProfile);
  expect(chat.eventStore.getSession(workerId)!.agentProfile).toEqual(originalProfile);
  const workerActor = await start(workerId);
  expect(chat.registry.findBySessionId(workerId)!.session.taskContext?.currentTaskId).toBe(taskId);
  expect(workerActor.tools.map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      'TelosSaveArtifact',
      'TelosReadArtifact',
      'TelosAdoptSource',
      'ListIntegrationTools',
      'DescribeIntegrationTool',
      'InvokeIntegrationTool',
    ]),
  );
  expect(workerActor.tools.some(({ name }) => name === 'TelosStartSlice')).toBe(false);
  const metadata = chat.eventStore.getSession(workerId)!;
  expect(metadata.cwd).not.toBe(chat.eventStore.getSession(leadId)!.cwd);
  await expect(access(join(metadata.cwd!, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  const inode = (await stat(metadata.cwd!)).ino;
  const report = 'Saved evidence; explicit review is still required.';
  const saved = await call(workerActor, workerId, 'TelosSaveArtifact', {
    requestId: 'role-report',
    itemId: 'role-slice',
    filename: 'report.md',
    title: 'Role report',
    content: report,
  });
  expect(saved.success).toBe(true);
  const output = json(saved).artifact as { id: string; revision: number; sha256: string };
  expect(output.sha256).toBe(createHash('sha256').update(report).digest('hex'));
  const artifact = await call(workerActor, workerId, 'mcp__task-board__TaskArtifact', {
    key: 'report',
    value: `artifact:${output.id}@${output.revision}`,
  });
  expect(artifact.success).toBe(true);
  expect(artifact.contentItems.map((entry) => entry.text ?? '').join('')).not.toMatch(/Error:/);
  const complete = await call(workerActor, workerId, 'mcp__task-board__TaskComplete', {
    summary: 'Saved evidence; pending explicit review.',
  });
  expect(complete.success).toBe(true);
  expect(complete.contentItems.map((entry) => entry.text ?? '').join('')).toContain(
    'pending_review',
  );
  expect(application.taskStore.get(taskId)).toMatchObject({
    status: 'pending_review',
    artifacts: { report: `artifact:${output.id}@${output.revision}` },
  });
  expect(canonical.artifacts.read(output.id, output.revision).bytes.toString()).toBe(report);
  expect((await api.readRecord('role-slice')).status).toBe('active');
  expect((await api.readRecord('studio')).status).toBe('active');
  expect((await stat(metadata.cwd!)).ino).toBe(inode);
  expect(chat.eventStore.getSession(leadId)!.agentProfile).toEqual(originalProfile);
  expect(chat.eventStore.getSession(workerId)!.agentProfile).toEqual(originalProfile);
  expect(approvals).toContainEqual(
    expect.objectContaining({
      sessionId: workerId,
      name: 'TelosSaveArtifact',
      decision: 'once',
      scope: 'request',
    }),
  );
  expect(h.pageErrors).toEqual([]);
  expect(getClientId).not.toHaveBeenCalled();
  expect(
    workerActor.tools.some(({ name }) => ['TelosGetItem', 'TelosUpdateItem'].includes(name)),
  ).toBe(false);
  const unread = await call(
    leadActor,
    leadId,
    'TelosReadArtifact',
    { id: output.id, revision: output.revision },
    'refuse-before-approval',
  );
  expect(unread.success).toBe(false);
  const { expect: browserExpect } = await import('@playwright/test');
  await h.page.goto(h.front.origin + '/chat/' + leadId);
  await browserExpect(h.page.getByRole('textbox', { name: /message/i })).toBeVisible();
  const sourcePanel = h.page.getByRole('region', { name: 'Telos source review' });
  const sourceScreenshots: string[] = [];
  const adopted = await call(
    leadActor,
    leadId,
    'TelosAdoptSource',
    { itemId: 'role-slice' },
    'review-source',
    async () => {
      await browserExpect(sourcePanel).toBeVisible();
      const material = sourcePanel.getByRole('checkbox', { name: /Role report/ });
      await browserExpect(material).not.toBeChecked();
      await browserExpect(
        sourcePanel.getByText('Worker output · Exact recording slice', { exact: false }),
      ).toBeVisible();
      const message = sourcePanel.getByRole('checkbox', {
        name: /Use only the current retained role/,
      });
      await browserExpect(message).not.toBeChecked();
      if (process.env.S5B_NATIVE_ROLE_EVIDENCE) {
        const directory = process.env.S5B_NATIVE_ROLE_EVIDENCE + '.screenshots';
        await mkdir(directory, { recursive: true });
        for (const [name, width, height, colorScheme, accent, font] of [
          ['desktop-light', 1280, 900, 'light', 'lavender', 'system'],
          ['mobile-dark', 390, 844, 'dark', 'teal', 'georgia'],
        ] as const) {
          await h.page.setViewportSize({ width, height });
          await h.page.emulateMedia({ colorScheme });
          await browserExpect(material).toBeVisible();
          await h.page.evaluate(
            ({ colorScheme, accent, font }) => {
              // Visual token fixtures only; no source/permission state is injected.
              Object.assign(document.documentElement.dataset, { theme: colorScheme, accent, font });
            },
            { colorScheme, accent, font },
          );
          expect(
            await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const path = join(directory, name + '.png');
          await h.page.screenshot({ path, fullPage: true });
          sourceScreenshots.push(path);
        }
        await h.page.setViewportSize({ width: 1280, height: 900 });
        await h.page.emulateMedia({ colorScheme: 'light' });
        await browserExpect(material).toBeVisible();
      }
      // Responsive shells remount the card. Review explicitly on this final
      // surface; a viewport transition must not act as approval of lost selection.
      await message.check();
      await material.focus();
      await material.press('Space');
      await browserExpect(material).toBeChecked();
      await sourcePanel.getByRole('button', { name: 'Review selected source' }).click();
      await browserExpect(sourcePanel.getByText('Reviewed source', { exact: true })).toBeVisible();
      await browserExpect(
        h.page.getByRole('button', { name: 'Allow Once', exact: true }),
      ).toBeEnabled();
      await h.page.getByRole('button', { name: 'Allow Once', exact: true }).click();
    },
  );
  expect(adopted.success, JSON.stringify(adopted)).toBe(true);
  const readOutput = await call(
    leadActor,
    leadId,
    'TelosReadArtifact',
    { id: output.id, revision: output.revision },
    'browser-once',
    async () => {
      await h.page.getByRole('button', { name: 'Allow Once', exact: true }).click();
    },
  );
  expect(readOutput.success, JSON.stringify(readOutput)).toBe(true);
  expect(json(readOutput)).toMatchObject({
    artifact: { id: output.id, revision: output.revision, sha256: output.sha256, content: report },
  });
  expect(application.taskStore.get(taskId)?.status).toBe('pending_review');
  const childRead = json(await call(leadActor, leadId, 'TelosGetItem', { itemId: 'role-slice' }));
  const parentRead = json(await call(leadActor, leadId, 'TelosGetItem', { itemId: 'studio' }));
  const update = {
    itemId: 'role-slice',
    requestId: 'native-verified-child',
    expectedRevision: (childRead.item as { revision: string }).revision,
    status: 'completed',
    note: `Lead read approved artifact:${output.id}@${output.revision} SHA-256 ${output.sha256}; task remains pending separate task review.`,
  };
  const deniedItemUpdate = await call(leadActor, leadId, 'TelosUpdateItem', update, 'deny');
  expect(deniedItemUpdate.success).toBe(false);
  expect((await api.readRecord('role-slice')).status).toBe('active');
  const updated = await call(leadActor, leadId, 'TelosUpdateItem', update);
  expect(updated.success, JSON.stringify(updated)).toBe(true);
  expect(json(updated)).toMatchObject({
    item: { id: 'role-slice', status: 'completed' },
    update: { sessionId: leadId },
  });
  expect(json(await call(leadActor, leadId, 'TelosUpdateItem', update))).toEqual(json(updated));
  expect(application.taskStore.get(taskId)?.status).toBe('pending_review');
  const parentUpdate = {
    ...update,
    itemId: 'studio',
    requestId: 'stale-native-parent',
    expectedRevision: (parentRead.item as { revision: string }).revision,
  };
  const staleParent = await call(leadActor, leadId, 'TelosUpdateItem', parentUpdate);
  expect(staleParent.success).toBe(false);
  expect(staleParent.contentItems.map((entry) => entry.text ?? '').join('')).toContain(
    'Telos item changed',
  );
  const freshParent = json(await call(leadActor, leadId, 'TelosGetItem', { itemId: 'studio' }));
  const unfinished = await call(leadActor, leadId, 'TelosUpdateItem', {
    ...parentUpdate,
    requestId: 'unfinished-native-parent',
    expectedRevision: (freshParent.item as { revision: string }).revision,
  });
  expect(unfinished.success).toBe(false);
  expect(unfinished.contentItems.map((entry) => entry.text ?? '').join('')).toContain(
    'Unfinished milestones',
  );
  expect((await api.readRecord('studio')).status).toBe('active');
  expect((await api.readRecord('role-sibling')).status).toBe('active');
  const freshChild = json(await call(leadActor, leadId, 'TelosGetItem', { itemId: 'role-slice' }));
  let replacementLeadId: string | undefined;
  const retired = await call(
    leadActor,
    leadId,
    'TelosUpdateItem',
    {
      itemId: 'role-slice',
      requestId: 'retired-native-lead',
      expectedRevision: (freshChild.item as { revision: string }).revision,
      note: 'Must never commit after canonical lead replacement.',
    },
    'once',
    async () => {
      const reviewed = await api.reviewRoleContext({
        itemId: 'studio',
        role: 'lead',
        sourceSnapshotIds: [],
        artifactRefs: [],
      });
      const assignment = (await api.read('studio')).assignments.find(
        (entry) => entry.role === 'lead',
      )!;
      const replacement = await api.setupReviewedOrdinaryRole({
        version: 2,
        presentationRef: reviewed.presentationRef,
        input: {
          version: 2,
          itemId: 'studio',
          role: 'lead',
          requestId: randomUUID(),
          expectedRevision: reviewed.selection.brief.revision,
          expectedAssignmentRevision: assignment.revision,
          contextSelection: reviewed.selection,
          settings: {
            version: 2,
            binding: prepared.runtimeBinding,
            selection,
            workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
          },
        },
      });
      replacementLeadId = replacement.work.assignments.find((entry) => entry.role === 'lead')!
        .conversation.conversationId;
    },
  );
  expect(retired.success).toBe(false);
  expect(
    canonical.db
      .prepare('SELECT COUNT(*) AS n FROM telos_item_updates WHERE request_id=?')
      .get('retired-native-lead'),
  ).toEqual({ n: 0 });
  expect(chat.eventStore.getSession(leadId)!.agentProfile).toEqual(originalProfile);
  expect(chat.eventStore.getSession(workerId)!.agentProfile).toEqual(originalProfile);
  expect(nativeSessions).toHaveLength(2);
  expect(replacementLeadId).toBeTruthy();
  expect(replacementLeadId).not.toBe(leadId);
  expect(h.pageErrors).toEqual([]);
  if (process.env.S5B_NATIVE_ROLE_EVIDENCE)
    await writeFile(
      process.env.S5B_NATIVE_ROLE_EVIDENCE,
      JSON.stringify(
        {
          version: 1,
          leadId,
          workerId,
          taskId,
          leadTools: leadNames,
          workerTools: workerActor.tools.map(({ name }) => name),
          profileSha256: createHash('sha256').update(JSON.stringify(originalProfile)).digest('hex'),
          leadProfileUnchanged: true,
          workerProfileUnchanged: true,
          receipt,
          deniedBeforeAllocation: denied,
          task: application.taskStore.get(taskId),
          output,
          approvals,
          workspaceInode: inode,
          childStatus: (await api.readRecord('role-slice')).status,
          parentStatus: (await api.readRecord('studio')).status,
          taskCount: application.taskStore.getTree().length,
          nativeActorCount: nativeSessions.length,
          nativeItems: {
            childRead,
            parentRead,
            denied: deniedItemUpdate,
            committed: json(updated),
            staleParent,
            unfinishedParent: unfinished,
            retiredLead: retired,
            replacementLeadId,
            committedRequestCount: canonical.db
              .prepare('SELECT COUNT(*) AS n FROM telos_item_updates WHERE request_id=?')
              .get(update.requestId),
            retiredRequestCount: canonical.db
              .prepare('SELECT COUNT(*) AS n FROM telos_item_updates WHERE request_id=?')
              .get('retired-native-lead'),
          },
          nativeOutputReview: {
            unread,
            adopted: json(adopted),
            read: json(readOutput),
            sourceScreenshots,
            sourceApproval: canonical.db
              .prepare(
                'SELECT COUNT(*) AS n FROM telos_work_source_approvals WHERE session_id=? AND receipt IS NOT NULL',
              )
              .get(leadId),
          },
          legacySchedulerSelections: getClientId.mock.calls.length,
          pageErrors: h.pageErrors,
        },
        null,
        2,
      ) + '\n',
    );
}, 150_000);
