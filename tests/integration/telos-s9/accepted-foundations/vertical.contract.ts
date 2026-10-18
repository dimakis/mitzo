import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createS9Fixture, cleanupS9Fixtures } from './fixture';
import { resolveTelosWorkRoleContext } from '../../../../server/telos-work-role-context';
import { handleTaskArtifact, handleTaskComplete } from '../../../../server/task-tools';
vi.mock('../../../../server/chat.js', () => ({ sendToChat: vi.fn(async () => true) }));
import { sendToChat } from '../../../../server/chat';
afterEach(async () => {
  vi.clearAllMocks();
  await cleanupS9Fixtures();
});

it('CT06/17/18 partial: origin and actual advisor-created child reach accepted delegation, retained result and explicit task review without pre-seeding the child', async () => {
  const f = await createS9Fixture({ seedChild: false });
  const childIds = () => {
    const db = new Database(f.dbPath, { readonly: true });
    try {
      return (
        db.prepare('SELECT id FROM items WHERE parent_id=? ORDER BY id').all('outcome') as {
          id: string;
        }[]
      ).map((r) => r.id);
    } finally {
      db.close();
    }
  };
  expect(childIds()).toEqual(['sibling']);
  for (const [itemId, kind] of [
    ['goal', 'coordinator'],
    ['outcome', 'outcome'],
    ['sibling', 'work_item'],
  ] as const)
    await f.api.execute({
      operation: 'classify',
      itemId,
      kind,
      requestId: 'kind-' + itemId,
      expectedRevision: (await f.api.read(itemId)).revision,
    });
  const origin = await f.captureSource();
  const originBefore = await f.api.readSource('outcome', origin.snapshotId);
  const advisorContext = await f.api.roleContext({
    itemId: 'outcome',
    role: 'advisor',
    advisorPurpose: 'child',
    sourceSnapshotIds: [origin.snapshotId],
    artifactRefs: [f.materialPin],
  });
  const advisorReceipt = await f.api.setupRole({
    itemId: 'outcome',
    role: 'advisor',
    requestId: 'review-child-advisor',
    expectedRevision: advisorContext.brief.revision,
    expectedAssignmentRevision: null,
    settings: f.ordinary.input.settings,
    contextSelection: advisorContext,
  });
  const advisorId = advisorReceipt.work.links.find((link) => link.role === 'advisor')!.conversation
    .conversationId;
  const sequence = f.events.append(advisorId, 'user_message', {
    messageId: 'exact-child-proposal',
    text: 'Create only the reviewed code slice; keep its evidence and review separate.',
  });
  const parent = await f.api.read('outcome');
  const proposal = {
    requestId: randomUUID(),
    operation: 'child' as const,
    itemId: 'outcome',
    advisorConversationId: advisorId,
    expectedRevision: parent.revision,
    parentId: 'outcome',
    expectedParentRevision: parent.revision,
    proposed: {
      name: 'Actual reviewed child',
      desiredOutcome: 'Return the exact independently reviewed evidence',
      type: 'work_item' as const,
      category: 'Job',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: advisorId,
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'exact-child-proposal' },
      messageIds: ['exact-child-proposal'],
      artifacts: [],
      purpose: 'Create the reviewed code slice',
      joiningBrief: '',
    },
  };
  const preview = await f.api.previewAdvisorDraft(proposal);
  expect(childIds()).toEqual(['sibling']);
  const save = { ...proposal, previewSha256: preview.sha256 };
  const created = await f.api.saveAdvisorDraft(save),
    childId = created.work.itemId;
  expect(childIds().sort()).toEqual([childId, 'sibling'].sort());
  expect(childId).not.toBe('child');
  const record = await f.api.readRecord(childId);
  expect(record).toMatchObject({
    parentId: 'outcome',
    summary: 'Actual reviewed child',
    intent: 'Return the exact independently reviewed evidence',
    categories: ['Job'],
    status: 'active',
  });
  expect(record.legacyFields.item).toMatchObject({
    first_seen: expect.any(String),
    last_seen: expect.any(String),
    created_at: expect.any(String),
  });
  expect(created.work.kind).toBe('work_item');
  expect(created.work.sources).toHaveLength(1);
  const childSource = created.work.sources[0];
  const retainedSource = await f.api.readSource(childId, childSource.snapshotId);
  expect(JSON.stringify(retainedSource.packet.context)).toContain(
    'Create only the reviewed code slice',
  );
  f.restart();
  expect(await f.api.saveAdvisorDraft(save)).toEqual(created);
  expect(childIds().sort()).toEqual([childId, 'sibling'].sort());
  const leadSettings = await f.independentSettings();
  const leadContext = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [origin.snapshotId],
    artifactRefs: [f.materialPin],
  });
  const leadReceipt = await f.api.setupRole({
    itemId: 'outcome',
    role: 'lead',
    requestId: 'lead-after-child',
    expectedRevision: leadContext.brief.revision,
    expectedAssignmentRevision: 0,
    settings: leadSettings,
    contextSelection: leadContext,
  });
  const leadId = leadReceipt.work.assignments.find((a) => a.role === 'lead')!.conversation
    .conversationId;
  const member = await f.ordinary
    .owner()
    .confirm(
      'operator',
      f.ordinary.group,
      f.joiningInput(await f.independentSettings()),
      f.ordinary.signal,
    );
  const leadBefore = f.events.getSession(leadId),
    memberBefore = f.events.getSession(member.sessionId!),
    siblingBefore = await f.api.read('sibling');
  expect(leadBefore?.cwd).not.toBe(f.events.getSession(advisorId)?.cwd);
  const context = await f.api.roleContext({
    itemId: childId,
    role: 'worker',
    sourceSnapshotIds: [childSource.snapshotId],
    artifactRefs: childSource.artifacts,
  });
  expect(context.leadConversationId).toBe(leadId);
  expect(context.sources[0].snapshotId).toBe(childSource.snapshotId);
  const input = {
    requestId: 'created-child-delegation',
    leadItemId: 'outcome',
    childItemId: childId,
    leadConversationId: leadId,
    expectedRevision: context.brief.revision,
    mode: 'start' as const,
    predecessorAttemptId: null,
    settings: leadSettings,
    contextSelection: context,
  };
  f.loseNextDelegationResponse();
  await expect(f.api.delegateSlice(input)).rejects.toThrow('response loss');
  const attempt = (await f.api.read(childId)).attempts[0],
    taskId = attempt.executionTaskId!;
  f.events.append(advisorId, 'user_message', {
    messageId: 'later-unselected',
    text: 'Later proposal must not replace the selected child source.',
  });
  f.replaceMaterial();
  f.restart();
  f.ordinary.resolvePreparation.mockClear();
  const receipt = await f.api.delegateSlice(input),
    worker = f.events.getSession(receipt.workerConversationId)!;
  expect(receipt.attempt).toEqual(attempt);
  expect(receipt.execution).toBe('not_started');
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect(f.tasks.getTree()).toHaveLength(1);
  expect(f.tasks.get(taskId)).toMatchObject({ status: 'pending', sessionId: null });
  const binding = f.tasks.getTelosExecutionBinding(taskId);
  expect(binding).toMatchObject({
    childItemId: childId,
    workerConversationId: worker.sessionId,
    leadConversationId: leadId,
    contextHash: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
  });
  expect(context).not.toHaveProperty('executionTaskId');
  expect(resolveTelosWorkRoleContext(f.events, worker.sessionId, worker.accountBinding!)).toEqual(
    context,
  );
  expect(worker.cwd).not.toBe(leadBefore?.cwd);
  expect(worker.cwd).not.toBe(memberBefore?.cwd);
  expect(f.events.getSession(leadId)).toEqual(leadBefore);
  expect(f.events.getSession(member.sessionId!)).toEqual(memberBefore);
  expect(await f.api.read('sibling')).toEqual(siblingBefore);
  expect(await f.api.readSource('outcome', origin.snapshotId)).toEqual(originBefore);
  expect(await f.api.readSource(childId, childSource.snapshotId)).toEqual(retainedSource);
  expect(f.readMaterial()).toBe('Original retained plan');
  // Deterministic provider-result effect enters actual task retention/review owners.
  // No first command or provider execution is claimed by this contract.
  expect(
    handleTaskArtifact(f.tasks, taskId, 'reviewed-result', 'Synthetic exact-child result'),
  ).toContain('Artifact stored');
  expect(handleTaskComplete(f.tasks, taskId, 'Review the saved code evidence')).toContain(
    'pending_review',
  );
  f.restart();
  expect(f.tasks.get(taskId)).toMatchObject({
    status: 'pending_review',
    artifacts: { 'reviewed-result': 'Synthetic exact-child result' },
  });
  expect(f.orchestrator().approveTask(taskId)).toBe(true);
  f.restart();
  expect(f.tasks.get(taskId)?.status).toBe('done');
  expect(f.tasks.getTelosExecutionBinding(taskId)).toEqual(binding);
  expect(f.canonicalStatus(childId)).toBe('active');
  expect(f.canonicalStatus('outcome')).toBe('active');
  expect(f.events.getOrdinaryInitialCommandId(worker.sessionId)).toBeUndefined();
  expect(sendToChat).not.toHaveBeenCalled();
  expect(f.getClientId).not.toHaveBeenCalled();
});
