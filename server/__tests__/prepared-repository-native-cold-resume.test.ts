import type Database from 'better-sqlite3';
import {
  fixture,
  physical,
  cleanups,
  materializePreparation,
} from './fixtures/prepared-repository-native-consumer.js';
import { createHash } from 'node:crypto';
import { composeOwnedLocalNativeExecutionPolicyForWorkspace } from '../owned-local-codex-native-policy.js';
import { reconcilableLocalCodexCommand } from '../retained-local-codex-effects.js';

import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';

it.each([false, true])(
  'cold-resumes a qualified primary with API account=%s, retaining FIFO and current history',
  async (api) => {
    const f = await fixture(false, 300000, undefined, false, api);
    const result = await f.adopt();
    f.setCwd(result!.directory);
    const sessionId = f.first.sessionId,
      binding = f.first.lease.binding;
    const queued = f.native
      .commands(sessionId, binding)
      .find((command) => command.status === 'queued')!;
    const originalCustody = f.native.readHostCustody(sessionId, binding);
    const originalThread = f.native.read(sessionId, binding).threadId;
    const later = join(result!.directory, 'later-cold.txt');
    await writeFile(later, 'Uncommitted task data remains');
    f.runtime.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: 'clean-cold-command',
      payload: { text: 'Continue original work after clean retirement' },
    };
    const freshClient = { ...f.rpc, close: vi.fn() };
    const dispatch = vi.fn(
      async (
        value: import('../ordinary-local-codex-owned-runtime.js').OrdinaryLocalCodexOwnedDispatch,
      ) => {
        expect(value.resume).toBe(true);
        expect(value.workspace.id).toBe(result!.id);
        expect(value.expected.workspace.cwd).toBe(result!.directory);
        expect(value.lease.privateHome).toBe(f.first.lease.privateHome);
        expect(value.lease.binding).toEqual(binding);
        expect(value.lease).not.toBe(f.first.lease);
        expect(value.lease.client).not.toBe(f.first.lease.client);
        await value.admission.assertCurrent();
        value.admission.assertOptions({
          conversationId: sessionId,
          messageId: request.clientMsgId,
          binding: value.lease.binding,
          profile: value.profile,
          session: { cwd: result!.directory, mode: 'agent' },
          prompt: value.payload.text,
          intent: value.payload.intent ?? value.payload.text,
          systemPrompt: value.payload.systemPrompt,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
          agentProfile: value.expected.agentProfile,
          agentContext: value.expected.agentContext,
          repositoryWorkspace: value.workspace,
          resume: true,
        });
        const input = {
          id: value.commandId,
          prompt: value.payload.text,
          intent: value.payload.intent ?? value.payload.text,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        };
        value.admission.assertBeforeEnqueue(input);
        f.native.enqueue(sessionId, binding, input);
      },
    );
    const cold = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: f.native,
      commandId: request.clientMsgId,
      reservation: { ...f.reservation, id: result!.id },
      launch: () => freshClient,
      ...(api ? { launchApi: async () => freshClient } : {}),
      dispatch,
    });
    cleanups.push(() => cold.close());
    await expect(cold.admitResume(request)).resolves.toEqual({ dispatched: true });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.events.getOrdinaryLocalCommandAdmission(request.clientMsgId)).toMatchObject({
      state: 'consumed',
      preparedRepositoryPrimaryCommandId: queued.id,
    });
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(originalCustody);
    expect(f.native.read(sessionId, binding).threadId).toBe(originalThread);
    expect(
      f.native
        .commands(sessionId, binding)
        .filter((c) => c.status === 'queued')
        .map((c) => c.id),
    ).toEqual([queued.id, request.clientMsgId]);
    const current = dispatch.mock.calls[0][0].admission;
    expect(current.canClaimCommand(queued.id)).toBe(true);
    expect(current.currentPreparedRepositoryPrimaryCommandId()).toBe(queued.id);
    expect(f.native.claimNext(sessionId, binding)?.id).toBe(queued.id);
    current.assertBeforeDispatch(queued.id);
    expect(await readFile(later, 'utf8')).toBe('Uncommitted task data remains');
    // Renew the SAME authenticated operator through the existing real owner,
    // rather than extending the old fixture's expiry for this longer journey.
    const renewedConnection = 'renewed-cold-operator';
    cleanups.push(
      bindAgentLibraryTransport(renewedConnection, { ...f.auth, expiresAt: Date.now() + 300000 }),
    );
    cold.reauthorize(renewedConnection);
    const packet = dispatch.mock.calls[0][0];
    const currentPolicy = () =>
      codexNativeExecutionPolicy({
        bindingRevision: binding.profileRevision!,
        mode: 'agent',
        cwd: result!.directory,
        readableRoots: ['/'],
        writableRoots: [result!.directory],
        deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
        writeProtectedRoots: [],
      });
    const queuedCommand = f.native.commands(sessionId, binding).find((c) => c.id === queued.id)!;
    f.native.prepareNativeExecution(sessionId, binding, queuedCommand, 'thread', currentPolicy());
    f.native.recordNativeTurnAck(sessionId, binding, queuedCommand, 'thread', 'queued-cold-turn');
    f.native.acceptNativeExecution(sessionId, binding, queuedCommand, 'thread', 'queued-cold-turn');
    f.native.finish(sessionId, binding, queuedCommand.id, 'completed', 'queued-cold-turn');
    const sourceCommand = f.native.claimNext(sessionId, binding)!;
    current.assertBeforeDispatch(sourceCommand.id);
    f.native.prepareNativeExecution(sessionId, binding, sourceCommand, 'thread', currentPolicy());
    f.native.recordNativeTurnAck(sessionId, binding, sourceCommand, 'thread', 'explicit-cold-turn');
    f.native.acceptNativeExecution(
      sessionId,
      binding,
      sourceCommand,
      'thread',
      'explicit-cold-turn',
    );
    const source = Object.freeze({
      commandId: sourceCommand.id,
      attempt: sourceCommand.attempt,
      threadId: 'thread',
      turnId: 'explicit-cold-turn',
      generation: 0,
    });
    const second = await materializePreparation(f, packet, source);
    physical.creation.mockImplementation(async () => {
      const task = structuredClone(second.taskIdentity);
      delete task.localSource;
      return task;
    });
    const identity = {
      ...source,
      callId: second.request.prepareCallId,
      toolName: 'PrepareLocalRepository' as const,
      requestHash: second.request.requestHash,
    };
    f.native.claimTool(
      sessionId,
      binding,
      source.commandId,
      second.request.prepareCallId,
      identity,
    );
    f.native.recordToolResult(
      sessionId,
      binding,
      source.commandId,
      second.request.prepareCallId,
      identity,
      { content: JSON.stringify({ preparationId: second.record.id }), isError: false },
    );
    f.native.finish(sessionId, binding, source.commandId, 'completed', source.turnId);
    expect(
      f.native.completedPreparedRepositoryResultSha256(
        sessionId,
        binding,
        source,
        second.request.prepareCallId,
        second.request.requestHash,
      ),
    ).toMatch(/^[a-f0-9]{64}$/);

    const policyOwner = Object.freeze({
      signal: f.signal.signal,
      selectedPolicy: currentPolicy,
      assertCurrentSync: () => current.assertCurrentSync(),
    });
    const secondResult = await withPreparedRepositoryBarrierReadScope(
      currentPolicy(),
      source.commandId,
      {
        signal: f.signal.signal,
        selectedPolicy: currentPolicy,
        assertCurrentSync: () => current.assertPreparedRepositoryBoundaryCurrentSync(),
        revalidate: () => current.assertCurrent(),
      },
      (scope) => current.adoptPreparedRepositoryAtBoundary(scope, source, () => {}, policyOwner),
    );
    expect(secondResult?.id).toBe(second.record.id);
    const nextPrimary =
      f.workspace.getForConversation(sessionId)!.preparedRepositoryTransitionAdoption!
        .childCommandId;
    expect(f.events.observePreparedRepositoryContinuation(nextPrimary)).toMatchObject({
      state: 'consumed',
      preparedRepositoryTransition: {
        priorPrimaryCommandId: queued.id,
        source: { commandId: request.clientMsgId },
      },
    });
    expect(f.native.readHostCustody(sessionId, binding)).toEqual(originalCustody);
    expect(f.native.read(sessionId, binding).threadId).toBe(originalThread);
    expect(await readFile(later, 'utf8')).toBe('Uncommitted task data remains');
    // Two preparations plus a fresh cold bootstrap retain EVERY full check
    // (15 fresh workspace checks in the baseline). The two existing 300s real
    // operator lifetimes still bound authority; this finite whole-test envelope
    // also allows setup, FIFO/receipt assertions and joined cleanup.
  },
  720000,
);

