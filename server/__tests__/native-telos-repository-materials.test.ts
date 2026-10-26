import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  buildPermissionHandler,
  getPendingRequestsBySession,
  SessionRegistry,
} from '@mitzo/harness';
import { createJoiningFixture, cleanupJoiningFixtures } from './fixtures/collaboration-joining.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosWorkRoleSetup } from '../telos-work-role-setup.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { TelosSourceApproval } from '../telos-source-approval.js';
import { TelosSourceApprovalStore } from '../telos-source-approval-store.js';
import { TelosWorkDelegation } from '../telos-work-delegation.js';
import { TaskStore } from '../task-store.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  await cleanupJoiningFixtures();
});

/** Real canonical/work/role/allocation/repository/approval owners. Native
 * pending currentness and external source/account checks are controlled ports;
 * this is a component authority test, not an App/native-provider execution. */
async function fixture(target: 'own' | 'child' = 'own', owningRepositoryAvailable = true) {
  const f = await createJoiningFixture(),
    c = createTelosCanonicalData();
  cleanup.push(() => c.close());
  const work = new TelosWorkStore(c.dbPath, {
    ordinaryConversation: (id) => !!f.store.getSession(id) && !f.store.getSession(id)?.isHidden,
  });
  cleanup.push(() => work.close());
  work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      kind: 'outcome',
      requestId: 'classify',
      expectedRevision: work.read('studio', c.actor).revision,
    },
    c.actor,
  );
  const context = reviewTelosWorkRoleContext({
    work,
    artifacts: c.artifacts,
    actor: c.actor,
    itemId: 'studio',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  const owner = new TelosWorkRoleSetup({
    work,
    events: f.store,
    workspaces: f.workspaces,
    authorize: async () => {},
    assertBeforeApply() {},
    resolvePreparation: f.resolvePreparation,
    retainContext: async (scope) =>
      retainTelosWorkRoleContext(
        f.store,
        scope.conversationId,
        f.store.getSession(scope.conversationId)!.accountBinding!,
        scope.setup.input.contextSelection,
      ),
  });
  const lead = await owner.setup(
    c.actor,
    {
      itemId: 'studio',
      role: 'lead',
      requestId: randomUUID(),
      expectedRevision: context.brief.revision,
      expectedAssignmentRevision: 0,
      contextSelection: context,
      settings: f.input.settings,
    },
    f.signal,
  );
  const leadId = lead.work.assignments[0].conversation.conversationId;
  const meta = f.store.getSession(leadId)!;
  const record = f.workspaces.get(meta.repositoryWorkspaceId!);
  await f.workspaces.claimReservedHostTask({
    id: record.id,
    binding: meta.accountBinding!,
    conversationId: leadId,
    taskRoot: record.hostReservation!.taskRoot,
    runtimeBinding: f.input.settings.binding,
    signal: f.signal,
  });
  expect(f.workspaces.getForConversation(leadId)).toMatchObject({
    id: meta.repositoryWorkspaceId,
    state: 'claimed',
    conversationId: leadId,
  });
  expect(meta.ordinaryWorkspaceId).toBeUndefined();
  const prepared = await f.resolvePreparation();
  const tasks = new TaskStore(join(dirname(prepared.taskRoot), 'repository-material-tasks.db'));
  cleanup.push(() => tasks.close());
  let workerId: string | undefined, taskId: string | undefined;
  let output: ReturnType<typeof c.artifacts.save> | undefined;
  if (target === 'child') {
    for (const itemId of ['slice', 'sibling']) {
      c.db
        .prepare(
          "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,priority,first_seen,last_seen,created_at,updated_at) VALUES(?,'studio',?,'Exact child','Independent evidence','[\"Exact output\"]','manual',5,?,?,?,?)",
        )
        .run(itemId, itemId, c.stamp, c.stamp, c.stamp, c.stamp);
      work.execute(
        {
          operation: 'classify',
          kind: 'work_item',
          itemId,
          requestId: randomUUID(),
          expectedRevision: work.read(itemId, c.actor).revision,
        },
        c.actor,
      );
    }
    const workerContext = reviewTelosWorkRoleContext({
      work,
      artifacts: c.artifacts,
      actor: c.actor,
      itemId: 'slice',
      role: 'worker',
      selectedSourceSnapshotIds: [],
      selectedArtifactRefs: [],
    });
    const delegated = await new TelosWorkDelegation({
      work,
      events: f.store,
      tasks,
      workspaces: f.workspaces,
      authorize: async () => {},
      resolvePreparation: f.resolvePreparation,
      assertBeforeApply() {},
    }).delegate(
      c.actor,
      {
        requestId: randomUUID(),
        leadItemId: 'studio',
        childItemId: 'slice',
        leadConversationId: leadId,
        expectedRevision: workerContext.brief.revision,
        mode: 'start',
        predecessorAttemptId: null,
        contextSelection: workerContext,
        settings: f.input.settings,
      },
      f.signal,
    );
    workerId = delegated.workerConversationId;
    taskId = delegated.attempt.executionTaskId!;
    const workerMeta = f.store.getSession(workerId)!;
    const workerRecord = f.workspaces.get(workerMeta.repositoryWorkspaceId!);
    await f.workspaces.claimReservedHostTask({
      id: workerRecord.id,
      binding: workerMeta.accountBinding!,
      conversationId: workerId,
      taskRoot: workerRecord.hostReservation!.taskRoot,
      runtimeBinding: f.input.settings.binding,
      signal: f.signal,
    });
    expect(workerRecord.id).not.toBe(record.id);
    expect(f.workspaces.getForConversation(workerId)).toMatchObject({
      state: 'claimed',
      baseOid: record.baseOid,
      repository: record.repository,
      connectionId: record.connectionId,
    });
    output = c.artifacts.save({
      itemId: 'slice',
      sessionId: workerId,
      filename: 'worker-report.md',
      title: 'Exact repository worker output',
      bytes: Buffer.from('Worker-authored repository result'),
    });
    tasks.update(taskId, { artifacts: { report: `artifact:${output.id}@1` } });
  }
  const material = c.artifacts.save({
    itemId: 'studio',
    sessionId: leadId,
    filename: 'repo-plan.md',
    title: 'Original repository plan',
    bytes: Buffer.from('Retain my own exact source'),
  });
  f.store.append(leadId, 'user_message', {
    messageId: 'own-source',
    text: meta.initialPrompt || 'Review my own exact source.',
  });
  const registry = new SessionRegistry(),
    controller = new AbortController();
  cleanup.push(() => controller.abort());
  registry.register('repo-source-client', {
    sessionId: leadId,
    transport: { isOpen: () => true, send() {} },
    abortController: controller,
    sessionAllowList: new Set(),
    mode: 'agent',
  });
  let current = true;
  const pending = buildPermissionHandler('repo-source-client', registry)(
    'TelosAdoptSource',
    { itemId: target === 'own' ? 'studio' : 'slice' },
    {
      signal: controller.signal,
      toolUseID: 'native:' + randomUUID(),
      forcePrompt: true,
      allowSessionGrant: false,
      nativeSourceScope: {
        operatorId: c.actor.id,
        assertCurrentSync() {
          if (!current) throw Error('Original pending retired');
        },
      },
    },
  );
  void pending.catch(() => {});
  await vi.waitFor(() => expect(getPendingRequestsBySession(leadId)).toHaveLength(1));
  const permId = getPendingRequestsBySession(leadId)[0].permId;
  const store = new TelosSourceApprovalStore(c.dbPath);
  cleanup.push(() => store.close());
  const originalProfiles = [leadId, ...(workerId ? [workerId] : [])].map(
    (id) => f.store.getSession(id)!.agentProfile,
  );
  const service = new TelosSourceApproval({
    events: f.store,
    work,
    artifacts: c.artifacts,
    store,
    tasks,
    repositoryWorkspaces: owningRepositoryAvailable ? () => f.workspaces : undefined,
    createOutcome: async () => {
      throw Error('Adoption cannot create outcomes');
    },
  });
  return {
    f,
    c,
    work,
    leadId,
    material,
    service,
    store,
    permId,
    pending,
    workerId,
    taskId,
    output,
    tasks,
    originalProfiles,
    retire: () => {
      current = false;
    },
  };
}

it('preserves a repository Local Mac lead’s native own-source review, explicit adoption and exact receipt recovery', async () => {
  const x = await fixture();
  const review = await x.service.review(x.permId, x.leadId, x.c.actor);
  expect(review.artifacts).toEqual([
    expect.objectContaining({
      artifactId: x.material.id,
      revision: 1,
      sha256: x.material.sha256,
      sessionId: x.leadId,
    }),
  ]);
  const message = review.messages.find((m) => m.messageId === 'own-source')!;
  const input = {
    sessionId: x.leadId,
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    materialScopeSha256: review.materialScopeSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [{ artifactId: x.material.id, revision: 1, sha256: x.material.sha256 }],
    },
  };
  const preview = await x.service.preview(x.permId, input, x.c.actor);
  const approved = { ...input, previewSha256: preview.preview.sha256 };
  const receipt = await x.service.approve(x.permId, approved, x.c.actor);
  expect(receipt.receipt.work.sources).toHaveLength(1);
  expect(x.store.approvedArtifactSelection(x.leadId, x.c.actor.id, x.material.id, 1)).toMatchObject(
    [{ pin: { artifactId: x.material.id, revision: 1, sha256: x.material.sha256 } }],
  );
  x.retire();
  const custody = vi.spyOn(x.f.workspaces, 'getForConversation').mockReturnValue(undefined);
  expect(await x.service.approve(x.permId, approved, x.c.actor)).toEqual(receipt);
  expect(custody).not.toHaveBeenCalled();
});

