import { initializeTaskExecution, closeTaskExecution } from '../task-execution-runtime.js';
import { retainCallbackOutcome } from '../turn-callbacks.js';
import { composeOwnedLocalNativeExecutionPolicyForWorkspace } from '../owned-local-codex-native-policy.js';
import { registerWorkspaceRuntimeAuthorityPaths } from '../workspace-runtime-private-paths.js';
import { login, authenticateToken, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { reconcilableLocalCodexCommand } from '../retained-local-codex-effects.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import {
  RetainedLocalCodexRecovery,
  recoverableLocalCodexCommand,
} from '../retained-local-codex-recovery.js';
import Database from 'better-sqlite3';
import { CodexConversation } from '../codex-conversation.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';
// Recovery fixtures use synthetic credentials only; do not inspect the host's
// denied credential home while composing fresh native protection policies.
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: () => `${actual.tmpdir()}/mitzo-recovery-offline-home` };
});
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

it.each(['before-enqueue', 'after-enqueue', 'accepted-paused', 'accepted-paused-rich'] as const)(
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
    const interruptedPredecessor = failure === 'accepted-paused';
    native.bindThread(
      original.sessionId,
      original.lease.binding,
      'retained-thread',
      interruptedPredecessor ? createHash('sha256').update('{}').digest('hex') : undefined,
    );
    if (interruptedPredecessor) {
      const request = f.rpc.request.getMockImplementation()!;
      f.rpc.request.mockImplementation(async (method, params) => {
        if (method === 'thread/resume' || method === 'thread/start')
          return {
            thread: { id: 'retained-thread' },
            model: f.request.selection.model,
            modelProvider: 'openai',
          };
        if (method === 'turn/start') return { turn: { id: 'predecessor-turn' } };
        return request(method, params);
      });
      const predecessor = new CodexConversation({
        conversationId: original.sessionId,
        cwd: original.workspace.directory!,
        systemPrompt: original.payload.systemPrompt,
        profile: original.profile,
        storedBinding: original.lease.binding,
        store: native,
        tools: [],
        transportClosure: 'terminal',
        verifyBinding: async () => original.lease.binding,
        createClient: () => f.rpc,
        emit: () => {},
        onError: () => {},
        executeTool: async () => {
          throw Error('No host tools');
        },
      });
      await predecessor.initialize();
      await predecessor.send({ id: f.request.clientMsgId, prompt: 'Original accepted work' });
      predecessor.close();
      // Keep this existing consumer journey: recovery must cross real retained
      // admission and custody before settling an interrupted predecessor.
      f.rpc.request.mockClear();
    }
    first.close();
    const request = {
      ...structuredClone(f.request),
      clientMsgId: randomUUID(),
      payload: {
        text:
          failure === 'accepted-paused-rich'
            ? 'Retained message '.repeat(80000)
            : 'Continue the unfinished task',
        ...(failure === 'accepted-paused-rich'
          ? {
              images: Array.from({ length: 30 }, (_, i) => ({
                data: Buffer.from(`screenshot-${i}-`.repeat(5)).toString('base64'),
                mediaType: 'image/png',
              })),
            }
          : {}),
      },
    };
    const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
      if (failure === 'before-enqueue') throw Error('bootstrap deadline before native enqueue');
      native.enqueue(value.sessionId, value.lease.binding, {
        id: value.commandId,
        prompt: value.payload.text,
        intent: value.payload.text,
        images: value.payload.images,
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
    if (failure.startsWith('accepted-paused')) await failed.admitResume(request);
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
          thread: { id: interruptedPredecessor ? 'retained-thread' : 'recovery-provider-thread' },
          model: f.request.selection.model,
          modelProvider: 'openai',
        };
      if (method === 'turn/start') return { turn: { id: `recovered-turn-${++turns}` } };
      if (method === 'thread/turns/list') {
        if (interruptedPredecessor)
          return {
            data: [
              {
                id: 'predecessor-turn',
                status: 'interrupted',
                itemsView: 'notLoaded',
                error: null,
                items: [],
              },
            ],
          };
        throw Error('Empty replacement has no provider history');
      }
      if (method === 'thread/items/list' && interruptedPredecessor)
        return { data: [], nextCursor: null };
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
        images: value.payload.images,
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
        assertRecoveryCurrent: () => value.admission.assertCurrentSync(),
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
        images: value.payload.images,
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
          images: value.payload.images,
          model: value.expected.selection.model,
          reasoningEffort: value.expected.selection.thinking,
        });
      },
      launch: () => f.rpc,
    });
    cleanups.push(() => recovery.close());
    await expect(recovery.recoverResume(request)).resolves.toEqual({ dispatched: true });
    expect(recoverDispatch).toHaveBeenCalledOnce();
    expect(f.events.getSendCommand(request.clientMsgId)?.payload).toMatchObject(request.payload);
    const retained = native
      .commands(original.sessionId, original.lease.binding)
      .find((command) => command.id === request.clientMsgId)!;
    expect(retained).toMatchObject({
      id: request.clientMsgId,
      prompt: request.payload.text,
      intent: request.payload.text,
      model: request.selection.model,
      reasoningEffort: request.selection.thinking,
    });
    expect(retained.images ?? []).toEqual(request.payload.images ?? []);
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
      threadId: interruptedPredecessor ? 'retained-thread' : 'recovery-provider-thread',
      turn: { id: 'recovered-turn-1', status: 'completed' },
    });
    expect(native.commands(original.sessionId, original.lease.binding)).toMatchObject([
      ...(interruptedPredecessor
        ? [{ id: f.request.clientMsgId, status: 'interrupted', attempt: 1 }]
        : []),
      { id: request.clientMsgId, status: 'completed', attempt: 1 },
    ]);
    // The before/after-enqueue text cases retain repeated-follow-up coverage.
    // Interrupted/rich recovery needs one continuation across the same owner;
    // repeating that admission adds setup cost without a distinct boundary.
    const lastTurn = failure === 'accepted-paused-rich' || interruptedPredecessor ? 2 : 4;
    for (let turn = 2; turn <= lastTurn; turn++) {
      const followup = {
        ...request,
        clientMsgId: randomUUID(),
        payload: { text: `Continue turn ${turn}` },
      };
      await expect(recovery.admitContinuation(followup)).resolves.toEqual({ dispatched: true });
      await recovered!.resumeAfterExplicitSend();
      callbacks!.onNotification('turn/completed', {
        threadId: interruptedPredecessor ? 'retained-thread' : 'recovery-provider-thread',
        turn: { id: `recovered-turn-${turn}`, status: 'completed' },
      });
      expect(native.commands(original.sessionId, original.lease.binding).at(-1)).toMatchObject({
        id: followup.clientMsgId,
        status: 'completed',
        attempt: 1,
      });
    }
    expect(turns).toBe(lastTurn);
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

