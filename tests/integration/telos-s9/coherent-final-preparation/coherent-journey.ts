import { expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  LocalCodexFirstCommandSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  type CollaborationSettings,
  type OrdinaryWorkspaceSettings,
} from '@mitzo/protocol';
import { createActualApp } from './actual-app.js';
import { publicationJourney } from './publication-journey.js';
import { prepareColdHandoff } from './cold-handoff.js';
import { observeActualAllOutcomesEntry } from './collection-entry.js';
import { reviewArtifactThenCompleteMilestoneAndOutcome } from './review-completion.js';

const exec = promisify(execFile);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function coherentJourney(kind: 'repository' | 'non-git', handoffPath: string) {
  const app = await createActualApp(kind);
  const { api, chat, application } = app;
  await api.execute({
    operation: 'classify',
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
    kind: 'outcome',
  });
  // Synthetic retained origin, inserted through the actual EventStore; capture,
  // source authorization, immutable packet and role allocation remain real.
  const origin = 'coherent-origin-' + randomUUID();
  chat.eventStore.upsertSession({
    sessionId: origin,
    conversationSource: 'mitzo',
    summary: 'Operator planning',
    accountBinding: app.binding,
  });
  const originSequence = chat.eventStore.append(origin, 'user_message', {
    messageId: 'origin-plan',
    text: 'Produce a reviewed recording report with retained evidence.',
  });
  const originSelection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: origin,
    mode: 'selected' as const,
    boundary: { sequence: originSequence, messageId: 'origin-plan' },
    messageIds: ['origin-plan'],
    artifacts: [],
    purpose: 'Authorized report scope',
    joiningBrief: '',
  };
  await api.execute({
    operation: 'link',
    itemId: 'studio',
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
    role: 'origin',
    conversation: { namespace: 'mitzo', conversationId: origin },
  });
  const originPreview = await api.previewSource({ itemId: 'studio', selection: originSelection });
  const originInput = {
    itemId: 'studio',
    selection: originSelection,
    requestId: randomUUID(),
    expectedRevision: (await api.read('studio')).revision,
    previewSha256: originPreview.sha256,
  };
  const originReceipt = await api.adoptSource(originInput);
  expect(await api.adoptSource(originInput)).toEqual(originReceipt);
  expect(originReceipt.work.links).toContainEqual(
    expect.objectContaining({
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: origin },
    }),
  );
  expect((await api.readSource('studio', originReceipt.work.sources[0].snapshotId)).packet).toEqual(
    originPreview.packet,
  );
  await observeActualAllOutcomesEntry(app.browser.page, app.front.origin, app.record);

  const { mode, ...runtimeSelection } = app.runtime;
  expect(mode).toBe('agent');
  const ordinaryRuntime = { runOn: 'local' as const, runtime: runtimeSelection };
  // Each distinct role needs its own real allocation preparation; exact retries
  // below retain that role's original selection and request.
  const prepareSettings = async (): Promise<CollaborationSettings | OrdinaryWorkspaceSettings> => {
    if (kind === 'non-git') {
      const prepared = await app.ordinary.prepare({
        version: 1,
        model: app.binding.model,
        ...ordinaryRuntime,
      });
      expect(prepared.capabilities).toEqual([
        'ordinary_conversation',
        'writable_files',
        'retained_artifacts',
        'task_execution',
      ]);
      return {
        version: 2,
        binding: prepared.runtimeBinding,
        selection: app.selection,
        workspace: { kind: 'ordinary', preparationId: prepared.preparationId },
      };
    } else {
      const preview = await app.http('/api/repository-workspaces/preview', {
        method: 'POST',
        body: JSON.stringify({
          accountId: app.binding.accountId,
          model: app.binding.model,
          connectionId: app.connectionId,
          repository: 'owner/project',
          ordinaryRuntime,
          requestId: randomUUID(),
        }),
      });
      expect(preview.status).toBe(200);
      const source = (await preview.json()) as { id: string; baseOid: string };
      expect(source.baseOid).toBe(app.sourceOid);
      const prepared = await app.http('/api/repository-workspaces/' + source.id + '/prepare', {
        method: 'POST',
        body: JSON.stringify({ accountId: app.binding.accountId, model: app.binding.model }),
      });
      expect(prepared.status).toBe(200);
      const { getRepositoryWorkspaces } =
        await import('../../../../server/repository-workspace-runtime.js');
      const retained = getRepositoryWorkspaces(true).get(source.id);
      expect(retained.state).toBe('ready');
      expect(retained.ordinaryPreparation).toBeDefined();
      expect(retained.ordinaryPreparation!.credentialDigest).not.toBe('a'.repeat(64));
      return {
        binding: retained.ordinaryPreparation!.runtimeBinding,
        selection: app.selection,
        repositoryWorkspaceId: retained.id,
      };
    }
  };
  const setupRole = async (role: 'advisor' | 'lead') => {
    const settings = await prepareSettings();
    const work = await api.read('studio');
    const review = await api.reviewRoleContext({
      itemId: 'studio',
      role,
      ...(role === 'advisor' ? { advisorPurpose: 'child' as const } : {}),
      sourceSnapshotIds: work.sources.map((source) => source.snapshotId),
      artifactRefs: [],
    });
    expect(review.selection.brief.revision).toBe(work.revision);
    expect(review.selection.brief.text.length).toBeGreaterThan(0);
    expect(hash(review.selection.brief.text)).toBe(review.selection.brief.sha256);
    expect(review.selection.sources).toEqual(work.sources);
    await app.record('real-current-brief-source-and-role-readiness-review', { role, review });
    const input = {
      requestId: randomUUID(),
      itemId: 'studio',
      role,
      expectedRevision: review.selection.brief.revision,
      expectedAssignmentRevision: role === 'lead' ? 0 : null,
      settings,
      contextSelection: review.selection,
    };
    const receipt =
      'workspace' in settings
        ? await api.setupReviewedOrdinaryRole({
            version: 2,
            input: { ...input, version: 2, settings },
            presentationRef: review.presentationRef,
          })
        : await api.setupReviewedRole({
            version: 1,
            input: { ...input, settings },
            presentationRef: review.presentationRef,
          });
    const retry =
      'workspace' in settings
        ? await api.setupReviewedOrdinaryRole({
            version: 2,
            input: { ...input, version: 2, settings },
            presentationRef: review.presentationRef,
          })
        : await api.setupReviewedRole({
            version: 1,
            input: { ...input, settings },
            presentationRef: review.presentationRef,
          });
    expect(retry).toEqual(receipt);
    return {
      conversationId: receipt.work.links.find((link) => link.role === role)!.conversation
        .conversationId,
      settings,
    };
  };
  const before = chat.eventStore.listSessions().length;
  const advisorId = (await setupRole('advisor')).conversationId;
  expect(chat.eventStore.listSessions()).toHaveLength(before + 1);
  expect(app.actors).toHaveLength(0);
  const sequence = chat.eventStore.append(advisorId, 'user_message', {
    messageId: 'reviewed-plan',
    text: 'Retain the reviewed report scope. Start only the exact child.',
  });
  const revision = (await api.read('studio')).revision;
  const draft = {
    requestId: randomUUID(),
    operation: 'child' as const,
    itemId: 'studio',
    advisorConversationId: advisorId,
    expectedRevision: revision,
    parentId: 'studio',
    expectedParentRevision: revision,
    proposed: {
      name: 'Reviewed recording report',
      desiredOutcome: 'Retained report meets the approved plan',
      type: 'work_item' as const,
      category: 'Music',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: advisorId,
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'reviewed-plan' },
      messageIds: ['reviewed-plan'],
      artifacts: [],
      purpose: 'Execute reviewed child only',
      joiningBrief: '',
    },
  };
  const preview = await api.previewAdvisorDraft(draft),
    saved = await api.saveAdvisorDraft({ ...draft, previewSha256: preview.sha256 });
  expect(await api.saveAdvisorDraft({ ...draft, previewSha256: preview.sha256 })).toEqual(saved);
  const childId = saved.work.itemId;
  expect(childId).not.toBe('studio');
  expect(saved.work.sources).toHaveLength(1);
  const originalSource = saved.work.sources[0];
  const packet = await api.readSource(childId, originalSource.snapshotId);
  expect(packet.packet).toEqual(preview.packet);
  expect(hash(JSON.stringify(packet.packet))).toBe(preview.sha256);
  expect(originalSource).toMatchObject({
    itemId: childId,
    source: { namespace: 'mitzo', conversationId: advisorId },
    selection: {
      kind: 'selected',
      messageIds: ['reviewed-plan'],
      blockIds: [],
      throughSequence: sequence,
    },
  });
  const lead = await setupRole('lead');
  const leadId = lead.conversationId;
  const settings = lead.settings;
  expect(new Set([origin, advisorId, leadId]).size).toBe(3);
  expect(app.actors).toHaveLength(0);
  const start = async (sessionId: string, selected = app.selection) => {
    const meta = chat.eventStore.getSession(sessionId)!;
    const base = {
      runOn: 'local' as const,
      clientMsgId: randomUUID(),
      capabilityRevision: app.capabilityRevision,
      runtime: app.runtime,
      selection: selected,
      payload: {
        text: 'Perform only the retained reviewed work and save the report.',
        intent: 'Explicit reviewed first command',
      },
    };
    const command =
      kind === 'non-git'
        ? OrdinaryWorkspaceFirstCommandSchema.parse({
            ...base,
            version: 2,
            sessionId,
            workspace: { kind: 'ordinary', workspaceId: meta.ordinaryWorkspaceId },
          })
        : LocalCodexFirstCommandSchema.parse({
            ...base,
            repositoryWorkspaceId: meta.repositoryWorkspaceId,
          });
    const dispatch = async () => {
      const response = await app.http(
        kind === 'non-git'
          ? '/api/ordinary/workspaces/commands/first'
          : '/api/chat/local-codex/send',
        { method: 'POST', body: JSON.stringify(command) },
      );
      expect(response.status).toBe(202);
      return response.json() as Promise<{ state: string; dispatched: boolean; sessionId: string }>;
    };
    const receipt = await dispatch();
    expect(receipt).toMatchObject({ state: 'consumed', dispatched: true, sessionId });
    app.bindActor(sessionId);
    return { command, dispatch, receipt };
  };
  await start(leadId);
  expect(app.actors).toHaveLength(1);
  const input = {
    requestId: randomUUID(),
    childItemId: childId,
    mode: 'start',
    predecessorAttemptId: null,
    sourceSnapshotIds: [originalSource.snapshotId],
    artifactRefs: [],
  };
  const nativeJson = async (sessionId: string, name: string, args: unknown) => {
    const observed = await app.nativeCall(sessionId, name, args);
    expect(observed.result.success).toBe(true);
    return JSON.parse(
      observed.result.contentItems.map((item) => item.text ?? '').join('\n'),
    ) as Record<string, unknown>;
  };
  const delegated = await nativeJson(leadId, 'TelosStartSlice', input);
  expect(delegated).toMatchObject({ execution: 'not_started', attempt: { state: 'chat_ready' } });
  expect(await nativeJson(leadId, 'TelosStartSlice', input)).toEqual(delegated);
  const workerId = delegated.workerConversationId as string,
    taskId = (delegated.attempt as { executionTaskId: string }).executionTaskId;
  expect(application.taskStore.getTree()).toHaveLength(1);
  expect(app.actors).toHaveLength(1);
  expect(chat.eventStore.getOrdinaryInitialCommandId(workerId)).toBeUndefined();
  const ids = [advisorId, leadId, workerId],
    directories = ids.map((id) => chat.eventStore.getSession(id)!.cwd!);
  expect(new Set(ids).size).toBe(3);
  expect(new Set(directories).size).toBe(3);
  for (const id of ids) {
    const session = chat.eventStore.getSession(id)!;
    if (kind === 'non-git') {
      expect(session.repositoryWorkspaceId).toBeUndefined();
      expect(session.ordinaryWorkspaceId).toBeTruthy();
      expect(session.cwd!.startsWith(app.taskRoot + '/')).toBe(true);
      await expect(access(join(session.cwd!, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(session.repositoryWorkspaceId).toBeTruthy();
      expect(session.ordinaryWorkspaceId).toBeUndefined();
      const main = (
        await exec('git', ['-C', session.cwd!, 'rev-parse', 'refs/heads/main'])
      ).stdout.trim();
      expect(main).toBe(app.sourceOid);
      const branch = (
        await exec('git', ['-C', session.cwd!, 'branch', '--show-current'])
      ).stdout.trim();
      expect(branch).not.toBe('main');
    }
  }
  const { resolveTelosWorkRoleContext } =
    await import('../../../../server/telos-work-role-context.js');
  const workerContext = resolveTelosWorkRoleContext(
    chat.eventStore,
    workerId,
    chat.eventStore.getSession(workerId)!.accountBinding!,
  );
  expect(workerContext).toMatchObject({
    itemId: childId,
    role: 'worker',
    leadConversationId: leadId,
  });
  expect(workerContext!.sources).toEqual([originalSource]);
  const started = await start(workerId);
  expect(app.actors).toHaveLength(2);
  expect(chat.registry.findBySessionId(workerId)!.session.taskContext?.currentTaskId).toBe(taskId);
  const worker = app.actorBySession.get(workerId)!,
    directory = chat.eventStore.getSession(workerId)!.cwd!,
    inode = (await stat(directory)).ino;
  const report = Buffer.from('Reviewed report: the approved recording plan is fulfilled.\n');
  // External worker output generation only: fake the provider writing its file.
  // Real native Save/Read, Task MCP, approval and canonical owners verify it.
  await writeFile(join(directory, 'recording-report.md'), report);
  await app.record('fake-external-worker-file-generation', {
    workerId,
    path: join(directory, 'recording-report.md'),
    sha256: hash(report),
    bytes: report.length,
  });
  const retainedOutput = await nativeJson(workerId, 'TelosSaveArtifact', {
    requestId: 'coherent-output',
    itemId: childId,
    filename: 'recording-report.md',
    title: 'Reviewed recording report',
    path: 'recording-report.md',
  });
  const output = retainedOutput.artifact as {
    id: string;
    revision: number;
    sha256: string;
    sessionId: string;
  };
  expect(output.sessionId).toBe(workerId);
  expect(output.sha256).toBe(hash(report));
  expect(
    await nativeJson(workerId, 'TelosSaveArtifact', {
      requestId: 'coherent-output',
      itemId: childId,
      filename: 'recording-report.md',
      title: 'Reviewed recording report',
      path: 'recording-report.md',
    }),
  ).toEqual(retainedOutput);
  const nativeRead = await nativeJson(workerId, 'TelosReadArtifact', {
    id: output.id,
    revision: output.revision,
  });
  expect(nativeRead).toMatchObject({
    ok: true,
    artifact: { id: output.id, revision: output.revision, sha256: output.sha256 },
  });
  expect(nativeRead).toMatchObject({
    artifact: { encoding: 'utf8', content: report.toString('utf8') },
  });
  const artifactResult = await app.nativeCall(workerId, 'mcp__task-board__TaskArtifact', {
    key: 'report',
    value: `artifact:${output.id}@${output.revision}`,
  });
  expect(artifactResult.result.success).toBe(true);
  expect(artifactResult.result.contentItems.map((item) => item.text ?? '').join('')).not.toContain(
    'Error:',
  );
  // TaskComplete returns text, not a fabricated JSON receipt.
  const completed = await app.nativeCall(workerId, 'mcp__task-board__TaskComplete', {
    summary: 'Saved report; awaiting explicit verification.',
  });
  expect(completed.result.success).toBe(true);
  expect(completed.result.contentItems.map((item) => item.text ?? '').join('')).toContain(
    'pending_review',
  );
  expect(application.taskStore.get(taskId)?.status).toBe('pending_review');
  const canonicalCompletion = await reviewArtifactThenCompleteMilestoneAndOutcome(
    {
      http: app.http,
      native: (name, args) => app.nativeCall(leadId, name, args),
      reload: () => app.browser.page.reload().then(() => {}),
      record: app.record,
    },
    {
      leadConversationId: leadId,
      taskId,
      milestoneId: childId,
      outcomeId: 'studio',
      artifact: { ...output, bytes: report },
      criteriaEvidence: 'Read retained report bytes and verified the reviewed plan',
    },
  );
  const finished = new Set<(typeof app.actors)[number]>();
  const finishProviderTurns = () => {
    for (const actor of app.actors)
      if (!finished.has(actor)) {
        actor.lifecycle.onNotification('turn/completed', {
          threadId: actor.threadId,
          turn: { id: actor.turnId, status: 'completed' },
        });
        finished.add(actor);
      }
  };
  finishProviderTurns();
  const turns = worker.rpc.request.mock.calls.filter(([method]) => method === 'turn/start').length;
  expect(await started.dispatch()).toMatchObject({
    state: 'consumed',
    dispatched: false,
    sessionId: workerId,
  });
  expect(worker.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
    turns,
  );
  expect(app.actors).toHaveLength(2);
  expect((await stat(directory)).ino).toBe(inode);
  expect(await readFile(join(directory, 'recording-report.md'))).toEqual(report);
  expect((await api.read(childId)).sources).toEqual([originalSource]);
  expect((await api.readSource(childId, originalSource.snapshotId)).packet).toEqual(preview.packet);
  if (kind === 'repository')
    expect((await exec('git', ['-C', app.sourceRoot!, 'rev-parse', 'main'])).stdout.trim()).toBe(
      app.sourceOid,
    );
  let publication: Awaited<ReturnType<typeof publicationJourney>> | undefined;
  if (kind === 'repository') {
    // Fake external worker Git output, constrained to its real private task root.
    // The source/main workspaces and application publication owners stay real.
    const git = async (...args: string[]) =>
      (
        await exec(
          'git',
          [
            '-C',
            directory,
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'user.name=Offline',
            '-c',
            'user.email=offline@example.test',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          {
            env: {
              PATH: process.env.PATH,
              HOME: app.root,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
            },
          },
        )
      ).stdout.trim();
    await git('add', 'recording-report.md');
    await git('commit', '-m', 'Synthetic reviewed worker output');
    const sourceHead = await git('rev-parse', 'HEAD'),
      sourceTree = await git('rev-parse', 'HEAD^{tree}');
    await app.record('fake-external-worker-git-output', {
      directory,
      sourceHead,
      sourceTree,
      sourceMainUnchanged: app.sourceOid,
    });
    if ('workspace' in settings) throw Error('Actual repository settings required');
    publication = await publicationJourney(app, settings, sourceHead, sourceTree, start);
  }
  // All current provider turns terminate before original owners close. Source
  // completion and provider termination are distinct observable boundaries.
  finishProviderTurns();
  await prepareColdHandoff(app, handoffPath, {
    itemId: childId,
    taskId,
    sessionIds: [
      origin,
      advisorId,
      leadId,
      workerId,
      ...(publication ? [publication.publisherId] : []),
    ],
    directory,
    inode,
    report,
    artifact: output,
    command: started.command,
    publication,
    canonicalItems: canonicalCompletion.map((receipt) => receipt.item),
  });
  await app.record('initial-app-composition-and-cold-handoff', {
    kind,
    origin,
    advisorId,
    leadId,
    workerId,
    childId,
    taskId,
    output,
    independentDirectories: directories,
    sourceRetained: true,
    firstCommandExactRetry: true,
    publication: publication
      ? 'ACTUAL_NATIVE_SELECTED_CAPABILITY_HOLD_REVALIDATION_UNCERTAINTY_AND_EXACT_RECEIPT_ASSERTED'
      : 'NOT_APPLICABLE_NON_GIT',
    coldApplicationRestart: 'OUTER_DRIVER_MUST_REAP_THIS_APP_PROCESS_THEN_PERFORM_COLD_READBACK',
    realModelCalls: 0,
  });
  // This is the final successful carrier action; fixture data transfer alone
  // cannot preserve a signed session after an earlier oracle/evidence failure.
  app.completeSuccessfulColdHandoff();
}