it('offers only the exact selected child’s current worker output from independent custody of the same pinned repository', async () => {
  const x = await fixture('child');
  const review = await x.service.review(x.permId, x.leadId, x.c.actor);
  expect(review.artifacts).toHaveLength(2);
  expect(review.artifacts.find((a) => a.artifactId === x.output!.id)).toMatchObject({
    sessionId: x.workerId,
    revision: 1,
    sha256: x.output!.sha256,
    workerOutput: { itemId: 'slice' },
  });
  const message = review.messages.find((m) => m.messageId === 'own-source')!;
  const input = {
    sessionId: x.leadId,
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    materialScopeSha256: review.materialScopeSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [{ artifactId: x.output!.id, revision: 1, sha256: x.output!.sha256 }],
    },
  };
  const preview = await x.service.preview(x.permId, input, x.c.actor);
  expect(preview.preview.packet.context.artifacts[0].sourceConversationId).toBe(x.workerId);
  const receipt = await x.service.approve(
    x.permId,
    { ...input, previewSha256: preview.preview.sha256 },
    x.c.actor,
  );
  expect(receipt.receipt.work.itemId).toBe('slice');
  expect(x.store.approvedArtifactSelection(x.leadId, x.c.actor.id, x.output!.id, 1)).toMatchObject([
    { pin: { sha256: x.output!.sha256 } },
  ]);
  expect([x.leadId, x.workerId!].map((id) => x.f.store.getSession(id)!.agentProfile)).toEqual(
    x.originalProfiles,
  );
});