it('reconciles the interrupted automatic prepared continuation after restart without dispatching again', async () => {
  const f = await fixture(false, 300000);
  const target = (await f.adopt())!;
  f.setCwd(target.directory);
  const id = f.first.sessionId,
    binding = f.first.lease.binding;
  const command = f.native.claimNext(id, binding)!;
  f.admission.assertBeforeDispatch(command.id);
  const policy = composeOwnedLocalNativeExecutionPolicyForWorkspace(
    {
      binding,
      assertCurrentSync: () => f.admission.assertCurrentSync(),
    },
    () => ({
      cwd: target.directory,
      workspaceRoots: [target.directory],
      mode: 'agent',
      authSessionId: f.auth.id,
    }),
  );
  const thread = f.native.read(id, binding).threadId!;
  f.native.prepareNativeExecution(id, binding, command, thread, policy);
  f.native.recordNativeTurnAck(id, binding, command, thread, 'interrupted-continuation');
  f.native.acceptNativeExecution(id, binding, command, thread, 'interrupted-continuation');
  f.native.observeEmptyCompletionPhase(
    id,
    binding,
    command,
    thread,
    'interrupted-continuation',
    createHash('sha256').update(target.directory).digest('hex'),
    policy.policyRevision,
  );
  f.native.pauseForRecovery(
    id,
    binding,
    command.id,
    'interrupted',
    'resume',
    undefined,
    true,
    true,
  );
  const before = {
    receipt: f.events.getOrdinaryLocalCommandExecutionAdmission(command.id),
    command: f.native.commands(id, binding).find((item) => item.id === command.id)!,
    custody: f.native.readHostCustody(id, binding),
  };
  const edited = join(target.directory, 'retained-jira-policy.txt');
  await writeFile(edited, 'Uncommitted implementation remains');
  f.runtime.close();
  const request = f.rpc.request.getMockImplementation()!;
  const freshClient = {
    ...f.rpc,
    close: vi.fn(),
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'thread/turns/list')
        return { data: [{ id: 'interrupted-continuation', status: 'interrupted', error: null }] };
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      return request(method, params);
    }),
  };
  const dispatch = vi.fn();
  const cold = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: f.native,
    commandId: command.id,
    reservation: { ...f.reservation, id: target.id },
    launch: () => freshClient,
    dispatch,
  });
  cleanups.push(() => cold.close());
  expect(reconcilableLocalCodexCommand(f.events, f.native, id, f.auth.id, f.workspace)).toBe(
    command.id,
  );
  const claims = vi.spyOn(f.events, 'claimOrdinaryLocalCommandDispatch');
  const eventsDb = (f.events as unknown as { db: Database.Database }).db;
  const originalAdmission = (
    eventsDb
      .prepare('SELECT ordinary_admission FROM send_commands WHERE client_msg_id=?')
      .get(command.id) as { ordinary_admission: string }
  ).ordinary_admission;
  const inconsistent = JSON.parse(originalAdmission);
  inconsistent.preparedRepositoryTransition.materializedRecordSha256 = 'f'.repeat(64);
  eventsDb
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(JSON.stringify(inconsistent), command.id);
  expect(
    reconcilableLocalCodexCommand(f.events, f.native, id, f.auth.id, f.workspace),
  ).toBeUndefined();
  await expect(cold.reconcileRetainedEffects()).rejects.toThrow();
  expect(f.native.read(id, binding).recovery).toBe(1);
  expect(freshClient.request).not.toHaveBeenCalled();
  eventsDb
    .prepare('UPDATE send_commands SET ordinary_admission=? WHERE client_msg_id=?')
    .run(originalAdmission, command.id);
  await cold.reconcileRetainedEffects();
  expect(f.native.read(id, binding).recovery).toBe(0);
  expect(f.native.continuationBlocker(id, binding)).toBeUndefined();
  expect(f.native.commands(id, binding).find((item) => item.id === command.id)).toMatchObject({
    id: before.command.id,
    status: before.command.status,
    attempt: before.command.attempt,
    prompt: before.command.prompt,
    environmentContinuation: before.command.environmentContinuation,
  });
  expect(f.events.getOrdinaryLocalCommandExecutionAdmission(command.id)).toEqual(before.receipt);
  expect(f.native.readHostCustody(id, binding)).toEqual(before.custody);
  expect(await readFile(edited, 'utf8')).toBe('Uncommitted implementation remains');
  expect(dispatch).not.toHaveBeenCalled();
  expect(claims).not.toHaveBeenCalled();
  expect(
    freshClient.request.mock.calls.some(([method]) =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(method),
    ),
  ).toBe(false);
  expect(physical.reader).toHaveBeenCalled();
  expect(freshClient.close).toHaveBeenCalled();
});
