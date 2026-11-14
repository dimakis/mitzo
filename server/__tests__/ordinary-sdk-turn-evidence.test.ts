import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { storedEventToClientMessage } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { OrdinaryLocalVertexCommandOwner } from '../ordinary-local-vertex-command-owner.js';
import {
  OrdinarySdkTurnEvidence,
  observedOrdinarySdkOutcome,
} from '../ordinary-sdk-turn-evidence.js';
import { OrdinaryCollaborationReplies } from '../collaboration-ordinary-replies.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture(
  provider: 'anthropic-claude' | 'anthropic-vertex' | 'anthropic-api' = 'anthropic-claude',
) {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-sdk-turn-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  let store = new EventStore(path);
  cleanups.push(() => store.close());
  const binding = {
    version: 2 as const,
    account: { accountId: 'selected-claude', provider, profileRevision: 'original-profile' },
    harness: { implementation: 'claude-sdk' as const },
    execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'original-target' },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'ask' as const, revision: 0 },
    model: 'configured-claude-model',
    thinking: 'high',
  };
  store.admitOrdinaryLocalVertexCommand(
    {
      sessionId: 'chat',
      cwd: '/synthetic-task',
      mode: 'ask',
      repositoryWorkspaceId: 'workspace',
      accountBinding: {
        ...binding.account,
        accountLabel: 'Selected Claude',
        model: selection.model,
      },
    },
    binding,
    {
      clientMsgId: 'original-command',
      requestFingerprint: 'exact-command-fingerprint',
      selection,
      payload: { text: 'Original explicit request', systemPrompt: 'Original role' },
    },
  );
  const lifecycle = { beforeDispatch: vi.fn(), accepted: vi.fn(), terminal: vi.fn() };
  const evidence = new OrdinarySdkTurnEvidence(store, 'chat', 'private-sdk-thread');
  const abort = vi.fn();
  const assertCurrentSync = vi.fn();
  const nativeTarget = Object.freeze({});
  const control = {
    captureInterruptTarget: vi.fn(() => nativeTarget),
    interruptIfCurrent: vi.fn(async () => true),
  };
  const queue = new OrdinaryLocalVertexCommandOwner({
    store,
    sessionId: 'chat',
    assertCurrent: () => {},
    assertCurrentSync,
    turnLifecycle: () => lifecycle,
    turnEvidence: evidence,
    query: {
      ...control,
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      push: () => {},
      abort,
    },
    settings: (s) => ({ model: s.model, thinkingTokens: null }),
  });
  return {
    get store() {
      return store;
    },
    queue,
    evidence,
    lifecycle,
    binding,
    selection,
    abort,
    control,
    assertCurrentSync,
    restart() {
      store.close();
      store = new EventStore(path);
    },
  };
}
it('does not let an old accepted input stop a different execution generation in the same session', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  f.queue.inputObserved('private-sdk-input');
  const original = f.store.getExecutionAdmission('chat', 'original-command')!.token;
  const target = f.evidence.interruptTarget('original-command', 'private-sdk-input', original);
  f.store.transitionExecution(original, 'TERMINAL', 'completed');
  const successor = f.store.beginExecution(
    'chat',
    'successor',
    'successor-command',
    'successor-fp',
  ).token;
  expect(
    f.store.claimOrdinarySdkInterrupt('chat', 'forged-generation', {
      ...target,
      execution: successor,
    }),
  ).toBeUndefined();
  expect(f.store.getSession('chat')!.executionPhase).toBe('RUNNING');
  expect(f.store.getOrdinarySdkInterruptReceipt('chat', 'forged-generation')).toBeUndefined();
});
it('captures an immutable execution snapshot and refuses a forged control object', async () => {
  const f = fixture();
  expect(f.queue.captureInterruptTarget()).toBeUndefined();
  await f.queue.enqueue('original-command');
  expect(f.queue.captureInterruptTarget()).toBeUndefined();
  f.queue.inputObserved('private-sdk-input');
  const target = f.queue.captureInterruptTarget()!;
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.execution)).toBe(true);
  expect(await f.queue.interruptIfCurrent('forged', structuredClone(target))).toBe('stale_target');
  expect(f.control.interruptIfCurrent).not.toHaveBeenCalled();
});
it.each(['acknowledged', 'uncertain'])(
  'claims Stop once, retains the %s native outcome and never treats its ACK as terminal evidence',
  async (outcome) => {
    const f = fixture();
    await f.queue.enqueue('original-command');
    f.queue.inputObserved('private-sdk-input');
    const target = f.queue.captureInterruptTarget()!;
    if (outcome === 'uncertain')
      f.control.interruptIfCurrent.mockRejectedValueOnce(
        Error('Synthetic native interrupt failure'),
      );
    const request = f.queue.interruptIfCurrent('exact-stop', target);
    if (outcome === 'uncertain') await expect(request).rejects.toThrow('native interrupt failure');
    else expect(await request).toBe('requested');
    expect(f.store.getSession('chat')!.executionPhase).toBe('STOPPING');
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('uncertain');
    expect(f.lifecycle.terminal).not.toHaveBeenCalled();
    expect(f.queue.captureInterruptTarget()).toBeUndefined();
    expect(await f.queue.interruptIfCurrent('exact-stop', target)).toBe('uncertain');
    expect(await f.queue.interruptIfCurrent('different-stop', target)).toBe('stale_target');
    expect(f.control.interruptIfCurrent).toHaveBeenCalledOnce();
    const receipt = f.store.getOrdinarySdkInterruptReceipt('chat', 'exact-stop');
    f.restart();
    expect(f.store.getOrdinarySdkInterruptReceipt('chat', 'exact-stop')).toEqual(receipt);
    expect(f.store.claimOrdinarySdkInterrupt('chat', 'exact-stop', target)?.fresh).toBe(false);
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('uncertain');
  },
);
it('retains Stop between input yield and echo, then claims the exact interrupt once', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  f.queue.assertInputCurrent('original-command');
  const stop = f.queue.stop('before-echo');
  expect(f.store.getSession('chat')?.executionPhase).toBe('STOPPING');
  expect(f.control.interruptIfCurrent).not.toHaveBeenCalled();
  f.queue.inputObserved('delayed-echo');
  await stop;
  expect(f.control.interruptIfCurrent).toHaveBeenCalledOnce();
  expect(f.store.getOrdinarySdkInterruptReceipt('chat', 'before-echo')?.target.providerTurnId).toBe(
    'delayed-echo',
  );
  await f.queue.resultObserved('delayed-echo');
  expect(f.store.getSession('chat')).toMatchObject({
    executionPhase: 'TERMINAL',
    executionTerminalReason: 'stopped',
  });
});
it('refuses Stop after authorization loss before a durable claim or native interruption', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  f.queue.inputObserved('private-sdk-input');
  const target = f.queue.captureInterruptTarget()!;
  f.assertCurrentSync.mockImplementation(() => {
    throw Error('Original account authority revoked');
  });
  await expect(f.queue.interruptIfCurrent('revoked-stop', target)).rejects.toThrow(
    'authority revoked',
  );
  expect(f.store.getOrdinarySdkInterruptReceipt('chat', 'revoked-stop')).toBeUndefined();
  expect(f.store.getSession('chat')!.executionPhase).toBe('RUNNING');
  expect(f.control.interruptIfCurrent).not.toHaveBeenCalled();
});
it('keeps a delayed Stop capture from targeting a successor command', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  f.queue.inputObserved('private-sdk-input');
  const target = f.queue.captureInterruptTarget()!;
  await f.queue.resultObserved('private-sdk-input');
  const retained = f.store.getSession('chat')!;
  const meta = {
    sessionId: 'chat',
    cwd: retained.cwd!,
    repositoryWorkspaceId: retained.repositoryWorkspaceId!,
    accountBinding: retained.accountBinding!,
    mode: 'ask' as const,
  };
  f.store.admitOrdinaryLocalVertexContinuation(meta, f.binding, {
    clientMsgId: 'successor-command',
    requestFingerprint: 'successor-fp',
    selection: f.selection,
    payload: { text: 'A new explicit request' },
  });
  await f.queue.enqueue('successor-command');
  f.queue.inputObserved('successor-input');
  expect(await f.queue.interruptIfCurrent('late-stop', target)).toBe('stale_target');
  expect(f.store.getSession('chat')!.executionPhase).toBe('RUNNING');
  expect(f.store.getOrdinarySdkInterruptReceipt('chat', 'late-stop')).toBeUndefined();
  expect(f.control.interruptIfCurrent).not.toHaveBeenCalled();
});
function renderReply(store: EventStore, messageId = 'parent-renderer') {
  store.append('chat', 'message_start', { messageId });
  store.append('chat', 'block_start', { messageId, blockId: 'text', blockType: 'text' });
  store.append('chat', 'block_delta', {
    messageId,
    blockId: 'text',
    delta: 'Exact Claude visible reply',
  });
  store.append('chat', 'block_end', { messageId, blockId: 'text', blockType: 'text' });
  return store.append('chat', 'message_end', { messageId });
}
it.each(['anthropic-claude', 'anthropic-vertex', 'anthropic-api'] as const)(
  'retains exact input, renderer and callback-settled result through the actual SDK queue and store restart: %s',
  async (provider) => {
    const f = fixture(provider);
    await f.queue.enqueue('original-command');
    f.queue.assertInputCurrent('original-command');
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBeUndefined();
    expect(() => f.queue.messageStarted('unacknowledged')).toThrow('reply input acknowledgment');
    f.queue.inputObserved('private-sdk-input');
    expect(f.lifecycle.accepted).toHaveBeenCalledExactlyOnceWith(
      'original-command',
      'private-sdk-thread',
      'private-sdk-input',
    );
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('uncertain');
    f.queue.messageStarted('parent-renderer');
    renderReply(f.store);
    const projected = new OrdinaryCollaborationReplies(f.store).streaming(
      'chat',
      'original-command',
      'parent-renderer',
    );
    // Finalized text remains separately available through the original finalized
    // reader; streaming deliberately disappears at that exact completion.
    expect(projected).toBeUndefined();
    expect(f.store.readOrdinaryFinalizedReply('chat', 'parent-renderer')!.blocks[0].content).toBe(
      'Exact Claude visible reply',
    );
    expect(f.store.getOrdinaryReplySourceEvents('chat', 'parent-renderer')).toMatchObject([
      {
        version: 2,
        commandId: 'original-command',
        messageId: 'parent-renderer',
        providerThreadId: 'private-sdk-thread',
        providerTurnId: 'private-sdk-input',
        executionFingerprint: 'exact-command-fingerprint',
      },
    ]);
    await f.queue.resultObserved('private-sdk-input');
    expect(f.lifecycle.terminal).toHaveBeenCalledExactlyOnceWith(
      'original-command',
      'private-sdk-input',
      'completed',
    );
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('completed');
    f.restart();
    expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('completed');
    expect(f.store.getOrdinaryCommandAdmission('original-command')!.selection).toEqual(f.selection);
    const wire = f.store.getSessionEvents('chat').map(storedEventToClientMessage);
    expect(JSON.stringify(wire)).not.toContain('private-sdk-thread');
    expect(JSON.stringify(wire)).not.toContain('private-sdk-input');
    expect(JSON.stringify(wire)).not.toContain('exact-command-fingerprint');
    expect(JSON.stringify(wire)).toContain('Exact Claude visible reply');
  },
);
it('does not turn generic cleanup, final text or an unmatched SDK result into settled proof', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  renderReply(f.store);
  f.store.recordOrdinaryProviderTurnTerminal('chat', 'original-command', 'completed');
  const execution = f.store.getExecutionAdmission('chat', 'original-command')!;
  f.store.transitionExecution(execution.token, 'TERMINAL', 'completed');
  expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBeUndefined();
  await expect(f.queue.resultObserved('unmatched-input')).rejects.toThrow('SDK result identity');
  expect(f.abort).toHaveBeenCalledOnce();
  expect(f.lifecycle.terminal).not.toHaveBeenCalled();
  expect(f.store.getOrdinaryReplySourceEvents('chat', 'parent-renderer')).toEqual([]);
});
it('refuses conflicting acknowledgment/result identities and exact retries never duplicate evidence', async () => {
  const f = fixture();
  await f.queue.enqueue('original-command');
  f.queue.inputObserved('private-sdk-input');
  f.evidence.accepted('original-command', 'private-sdk-input');
  expect(() => f.evidence.accepted('original-command', 'different-input')).toThrow(
    'acknowledgment changed',
  );
  expect(() => f.evidence.settled('original-command', 'different-input', 'completed')).toThrow(
    'result acknowledgment',
  );
  await f.queue.resultObserved('private-sdk-input', true);
  f.evidence.settled('original-command', 'private-sdk-input', 'failed');
  expect(f.store.getOrdinarySdkTurnEvents('chat', 'original-command')).toHaveLength(2);
  expect(observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toBe('failed');
  expect(() => f.evidence.settled('original-command', 'private-sdk-input', 'completed')).toThrow(
    'outcome changed',
  );
  expect(() => f.evidence.message('original-command', 'late-renderer')).toThrow(
    'reply acknowledgment',
  );
});
it('preserves an unexpected storage error instead of reporting an empty or successful outcome', async () => {
  const f = fixture();
  const error = Error('Synthetic SDK evidence storage failure');
  vi.spyOn(f.store, 'getOrdinarySdkTurnEvents').mockImplementation(() => {
    throw error;
  });
  expect(() => observedOrdinarySdkOutcome(f.store, 'chat', 'original-command')).toThrow(error);
});