it('refuses a native repository review without its actual custody owner instead of falling back to generic source policy', async () => {
  const x = await fixture('own', false),
    read = vi.spyOn(x.c.artifacts, 'read');
  await expect(x.service.review(x.permId, x.leadId, x.c.actor)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

it.each([
  'repository',
  'connection',
  'pin',
  'workspace',
  'directory',
  'account',
  'runtime',
  'missing',
  'closed',
  'parent-workspace',
  'parent-conversation',
] as const)(
  'refuses repository worker output when its owning %s changes, before artifact bytes',
  async (changed) => {
    const x = await fixture('child'),
      original = x.f.workspaces.getForConversation.bind(x.f.workspaces);
    const read = vi.spyOn(x.c.artifacts, 'read');
    vi.spyOn(x.f.workspaces, 'getForConversation').mockImplementation((id) => {
      const actual = original(id);
      if (id !== x.workerId || !actual) return actual;
      if (changed === 'closed') throw Error('Actual custody unavailable');
      if (changed === 'missing') return undefined;
      if (changed === 'repository') return { ...actual, repository: 'foreign/repository' };
      if (changed === 'connection') return { ...actual, connectionId: 'foreign-connection' };
      if (changed === 'pin') return { ...actual, baseOid: 'f'.repeat(40) };
      if (changed === 'workspace') return { ...actual, id: 'another-workspace' };
      if (changed === 'directory') return { ...actual, directory: actual.directory + '-another' };
      if (changed === 'account')
        return { ...actual, binding: { ...actual.binding, accountId: 'another-account' } };
      if (changed === 'parent-workspace')
        return {
          ...actual,
          delegation: { ...actual.delegation!, sourceWorkspaceId: 'another-parent-workspace' },
        };
      if (changed === 'parent-conversation')
        return {
          ...actual,
          delegation: { ...actual.delegation!, sourceConversationId: 'another-lead' },
        };
      return {
        ...actual,
        ordinaryPreparation: {
          ...actual.ordinaryPreparation!,
          runtimeBinding: {
            ...actual.ordinaryPreparation!.runtimeBinding,
            execution: {
              ...actual.ordinaryPreparation!.runtimeBinding.execution,
              targetId: 'another-target',
            },
          },
        },
      };
    });
    await expect(x.service.review(x.permId, x.leadId, x.c.actor)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(x.work.read('slice', x.c.actor).sources).toEqual([]);
  },
);

it('rechecks repository custody for prepared-uncompleted recovery while preserving completed receipts', async () => {
  const x = await fixture();
  const review = await x.service.review(x.permId, x.leadId, x.c.actor),
    m = review.messages[0];
  const input = {
    sessionId: x.leadId,
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    materialScopeSha256: review.materialScopeSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: m.sequence, messageId: m.messageId },
      messageIds: [m.messageId],
      artifacts: [{ artifactId: x.material.id, revision: 1, sha256: x.material.sha256 }],
    },
  };
  const preview = await x.service.preview(x.permId, input, x.c.actor);
  const approved = { ...input, previewSha256: preview.preview.sha256 };
  vi.spyOn(x.service.capture, 'adopt').mockRejectedValueOnce(Error('Before source save'));
  await expect(x.service.approve(x.permId, approved, x.c.actor)).rejects.toThrow('uncertain');
  vi.spyOn(x.f.workspaces, 'getForConversation').mockReturnValue(undefined);
  await expect(x.service.review(x.permId, x.leadId, x.c.actor)).rejects.toThrow();
  await expect(x.service.preview(x.permId, input, x.c.actor)).rejects.toThrow();
  await expect(x.service.approve(x.permId, approved, x.c.actor)).rejects.toThrow();
  expect(x.work.read('studio', x.c.actor).sources).toEqual([]);
});
