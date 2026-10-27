import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { RetainedLocalCodexRecovery } from '../retained-local-codex-recovery.js';
import Database from 'better-sqlite3';
import { CodexConversation } from '../codex-conversation.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';
vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(['before-enqueue', 'after-enqueue', 'accepted-paused'] as const)(
  'recovers the exact retained %s command without replacing the chat, checkout or receipt',
  async (failure) => {
    const f = await ownedRuntimeFixture(cleanups),
      first = f.create();
    await first.admit(f.request);
    const original = f.dispatch.mock.calls[0][0];
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'retained-thread');
    first.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Continue the unfinished task' },
    };
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      if (failure === 'before-enqueue') throw Error('bootstrap deadline before native enqueue');
      native.enqueue(value.sessionId, value.lease.binding, {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      });
      if (failure === 'after-enqueue') throw Error('provider history failed on empty replacement');
    });
    const failed = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: request.clientMsgId,
      dispatch,
      launch: () => f.rpc,
    });
    cleanups.push(() => failed.close());
    if (failure === 'accepted-paused') await failed.admitResume(request);
    else await expect(failed.admitResume(request)).rejects.toThrow();
    failed.close();
    const receipt = f.events.getOrdinaryCommandAdmission(request.clientMsgId)!;
    const checkout = original.workspace.directory!;
    writeFileSync(join(checkout, 'unfinished.txt'), 'preserve my uncommitted work');
    f.events.markManuallyRenamed(original.sessionId);
    f.events.upsertSession({ sessionId: original.sessionId, summary: 'Manually renamed task' });
    let recovered: CodexConversation | undefined;
    let turns = 0;
    let callbacks: CodexLifecycleTransport | undefined;
    const rpc = f.rpc.request.getMockImplementation()!;
    f.rpc.request.mockImplementation(async (method) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return {
          thread: { id: 'recovery-provider-thread' },
          model: f.request.selection.model,
          modelProvider: 'openai',
        };
      if (method === 'turn/start') return { turn: { id: `recovered-turn-${++turns}` } };
      if (method === 'thread/turns/list') throw Error('Empty replacement has no provider history');
      return rpc(method);
    });
    const recoverDispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      expect(value.recovery).toBe(true);
      expect(value.resume).toBe(true);
      expect(value.workspace.directory).toBe(checkout);
      value.admission.persistCustody(native);
      value.admission.assertOptions({
        conversationId: value.sessionId,
        messageId: value.commandId,
        binding: value.lease.binding,
        profile: value.profile,
        session: { cwd: checkout, mode: 'agent' },
        prompt: value.payload.text,
        intent: value.payload.intent,
        systemPrompt: value.payload.systemPrompt,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
        agentProfile: value.expected.agentProfile,
        agentContext: value.expected.agentContext,
        repositoryWorkspace: value.workspace,
        resume: true,
      });
      recovered = new CodexConversation({
        conversationId: value.sessionId,
        cwd: checkout,
        systemPrompt: value.payload.systemPrompt,
        profile: value.profile,
        storedBinding: value.lease.binding,
        store: native,
        ownerKind: 'ordinary',
        transportClosure: 'terminal',
        deferToolSurfaceReplacement: true,
        tools: [],
        emit: () => {},
        onError: () => {},
        executeTool: async () => {
          throw Error('No live tools');
        },
        verifyBinding: async () => {
          await value.admission.assertCurrent();
          return value.lease.binding;
        },
        beforeEnqueue: (input) => value.admission.assertBeforeEnqueue(input),
        canClaimCommand: (id) => value.admission.canClaimCommand(id),
        beforeThreadInitialization: () => value.admission.persistCustody(native),
        onProviderDispatch: (id) => value.admission.assertBeforeDispatch(id),
        createClient: (owner) => {
          callbacks = owner;
          return value.admission.attach(owner);
        },
        loadConversationHistory: () => [
          { role: 'user', text: 'The original task' },
          { role: 'assistant', text: 'Task work retained' },
        ],
      });
      cleanups.push(() => recovered!.close());
      await recovered.initialize();
      await recovered.admitExplicitSend({
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.intent ?? value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      });
      expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(
        0,
      );
    });
    const recovery = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: request.clientMsgId,
      dispatch: recoverDispatch,
      dispatchContinuation: async (value) => {
        await recovered!.admitExplicitSend({
          id: value.commandId,
          prompt: value.payload.text,
          intent: value.payload.intent ?? value.payload.text,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
      },
      launch: () => f.rpc,
    });
    cleanups.push(() => recovery.close());
    await expect(recovery.recoverResume(request)).resolves.toEqual({ dispatched: true });
    expect(recoverDispatch).toHaveBeenCalledOnce();
    expect(f.events.getOrdinaryCommandAdmission(request.clientMsgId)).toEqual({
      ...receipt,
      state: 'consumed',
    });
    expect(
      native
        .commands(original.sessionId, original.lease.binding)
        .filter((c) => c.id === request.clientMsgId),
    ).toHaveLength(1);
    expect(readFileSync(join(checkout, 'unfinished.txt'), 'utf8')).toBe(
      'preserve my uncommitted work',
    );
    expect(f.events.getSession(original.sessionId)?.summary).toBe('Manually renamed task');
    await expect(recovery.recoverResume(request)).resolves.toEqual({ dispatched: false });
    expect(recoverDispatch).toHaveBeenCalledOnce();
    await recovered!.resumeAfterExplicitSend();
    expect(f.rpc.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1);
    callbacks!.onNotification('turn/completed', {
      threadId: 'recovery-provider-thread',
      turn: { id: 'recovered-turn-1', status: 'completed' },
    });
    expect(native.commands(original.sessionId, original.lease.binding)).toMatchObject([
      { id: request.clientMsgId, status: 'completed', attempt: 1 },
    ]);
    for (let turn = 2; turn <= 4; turn++) {
      const followup = {
        ...request,
        clientMsgId: randomUUID(),
        payload: { text: `Continue turn ${turn}` },
      };
      await expect(recovery.admitContinuation(followup)).resolves.toEqual({ dispatched: true });
      await recovered!.resumeAfterExplicitSend();
      callbacks!.onNotification('turn/completed', {
        threadId: 'recovery-provider-thread',
        turn: { id: `recovered-turn-${turn}`, status: 'completed' },
      });
      expect(native.commands(original.sessionId, original.lease.binding).at(-1)).toMatchObject({
        id: followup.clientMsgId,
        status: 'completed',
        attempt: 1,
      });
    }
    expect(turns).toBe(4);
  },
);