async function reconcileRetainedColdTurn(
  nativeStatus: 'interrupted' | 'completed' | 'failed',
  policyDrift = false,
  completionPhase = true,
  uncertainGithubRead = false,
) {
  const f = await ownedRuntimeFixture(cleanups);
  const first = f.create();
  await first.admit(f.request);
  const original = f.dispatch.mock.calls[0][0];
  const native = new CodexConversationStore(join(f.root, 'effects.db'));
  cleanups.push(() => native.close());
  const id = original.sessionId,
    binding = original.lease.binding;
  native.create(id, binding, original.workspace.directory!);
  original.admission.persistCustody(native);
  native.bindThread(id, binding, 'original-thread');
  native.enqueue(id, binding, { id: f.request.clientMsgId, prompt: f.request.payload.text });
  const command = native.claimNext(id, binding)!;
  // A later accepted turn can belong to a reconnecting login rather than the
  // creating login retained in chat custody. Neither is the current actor below.
  const executionLogin = randomUUID();
  const policy = composeOwnedLocalNativeExecutionPolicyForWorkspace(
    {
      binding,
      assertCurrentSync: () => original.admission.assertCurrentSync(),
    },
    () => ({
      cwd: original.workspace.directory!,
      mode: original.expected.selection.permission.mode,
      workspaceRoots: [original.workspace.directory!],
      authSessionId: executionLogin,
    }),
  );
  native.prepareNativeExecution(id, binding, command, 'original-thread', policy);
  native.recordNativeTurnAck(id, binding, command, 'original-thread', 'original-turn');
  native.acceptNativeExecution(id, binding, command, 'original-thread', 'original-turn');
  const taskStore = !completionPhase
    ? initializeTaskExecution(join(f.root, 'events.db'))
    : undefined;
  if (taskStore) cleanups.push(closeTaskExecution);
  const grant = taskStore?.approve(
    native.readHostCustody(id, binding)!.authSessionId,
    id,
    randomUUID(),
    {
      title: 'Original task',
      network: 'none',
      repositories: [],
      expiresAt: Date.now() + 60000,
      members: [
        {
          sessionId: id,
          fingerprint: 'original-task-scope',
          roots: [original.workspace.directory!],
          account: binding,
        },
      ],
    },
  );
  const arguments_: Record<string, unknown> = grant
    ? uncertainGithubRead
      ? {
          operation: 'github_read',
          endpoint: '/repos/example/project/pulls/1',
          grantId: grant.id,
          requestId: randomUUID(),
        }
      : {
          operation: 'run',
          command: 'exit 1',
          grantId: grant.id,
          requestId: randomUUID(),
        }
    : policyDrift
      ? { conversationId: 'registered-past-session' }
      : {
          operation: 'fetch',
          url: 'http://localhost:16686/api/v3/traces',
          reason: 'inspect',
        };
  const retainedResult = { content: 'Original operation failed.', isError: true };
  const runFingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        uncertainGithubRead ? 'GitHubRead' : 'Bash',
        uncertainGithubRead
          ? { endpoint: arguments_.endpoint, access: 'authenticated' }
          : { command: 'exit 1' },
        original.workspace.directory!,
        60000,
      ]),
    )
    .digest('hex');
  if (taskStore && grant) {
    taskStore.begin(grant.id, id, String(arguments_.requestId), runFingerprint);
    if (!uncertainGithubRead)
      taskStore.finish(grant.id, id, String(arguments_.requestId), retainedResult);
    taskStore.revoke(grant.id, grant.operatorId, id); // Past evidence is not renewed execution authority.
  }
  const identity = {
    turnId: 'original-turn',
    toolName: taskStore ? 'TaskExecution' : policyDrift ? 'ReadPastSession' : 'RequestWebAccess',
    requestHash: createHash('sha256').update(JSON.stringify(arguments_)).digest('hex'),
  };
  native.claimTool(id, binding, command.id, 'failed-read', identity);
  native.recordToolResult(id, binding, command.id, 'failed-read', identity, retainedResult);
  const peerInput = {
    operation: 'send',
    requestId: randomUUID(),
    recipientConversationId: 'other-chat',
    text: 'Original requested message',
  };
  if (taskStore) {
    const peerIdentity = {
      turnId: 'original-turn',
      toolName: 'AgentCommunication',
      requestHash: createHash('sha256').update(JSON.stringify(peerInput)).digest('hex'),
    };
    native.claimTool(id, binding, command.id, 'failed-peer', peerIdentity);
    native.recordToolResult(id, binding, command.id, 'failed-peer', peerIdentity, {
      content: 'Original send refused',
      isError: true,
    });
  }

  const db = (native as unknown as { db: Database.Database }).db;
  if (!taskStore && !policyDrift)
    db.prepare('UPDATE codex_tools SET result_effect_outcome=NULL').run(); // original legacy receipt
  if (policyDrift && completionPhase) {
    // Reuse this real owned-store fixture for the completed history-read case.
    // Readiness is a negative observation, never a fabricated effect settlement.
    const commandBefore = db
      .prepare('SELECT * FROM codex_commands WHERE id=?')
      .get(command.id) as Record<string, unknown>;
    const ownerBefore = db
      .prepare('SELECT * FROM codex_conversations WHERE id=?')
      .get(id) as Record<string, unknown>;
    const receiptsBefore = db.prepare('SELECT * FROM codex_tools').all();
    db.prepare("UPDATE codex_commands SET status='completed',ambiguous=0 WHERE id=?").run(
      command.id,
    );
    expect(native.deploymentRecoveryPending()).toBe(false);
    // Older completed intrinsic reads must use the same reviewed contract.
    for (const tool of ['GitHubRead', 'Read', 'DescribeIntegrationTool']) {
      db.prepare("UPDATE codex_tools SET tool_name=? WHERE call_id='failed-read'").run(tool);
      expect(native.deploymentRecoveryPending()).toBe(false);
    }
    db.prepare("UPDATE codex_tools SET tool_name=? WHERE call_id='failed-read'").run(
      identity.toolName,
    );
    for (const [table, key, column, value, originalValue] of [
      ['codex_commands', command.id, 'status', 'interrupted', 'completed'],
      [
        'codex_commands',
        command.id,
        'native_execution_history',
        null,
        commandBefore.native_execution_history,
      ],
      ['codex_commands', command.id, 'native_turns', null, commandBefore.native_turns],
      ['codex_conversations', id, 'host_custody', null, ownerBefore.host_custody],
      ['codex_conversations', id, 'binding', '[]', ownerBefore.binding],
      ['codex_conversations', id, 'owner_kind', 'symposium', ownerBefore.owner_kind],
    ] as const) {
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(value, key);
      expect(native.deploymentRecoveryPending()).toBe(true);
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(originalValue, key);
    }
    for (const [column, value, originalValue] of [
      ['turn_id', 'different-turn', identity.turnId],
      ['request_hash', null, identity.requestHash],
      ['tool_name', 'mcp__configured__ReadPastSession', identity.toolName],
      ['result_content', null, retainedResult.content],
    ] as const) {
      db.prepare(`UPDATE codex_tools SET ${column}=? WHERE call_id='failed-read'`).run(value);
      expect(native.deploymentRecoveryPending()).toBe(true);
      db.prepare(`UPDATE codex_tools SET ${column}=? WHERE call_id='failed-read'`).run(
        originalValue,
      );
    }
    // A single unknown write alongside the read must keep the global fence.
    db.prepare("UPDATE codex_commands SET status='running' WHERE id=?").run(command.id);
    const writeIdentity = { ...identity, toolName: 'Write' };
    native.claimTool(id, binding, command.id, 'unknown-write', writeIdentity);
    native.recordToolResult(
      id,
      binding,
      command.id,
      'unknown-write',
      writeIdentity,
      retainedResult,
    );
    db.prepare("UPDATE codex_commands SET status='completed' WHERE id=?").run(command.id);
    expect(native.deploymentRecoveryPending()).toBe(true);
    db.prepare("DELETE FROM codex_tools WHERE call_id='unknown-write'").run();
    expect(native.deploymentRecoveryPending()).toBe(false);
    expect(db.prepare('SELECT * FROM codex_tools').all()).toEqual(receiptsBefore);
    expect(db.prepare('SELECT count(*) AS n FROM codex_effect_settlements').get()).toEqual({
      n: 0,
    });
    db.prepare("UPDATE codex_commands SET status='running' WHERE id=?").run(command.id);
  }

  if (completionPhase)
    native.observeEmptyCompletionPhase(
      id,
      binding,
      command,
      'original-thread',
      'original-turn',
      createHash('sha256').update(original.workspace.directory!).digest('hex'),
      policy.policyRevision,
    );
  const retainedStatus = nativeStatus === 'failed' ? 'failed' : 'interrupted';
  native.pauseForRecovery(id, binding, command.id, retainedStatus, 'resume', undefined, true, true);
  native.enqueue(id, binding, { id: 'saved-follow-up', prompt: 'Preserve queued work' });
  const custody = native.readHostCustody(id, binding)!;
  const draft = join(original.workspace.directory!, 'unfinished-work.txt');
  writeFileSync(draft, 'Preserve the interrupted task');
  if (policyDrift) {
    const newlySelectedRuntime = join(f.root, 'new-runtime-executable');
    writeFileSync(newlySelectedRuntime, 'offline runtime fixture');
    registerWorkspaceRuntimeAuthorityPaths([newlySelectedRuntime]);
    const fresh = composeOwnedLocalNativeExecutionPolicyForWorkspace(
      { binding, assertCurrentSync: () => original.admission.assertCurrentSync() },
      () => ({
        cwd: original.workspace.directory!,
        mode: original.expected.selection.permission.mode,
        workspaceRoots: [original.workspace.directory!],
        authSessionId: executionLogin,
      }),
    );
    expect(fresh.policyRevision).not.toBe(policy.policyRevision);
  }
  const before = {
    send: f.events.getSendCommand(command.id),
    admission: f.events.getOrdinaryLocalCommandExecutionAdmission(command.id),
    command: native.commands(id, binding),
    tools: db.prepare('SELECT * FROM codex_tools').all(),
  };
  first.close();
  const probe = f.commandFor(f.reservation, f.request, true);
  const token = await login(process.env.AUTH_PASSPHRASE!);
  const actor = (await authenticateToken(token!))!;
  expect(actor.id).not.toBe(custody.authSessionId);
  expect(actor.id).not.toBe(executionLogin);
  const connectionId = randomUUID();
  cleanups.push(() => revokeAuthSession(actor), bindAgentLibraryTransport(connectionId, actor));
  const baseRequest = probe.rpc.request.getMockImplementation()!;
  let afterItem = () => {};
  probe.rpc.request.mockImplementation(async (method, params) => {
    if (method === 'thread/read')
      return {
        thread: {
          id: params?.threadId,
          parentThreadId: params?.threadId === 'original-thread' ? null : 'original-thread',
          sessionId: 'original-tree',
          cwd: original.workspace.directory!,
          modelProvider: 'openai',
          status: { type: 'notLoaded' },
        },
      };
    if (method === 'thread/turns/list')
      return {
        data: [
          {
            id: params?.threadId === 'child' ? 'child-turn' : 'original-turn',
            status: params?.threadId === 'child' ? 'completed' : nativeStatus,
            error:
              nativeStatus === 'failed'
                ? { message: 'The model is at capacity', codexErrorInfo: 'serverOverloaded' }
                : null,
          },
        ],
        nextCursor: null,
      };
    if (method === 'thread/items/list') {
      afterItem();
      if (params?.threadId === 'child')
        return {
          data: [
            {
              turnId: 'child-turn',
              item: {
                id: 'child-read',
                type: 'dynamicToolCall',
                tool: 'DescribeIntegrationTool',
                arguments: { name: 'GitHubRead' },
                status: 'failed',
                success: false,
              },
            },
          ],
          nextCursor: null,
        };
      if (params?.cursor === 'peer-refusal')
        return {
          data: [
            {
              turnId: 'original-turn',
              item: {
                id: 'failed-peer',
                type: 'dynamicToolCall',
                tool: 'AgentCommunication',
                arguments: peerInput,
                status: 'failed',
                success: false,
              },
            },
          ],
          nextCursor: null,
        };
      if (params?.cursor === 'child-activity')
        return {
          data: [
            {
              turnId: 'original-turn',
              item: {
                id: 'child-start',
                type: 'subAgentActivity',
                kind: 'started',
                agentThreadId: 'child',
              },
            },
          ],
          nextCursor: null,
        };
      return {
        data: [
          {
            turnId: 'original-turn',
            item: {
              id: 'failed-read',
              type: 'dynamicToolCall',
              tool: identity.toolName,
              arguments: arguments_,
              status: 'failed',
              success: false,
            },
          },
        ],
        nextCursor: taskStore ? 'peer-refusal' : policyDrift ? 'child-activity' : null,
      };
    }
    return baseRequest(method, params);
  });
  const driver = new OrdinaryLocalCodexOwnedRuntime({
    ...probe.dependencies,
    operatorConnectionId: connectionId,
    nativeStore: native,
  });
  cleanups.push(() => driver.close());
  expect(reconcilableLocalCodexCommand(f.events, native, id, actor.id, f.workspace)).toBe(
    command.id,
  );
  const inputCandidates = vi.spyOn(native, 'undispatchedRecoveryCandidateIds');
  expect(recoverableLocalCodexCommand(f.events, native, id, actor.id)).toBeUndefined();
  expect(inputCandidates).not.toHaveBeenCalled();
  const claims = vi.spyOn(f.events, 'claimOrdinaryLocalCommandDispatch');
  const latest = f.events.getLatestEvent.bind(f.events);
  for (const scope of [
    'adviser_task_scope',
    'telos_work_role_context',
    'contributor_guidance',
    'contributor_execution',
    'ordinary_task_worker_allocation',
  ]) {
    const readScope = vi
      .spyOn(f.events, 'getLatestEvent')
      .mockImplementation((session, type) =>
        type === scope ? ({ payload: {} } as never) : latest(session, type),
      );
    expect(
      reconcilableLocalCodexCommand(f.events, native, id, custody.authSessionId, f.workspace),
    ).toBeUndefined();
    readScope.mockRestore();
  }
  const readWorkspace = f.workspace.get.bind(f.workspace);
  const prepared = vi.spyOn(f.workspace, 'get').mockImplementation((workspaceId) => ({
    ...readWorkspace(workspaceId),
    qualifiedLocalPreparation: {} as never,
  }));
  expect(
    reconcilableLocalCodexCommand(f.events, native, id, custody.authSessionId, f.workspace),
  ).toBeUndefined();
  prepared.mockRestore();

  expect(
    reconcilableLocalCodexCommand(f.events, native, id, 'foreign-operator', f.workspace),
  ).toBeUndefined();
  // Reuse the same retained checkout and still-fenced command for adverse
  // receipt observations. No extra repository, database or native journey.
  for (const [column, value] of nativeStatus !== 'completed'
    ? ([
        [
          uncertainGithubRead
            ? 'tool_name'
            : taskStore
              ? 'result_content'
              : policyDrift
                ? 'tool_name'
                : 'result_effect_outcome',
          uncertainGithubRead
            ? 'UnreviewedMutation'
            : taskStore
              ? 'changed result'
              : policyDrift
                ? 'UnreviewedMutation'
                : 'unknown',
        ],
        ['result_content', null],
        ['request_hash', 'f'.repeat(64)],
      ] as const)
    : []) {
    db.prepare(`UPDATE codex_tools SET ${column}=? WHERE call_id='failed-read'`).run(value);
    if (column === 'tool_name') identity.toolName = String(value);
    await expect(driver.reconcileRetainedEffects()).rejects.toThrow();
    expect(native.read(id, binding).recovery).toBe(1);
    expect(native.commandStatus(id, binding, command.id)).toBe(retainedStatus);
    const originalTool = before.tools[0] as Record<string, unknown>;
    db.prepare(`UPDATE codex_tools SET ${column}=? WHERE call_id='failed-read'`).run(
      originalTool[column],
    );
    identity.toolName = String(originalTool.tool_name);
  }
  if (taskStore) {
    const reserved = vi
      .spyOn(f.events.agentCommunication, 'findRequest')
      .mockReturnValue({} as never);
    await expect(driver.reconcileRetainedEffects()).rejects.toThrow();
    expect(native.read(id, binding).recovery).toBe(1);
    reserved.mockRestore();
    const taskDb = (taskStore as unknown as { db: Database.Database }).db;
    const originalRun = taskDb.prepare('SELECT * FROM task_execution_runs').get() as Record<
      string,
      unknown
    >;
    for (const [column, value] of uncertainGithubRead
      ? []
      : ([
          ['result', null],
          ['fingerprint', 'changed'],
          ['session_id', 'foreign'],
        ] as const)) {
      taskDb.prepare(`UPDATE task_execution_runs SET ${column}=?`).run(value);
      await expect(driver.reconcileRetainedEffects()).rejects.toThrow();
      expect(native.read(id, binding).recovery).toBe(1);
      taskDb.prepare(`UPDATE task_execution_runs SET ${column}=?`).run(originalRun[column]);
    }
  }
  const originalEmail = f.configuration[0].email;
  let changedAccount = false;
  const revokeAccount = () => {
    if (!changedAccount) {
      changedAccount = true;
      f.configuration[0].email = 'other@example.test';
      f.writeProfiles();
    }
  };
  if (nativeStatus !== 'completed') afterItem = revokeAccount;
  else {
    const request = probe.rpc.request.getMockImplementation()!;
    probe.rpc.request.mockImplementation(async (method, params) => {
      const response = await request(method, params);
      if (method === 'thread/turns/list') revokeAccount();
      return response;
    });
  }
  await expect(driver.reconcileRetainedEffects()).rejects.toThrow();
  expect(changedAccount).toBe(true);
  expect(native.read(id, binding).recovery).toBe(1);
  f.configuration[0].email = originalEmail;
  f.writeProfiles();
  // Routine query-loop timing updates can race cold inspection. Keep actual
  // custody/selection observations; vary only these three non-authority fields.
  const getMeta = f.events.getSession.bind(f.events);
  let timing = Date.now();
  const metadata = vi.spyOn(f.events, 'getSession').mockImplementation((sessionId) => {
    const meta = getMeta(sessionId);
    return meta && { ...meta, durationMs: ++timing, updatedAt: timing, lastStateChange: timing };
  });
  await driver.reconcileRetainedEffects();
  metadata.mockRestore();
  expect(native.read(id, binding).recovery).toBe(0);
  expect(native.continuationBlocker(id, binding)).toBeUndefined();
  if (!completionPhase)
    expect(native.completionPhase(id, binding, command.id, command.attempt)).toBeUndefined();
  expect(native.readHostCustody(id, binding)).toEqual(custody);
  expect(readFileSync(draft, 'utf8')).toBe('Preserve the interrupted task');
  expect(native.readNativeExecution(id, binding, command)?.policy.bindingRevision).toBe(
    policy.bindingRevision,
  );
  expect(
    native.commands(id, binding).map(({ status, attempt, id }) => ({ status, attempt, id })),
  ).toEqual(
    before.command.map(({ status, attempt, id }) => ({
      status: nativeStatus === 'completed' && id === command.id ? 'completed' : status,
      attempt,
      id,
    })),
  );
  expect(f.events.getSendCommand(command.id)).toEqual(before.send);
  expect(f.events.getOrdinaryLocalCommandExecutionAdmission(command.id)).toEqual(before.admission);
  expect(db.prepare('SELECT * FROM codex_tools').all()).toEqual(before.tools);
  if (uncertainGithubRead)
    expect(taskStore!.runStatus(grant!.id, id, String(arguments_.requestId)).state).toBe(
      'uncertain',
    );
  expect(probe.dispatch).not.toHaveBeenCalled();
  expect(claims).not.toHaveBeenCalled();
  expect(
    probe.rpc.request.mock.calls.some(([method]) =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(method),
    ),
  ).toBe(false);
  expect(probe.rpc.close).toHaveBeenCalled();
  expect(probe.rpc.request.mock.calls.some(([method]) => method === 'thread/items/list')).toBe(
    nativeStatus !== 'completed',
  );
}
// These composed journeys reopen real Git/SQLite custody and exercise multiple
// refusals. CI measured 4.6–5.0s under shard contention; retain a bounded budget
// above the unit-test default without skipping any recovery assertions.
const coldRecoveryTimeoutMs = 15_000;
it.each(['interrupted', 'completed'] as const)(
  'reconciles an already dispatched cold turn observed %s without replay',
  (status) => reconcileRetainedColdTurn(status),
  coldRecoveryTimeoutMs,
);

it(
  'reconciles settled interrupted work after a real policy change under fresh authority without replay',
  () => reconcileRetainedColdTurn('interrupted', true),
  coldRecoveryTimeoutMs,
);

it.each([false, true])(
  'reconciles a failed capacity turn with settled receipts without replay (policy drift: %s)',
  (policyDrift) => reconcileRetainedColdTurn('failed', policyDrift, false),
  coldRecoveryTimeoutMs,
);

it('recovers an interrupted TaskExecution GitHub read with an uncertain receipt without replay', () =>
  reconcileRetainedColdTurn('interrupted', false, false, true));

it.each(
  (['warm', 'cold'] as const).flatMap((retirement) =>
    (['settled-capacity', 'unknown-write', 'context-limit'] as const).map((failure) => ({
      retirement,
      failure,
    })),
  ),
)(
  'continues $retirement failed-turn recovery with $failure evidence',
  async ({ retirement, failure }) => {
    const unknownWrite = failure === 'unknown-write';
    const contextLimit = failure === 'context-limit';
    const f = await ownedRuntimeFixture(cleanups);
    const first = f.create();
    await first.admit(f.request);
    const original = f.dispatch.mock.calls[0][0];
    const id = original.sessionId,
      binding = original.lease.binding;
    const store = new CodexConversationStore(join(f.root, 'capacity-consumer.db'));
    cleanups.push(() => store.close());
    store.create(id, binding, original.workspace.directory!);
    original.admission.persistCustody(store);
    const policy = composeOwnedLocalNativeExecutionPolicyForWorkspace(
      { binding, assertCurrentSync: () => original.admission.assertCurrentSync() },
      () => ({
        cwd: original.workspace.directory!,
        mode: 'agent',
        workspaceRoots: [original.workspace.directory!],
        authSessionId: f.auth.id,
      }),
    );
    let callbacks!: CodexLifecycleTransport;
    let turns = 0;
    let authorized = true;
    let afterItem = () => {};
    const base = f.rpc.request.getMockImplementation()!;
    const error = contextLimit
      ? { message: 'Context window exceeded', codexErrorInfo: 'contextWindowExceeded' }
      : { message: 'The model is at capacity', codexErrorInfo: 'serverOverloaded' };
    let observedError = error;
    const toolName = unknownWrite ? 'Write' : 'Read';
    const settledItem = {
      id: 'finished-read',
      type: 'dynamicToolCall',
      tool: toolName,
      arguments: {},
      status: unknownWrite ? 'failed' : 'completed',
      success: !unknownWrite,
    };
    let item: Record<string, unknown> = settledItem;
    f.rpc.request.mockImplementation(async (method, params) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'capacity-thread' }, model: binding.model, modelProvider: 'openai' };
      if (method === 'turn/start') return { turn: { id: `capacity-turn-${++turns}` } };
      if (method === 'thread/turns/list')
        return {
          data: [{ id: 'capacity-turn-1', status: 'failed', error: observedError }],
          nextCursor: null,
        };
      if (method === 'thread/items/list') {
        afterItem();
        return { data: [{ turnId: 'capacity-turn-1', item }], nextCursor: null };
      }
      return base(method, params);
    });
    const execute = vi.fn(async () =>
      unknownWrite
        ? retainCallbackOutcome(
            { content: 'Write failed after possible mutation', isError: true },
            'unknown',
          )
        : { content: 'Original read result', isError: false },
    );
    const options = {
      conversationId: id,
      cwd: original.workspace.directory!,
      systemPrompt: original.payload.systemPrompt,
      profile: original.profile,
      storedBinding: binding,
      store,
      ownerKind: 'ordinary' as const,
      transportClosure: 'terminal' as const,
      enableCapacityRecovery: false,
      nativeExecution: policy,
      assertNativeExecutionCurrent: () => original.admission.assertCurrentSync(),
      requestNativeApproval: async () => ({ decision: 'decline' as const }),
      assertRecoveryCurrent: () => {
        if (!authorized) throw Error('Original recovery authorization revoked');
        original.admission.assertCurrentSync();
      },
      verifyBinding: async () => binding,
      canClaimCommand: () => true,
      tools: [{ name: toolName, description: 'Offline tool', input_schema: { type: 'object' } }],
      createClient: (owner: CodexLifecycleTransport) => {
        callbacks = owner;
        return f.rpc;
      },
      emit: () => {},
      onError: () => {},
      executeTool: execute,
    };
    let runtime = new CodexConversation(options);
    cleanups.push(() => runtime.close());
    await runtime.initialize();
    await runtime.send({ id: original.commandId, prompt: 'Original work' });
    if (!contextLimit)
      await callbacks.onRequest(
        'item/tool/call',
        {
          threadId: 'capacity-thread',
          turnId: 'capacity-turn-1',
          callId: 'finished-read',
          tool: toolName,
          arguments: {},
        },
        new AbortController().signal,
      );
    await runtime.send({ id: 'saved-capacity-follow-up', prompt: 'Continue with the saved work' });
    callbacks.onNotification('turn/completed', {
      threadId: 'capacity-thread',
      turn: { id: 'capacity-turn-1', status: 'failed', error },
    });
    if (retirement === 'cold') {
      runtime.close();
      runtime = new CodexConversation(options);
      await runtime.initialize();
    }
    if (contextLimit) {
      expect(store.continuationBlocker(id, binding)).toBeUndefined();
      await runtime.resumeAfterExplicitSend();
      expect(store.commandStatus(id, binding, original.commandId)).toBe('failed');
      expect(store.commandStatus(id, binding, 'saved-capacity-follow-up')).toBe('running');
      expect(store.read(id, binding).recovery).toBe(0);
      expect(turns).toBe(2);
      expect(execute).not.toHaveBeenCalled();
      expect(f.rpc.request.mock.calls.some(([method]) => method === 'thread/items/list')).toBe(
        false,
      );
      return;
    }
    if (unknownWrite) {
      await expect(runtime.resumeAfterExplicitSend()).rejects.toThrow('matching settled receipts');
      expect(store.commandStatus(id, binding, original.commandId)).toBe('failed');
      expect(store.commandStatus(id, binding, 'saved-capacity-follow-up')).toBe('queued');
      expect(store.read(id, binding).recovery).toBe(1);
      expect(turns).toBe(1);
      expect(execute).toHaveBeenCalledOnce();
      return;
    }
    for (const invalidItem of [
      { ...settledItem, status: 'inProgress' },
      { ...settledItem, arguments: { changed: true } },
      { ...settledItem, id: 'unmatched-tool' },
      { type: 'commandExecution', id: 'unfinished-command', status: 'failed', exitCode: null },
      { type: 'fileChange', id: 'unfinished-patch', status: 'failed', changes: [] },
      { type: 'futureEffect', id: 'unknown-effect' },
    ]) {
      item = invalidItem;
      await expect(runtime.resumeAfterExplicitSend()).rejects.toThrow();
      expect(store.read(id, binding).recovery).toBe(1);
      expect(store.commandStatus(id, binding, 'saved-capacity-follow-up')).toBe('queued');
      expect(turns).toBe(1);
    }
    item = settledItem;
    afterItem = () => {
      observedError = { ...error, message: 'Different terminal error' };
    };
    await expect(runtime.resumeAfterExplicitSend()).rejects.toThrow('terminal identity changed');
    observedError = error;
    afterItem = () => {
      authorized = false;
    };
    await expect(runtime.resumeAfterExplicitSend()).rejects.toThrow('authorization revoked');
    expect(store.read(id, binding).recovery).toBe(1);
    expect(turns).toBe(1);
    authorized = true;
    afterItem = () => {};
    const originalOwner = options.assertRecoveryCurrent;
    options.assertRecoveryCurrent = async () => {
      throw Error('Asynchronous owner rejection');
    };
    await expect(runtime.resumeAfterExplicitSend()).rejects.toThrow('must be synchronous');
    expect(store.read(id, binding).recovery).toBe(1);
    expect(turns).toBe(1);
    options.assertRecoveryCurrent = originalOwner;
    await runtime.resumeAfterExplicitSend();
    expect(
      store.commands(id, binding).map(({ id, status, attempt }) => ({ id, status, attempt })),
    ).toEqual([
      { id: original.commandId, status: 'failed', attempt: 1 },
      { id: 'saved-capacity-follow-up', status: 'running', attempt: 1 },
    ]);
    expect(store.read(id, binding).recovery).toBe(0);
    expect(store.continuationBlocker(id, binding)).toBeUndefined();
    expect(store.completionPhase(id, binding, original.commandId, 1)).toBeUndefined();
    expect(turns).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
  },
);

it(
  'recovers an interrupted turn without a completion phase, retaining its original outcome and receipts',
  () => reconcileRetainedColdTurn('interrupted', true, false),
  coldRecoveryTimeoutMs,
);