it.each([
  'payload',
  'account',
  'workspace',
  'running',
  'interrupted',
  'completed',
  'prior-attempt',
  'missing-primary',
] as const)(
  'refuses %s drift or possible effects without rewriting retained evidence',
  async (change) => {
    const f = await ownedRuntimeFixture(cleanups),
      first = f.create();
    await first.admit(f.request);
    const original = f.dispatch.mock.calls[0][0];
    const native = new CodexConversationStore(join(f.root, 'native.db'));
    cleanups.push(() => native.close());
    native.create(original.sessionId, original.lease.binding, original.workspace.directory!);
    original.admission.persistCustody(native);
    native.bindThread(original.sessionId, original.lease.binding, 'original-thread');
    first.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: { text: 'Exact next input' },
    };
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      native.enqueue(value.sessionId, value.lease.binding, {
        id: value.commandId,
        prompt: value.payload.text,
        model: value.expected.selection.model,
        reasoningEffort: value.expected.selection.thinking,
      });
      throw Error('After enqueue, before completion');
    });
    const failed = new OrdinaryLocalCodexOwnedRuntime({
      ...f.dependencies,
      nativeStore: native,
      commandId: request.clientMsgId,
      dispatch,
      launch: () => f.rpc,
    });
    cleanups.push(() => failed.close());
    await expect(failed.admitResume(request)).rejects.toThrow();
    failed.close();
    if (change === 'missing-primary') {
      const corrupt = new Database(join(f.root, 'events.db'));
      corrupt
        .prepare(
          "UPDATE send_commands SET ordinary_admission=json_set(ordinary_admission,'$.preparedRepositoryPrimaryCommandId','missing-primary') WHERE client_msg_id=?",
        )
        .run(request.clientMsgId);
      corrupt.close();
      expect(() =>
        f.events.observePreparedRepositoryCommandRouting(request.clientMsgId, true),
      ).toThrow('lineage');
    }
    if (change === 'payload') request.payload.text = 'Changed input';
    if (change === 'workspace') {
      const corrupt = new Database(join(f.root, 'events.db'));
      corrupt
        .prepare('UPDATE sessions SET cwd=? WHERE session_id=?')
        .run('/different-task', original.sessionId);
      corrupt.close();
    }
    if (['running', 'interrupted', 'completed', 'prior-attempt'].includes(change)) {
      native.claimNext(original.sessionId, original.lease.binding);
      if (change !== 'running')
        native.finish(
          original.sessionId,
          original.lease.binding,
          request.clientMsgId,
          change === 'completed' ? 'completed' : 'interrupted',
        );
      if (change === 'prior-attempt') {
        const corrupt = new Database(join(f.root, 'native.db'));
        corrupt
          .prepare("UPDATE codex_commands SET attempt=2,status='queued' WHERE id=?")
          .run(request.clientMsgId);
        corrupt.close();
      }
    }
    const receipt = f.events.getSendCommand(request.clientMsgId);
    const queue = native.commands(original.sessionId, original.lease.binding);
    expect(() =>
      RetainedLocalCodexRecovery.capture(
        f.events,
        native,
        original.sessionId,
        change === 'account' ? 'foreign-login' : f.auth.id,
        request,
      ),
    ).toThrow();
    expect(f.events.getSendCommand(request.clientMsgId)).toEqual(receipt);
    expect(native.commands(original.sessionId, original.lease.binding)).toEqual(queue);
  },
);
