import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';

const binding = {
  accountId: 'fixture-account',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline',
  profileRevision: 'revision',
};
const policy = codexNativeExecutionPolicy({
  bindingRevision: 'owned-runtime-binding',
  mode: 'agent',
  cwd: '/workspace/task',
  readableRoots: ['/workspace'],
  writableRoots: ['/workspace/task'],
  deniedRoots: ['/credentials'],
  writeProtectedRoots: ['/runtime'],
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-native-receipt-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private.db');
  const store = new CodexConversationStore(path);
  cleanups.push(() => store.close());
  store.create('conversation', binding, '/workspace/task');
  store.bindThread('conversation', binding, 'thread');
  store.enqueue('conversation', binding, { id: 'command', prompt: 'Offline request' });
  const command = store.claimNext('conversation', binding)!;
  return { path, store, command };
}

describe('native execution receipts in the existing command owner', () => {
  it('retains the exact base policy before dispatch and preserves unknown native acceptance', () => {
    const f = fixture();
    const submitted = { ...structuredClone(policy) };
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', submitted);
    const prepared = f.store.readNativeExecution('conversation', binding, f.command)!;
    expect(prepared).toMatchObject({
      version: 1,
      phase: 'prepared',
      attempt: 1,
      threadId: 'thread',
      policy,
    });
    expect(prepared).not.toHaveProperty('turnId');
    expect(f.store.hasAcceptedProviderTurn('conversation', binding)).toBe(false);
    expect(f.store.nativeTurnTarget('conversation', binding, f.command.id, 1)).toBeUndefined();
    submitted.cwd = '/forged';
    prepared.policy.readableRoots = ['/forged'];
    expect(f.store.readNativeExecution('conversation', binding, f.command)?.policy).toEqual(policy);
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    expect(f.store.readNativeExecutionHistory('conversation', binding, f.command.id)).toHaveLength(
      1,
    );
    expect(f.store.commands('conversation', binding)[0]).toEqual(f.command);
    const reopened = new CodexConversationStore(f.path);
    try {
      expect(reopened.readNativeExecution('conversation', binding, f.command)?.phase).toBe(
        'prepared',
      );
    } finally {
      reopened.close();
    }
  });

  it('links only the exact native turn ACK and treats an identical ACK as idempotent', () => {
    const f = fixture();
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'turn'),
    ).toThrow();
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'turn'),
    ).toThrow();
    f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
    f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'turn');
    const accepted = f.store.readNativeExecution('conversation', binding, f.command)!;
    expect(accepted).toMatchObject({ phase: 'accepted', turnId: 'turn', policy });
    f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'turn');
    expect(f.store.readNativeExecution('conversation', binding, f.command)).toEqual(accepted);
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'other-turn'),
    ).toThrow();
  });

  it('never manufactures a pre-RPC policy snapshot after native acknowledgement already exists', () => {
    const f = fixture();
    f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy),
    ).toThrow();
    expect(f.store.readNativeExecution('conversation', binding, f.command)).toBeUndefined();
  });

  it('prepares the exact pending child and accepts its native ACK before ownership completes', () => {
    const f = fixture();
    f.store.beginThreadReplacementDispatch('conversation', binding, 'thread', 'child', f.command);
    f.store.prepareNativeExecution('conversation', binding, f.command, 'child', policy);
    expect(f.store.read('conversation', binding)).toMatchObject({
      threadId: 'thread',
      threadGeneration: 0,
    });
    expect(f.store.readNativeExecution('conversation', binding, f.command)).toMatchObject({
      phase: 'prepared',
      threadId: 'child',
      generation: 1,
      replacement: { parentThreadId: 'thread', parentGeneration: 0 },
    });
    f.store.acceptThreadReplacement(
      'conversation',
      binding,
      'thread',
      'child',
      f.command,
      'tool-revision',
      undefined,
      'tool_surface_change',
      'child-turn',
    );
    f.store.recordNativeTurnAck('conversation', binding, f.command, 'child', 'child-turn');
    expect(
      f.store.nativeTurnTarget('conversation', binding, f.command.id, f.command.attempt),
    ).toBeUndefined();
    f.store.acceptNativeExecution('conversation', binding, f.command, 'child', 'child-turn');
    expect(f.store.readNativeExecution('conversation', binding, f.command)).toMatchObject({
      phase: 'accepted',
      threadId: 'child',
      turnId: 'child-turn',
      generation: 1,
    });
    expect(f.store.pendingThreadOwnership('conversation', binding)).toMatchObject({
      threadId: 'child',
      generation: 1,
      turnId: 'child-turn',
    });
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'child', 'wrong-turn'),
    ).toThrow();
    f.store.completeThreadOwnership('conversation', binding, 'child');
    f.store.acceptNativeExecution('conversation', binding, f.command, 'child', 'child-turn');
    expect(
      f.store.nativeTurnTarget('conversation', binding, f.command.id, f.command.attempt),
    ).toMatchObject({ threadId: 'child', generation: 1 });
  });

  it('keeps the initial pending binding in generation zero when there is no parent thread', () => {
    const f = fixture();
    f.store.create('initial', binding, '/workspace/task');
    f.store.enqueue('initial', binding, { id: 'first', prompt: 'Offline first request' });
    const command = f.store.claimNext('initial', binding)!;
    f.store.beginThreadReplacementDispatch('initial', binding, undefined, 'first-thread', command);
    f.store.prepareNativeExecution('initial', binding, command, 'first-thread', policy);
    expect(f.store.readNativeExecution('initial', binding, command)).toMatchObject({
      generation: 0,
      replacement: { parentThreadId: null, parentGeneration: 0 },
    });
    f.store.acceptThreadReplacement(
      'initial',
      binding,
      undefined,
      'first-thread',
      command,
      'revision',
      undefined,
      'tool_surface_change',
      'first-turn',
    );
    f.store.recordNativeTurnAck('initial', binding, command, 'first-thread', 'first-turn');
    f.store.acceptNativeExecution('initial', binding, command, 'first-thread', 'first-turn');
    expect(f.store.readNativeExecution('initial', binding, command)).toMatchObject({
      phase: 'accepted',
      generation: 0,
      turnId: 'first-turn',
    });
  });

  it('does not treat another pending child, parent thread or command attempt as its dispatch proof', () => {
    const f = fixture();
    f.store.beginThreadReplacementDispatch('conversation', binding, 'thread', 'child', f.command);
    for (const [thread, command] of [
      ['other-child', f.command],
      ['thread', f.command],
      ['child', { ...f.command, attempt: 2 }],
      ['child', { ...f.command, id: 'other-command' }],
    ] as const) {
      expect(() =>
        f.store.prepareNativeExecution('conversation', binding, command, thread, policy),
      ).toThrow();
    }
    expect(f.store.readNativeExecutionHistory('conversation', binding, f.command.id)).toEqual([]);
    expect(() => f.store.assertNoPendingThreadDispatch('conversation', binding)).toThrow();
  });

  it('rejects a stale pending dispatch if the same parent thread ID returns in a later generation', () => {
    const f = fixture();
    f.store.beginThreadReplacementDispatch('conversation', binding, 'thread', 'child', f.command);
    // The ordinary owner prevents reusing provider IDs. A stale retained snapshot
    // must still fail if that ID matches while its generation has advanced.
    const db = new Database(f.path);
    try {
      db.prepare('UPDATE codex_thread_generations SET generation=2 WHERE conversation_id=?').run(
        'conversation',
      );
      db.prepare('UPDATE codex_conversations SET thread_generation=2 WHERE id=?').run(
        'conversation',
      );
    } finally {
      db.close();
    }
    expect(f.store.read('conversation', binding).threadGeneration).toBe(2);
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'child', policy),
    ).toThrow();
    expect(f.store.readNativeExecutionHistory('conversation', binding, f.command.id)).toEqual([]);
  });

  it('retains a legacy unknown pending generation without inferring native dispatch permission', () => {
    const f = fixture();
    f.store.beginThreadReplacementDispatch('conversation', binding, 'thread', 'child', f.command);
    const db = new Database(f.path);
    try {
      db.prepare('UPDATE codex_pending_thread_dispatches SET parent_generation=NULL').run();
    } finally {
      db.close();
    }
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'child', policy),
    ).toThrow();
    expect(() => f.store.assertNoPendingThreadDispatch('conversation', binding)).toThrow();
  });

  it('never substitutes an unrelated raw child ACK for the exact replacement acceptance proof', () => {
    const f = fixture();
    f.store.beginThreadReplacementDispatch('conversation', binding, 'thread', 'child', f.command);
    f.store.prepareNativeExecution('conversation', binding, f.command, 'child', policy);
    f.store.replaceThread('conversation', binding, 'thread', 'child', 'provider_transport_failure');
    f.store.recordNativeTurnAck('conversation', binding, f.command, 'child', 'child-turn');
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'child', 'child-turn'),
    ).toThrow();
    expect(f.store.readNativeExecution('conversation', binding, f.command)?.phase).toBe('prepared');
    expect(() => f.store.assertNoPendingThreadDispatch('conversation', binding)).toThrow();
  });

  it('rejects account, command attempt, thread, policy and terminal status conflicts', () => {
    const f = fixture();
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    expect(() =>
      f.store.prepareNativeExecution(
        'conversation',
        { ...binding, accountId: 'other' },
        f.command,
        'thread',
        policy,
      ),
    ).toThrow();
    expect(() =>
      f.store.prepareNativeExecution(
        'conversation',
        binding,
        { ...f.command, attempt: 2 },
        'thread',
        policy,
      ),
    ).toThrow();
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'other-thread', policy),
    ).toThrow();
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', {
        ...policy,
        cwd: '/forged',
      }),
    ).toThrow();
    const different = codexNativeExecutionPolicy({
      ...policy,
      bindingRevision: policy.bindingRevision,
      mode: 'ask',
      writableRoots: policy.workspaceRoots,
    });
    expect(() =>
      f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', different),
    ).toThrow();
    f.store.finish('conversation', binding, f.command.id, 'interrupted');
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'turn'),
    ).toThrow();
    expect(f.store.readNativeExecution('conversation', binding, f.command)?.phase).toBe('prepared');
  });

  it('retains previous attempts without converting preparation into retry authorization', () => {
    const f = fixture();
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    f.store.pauseForRecovery(
      'conversation',
      binding,
      f.command.id,
      'failed',
      'resume',
      undefined,
      false,
      true,
    );
    expect(f.store.retryLatestFailed('conversation', binding, Date.now(), true)).toBe(
      'not_retryable',
    );
    const db = new Database(f.path);
    try {
      db.prepare('UPDATE codex_commands SET retryable=1, ambiguous=0').run();
    } finally {
      db.close();
    }
    expect(f.store.retryLatestFailed('conversation', binding)).toBe('queued');
    f.store.acknowledgeRecovery('conversation', binding);
    const next = f.store.claimNext('conversation', binding)!;
    expect(next.attempt).toBe(2);
    f.store.prepareNativeExecution('conversation', binding, next, 'thread', policy);
    expect(
      f.store
        .readNativeExecutionHistory('conversation', binding, next.id)
        .map((receipt) => receipt.attempt),
    ).toEqual([1, 2]);
    expect(() =>
      f.store.acceptNativeExecution('conversation', binding, f.command, 'thread', 'late-turn'),
    ).toThrow();
  });

  it('adds only the missing command receipt column when reopening a legacy database', () => {
    const f = fixture();
    cleanups.pop();
    f.store.close();
    const legacy = new Database(f.path);
    try {
      legacy.exec('ALTER TABLE codex_commands DROP COLUMN native_execution_history');
    } finally {
      legacy.close();
    }
    const reopened = new CodexConversationStore(f.path);
    cleanups.push(() => reopened.close());
    expect(reopened.readNativeExecution('conversation', binding, f.command)).toBeUndefined();
    reopened.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    expect(reopened.readNativeExecution('conversation', binding, f.command)?.phase).toBe(
      'prepared',
    );
  });

  it('rejects a retained policy whose protected roots no longer match its frozen revision', () => {
    const f = fixture();
    f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
    const forged = f.store.readNativeExecutionHistory('conversation', binding, f.command.id);
    forged[0].policy.deniedRoots = [];
    const db = new Database(f.path);
    try {
      db.prepare('UPDATE codex_commands SET native_execution_history=?').run(
        JSON.stringify(forged),
      );
    } finally {
      db.close();
    }
    expect(() => f.store.readNativeExecution('conversation', binding, f.command)).toThrow();
  });

  it.each(['{', '[{"version":1}]', ' '.repeat(512 * 1024 + 1)])(
    'fails closed on malformed or oversized retained history',
    (raw) => {
      const f = fixture();
      f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy);
      const db = new Database(f.path);
      try {
        db.prepare('UPDATE codex_commands SET native_execution_history=?').run(raw);
      } finally {
        db.close();
      }
      expect(() => f.store.readNativeExecution('conversation', binding, f.command)).toThrow();
      expect(() =>
        f.store.prepareNativeExecution('conversation', binding, f.command, 'thread', policy),
      ).toThrow();
    },
  );
});

describe('native terminal evidence preserves unknown tool effects', () => {
  it.each(['completed', 'failed', 'interrupted'] as const)(
    'retains the pending tool receipt after native %s',
    (status) => {
      const f = fixture();
      f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
      f.store.claimTool('conversation', binding, f.command.id, 'effect-without-result', {
        turnId: 'turn',
        toolName: 'RequestGithubPublish',
        requestHash: 'c'.repeat(64),
      });
      f.store.pauseForRecovery(
        'conversation',
        binding,
        f.command.id,
        'interrupted',
        'resume',
        undefined,
        false,
        true,
      );
      const target = f.store.nativeRecoveryTarget('conversation', binding)!;
      f.store.reconcileNativeRecovery('conversation', binding, target, status, 'thread', 0);
      expect(f.store.commandLifecycle('conversation', binding, f.command.id)).toMatchObject({
        state: status === 'completed' ? 'completed' : 'ambiguous_effect',
        effectStatus: 'unknown',
      });
      expect(
        f.store.replayToolResult('conversation', binding, f.command.id, 'effect-without-result', {
          turnId: 'turn',
          toolName: 'RequestGithubPublish',
          requestHash: 'c'.repeat(64),
        }),
      ).toBeNull();
      expect(f.store.commands('conversation', binding)).toMatchObject([{ status }]);
    },
  );
});

it('does not clear downstream hook uncertainty using only a completed native turn receipt', () => {
  const f = fixture();
  f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
  f.store.recordTransportDiagnostic('conversation', binding, f.command, {
    stage: 'workspace_transition',
    reason: 'completion_hook_failed',
    release: 'offline',
    nativeVersion: '0.160.0',
    workspaceDigest: 'd'.repeat(64),
  });
  f.store.pauseForRecovery(
    'conversation',
    binding,
    f.command.id,
    'interrupted',
    'resume',
    undefined,
    false,
    true,
  );
  f.store.reconcileNativeRecovery(
    'conversation',
    binding,
    f.store.nativeRecoveryTarget('conversation', binding)!,
    'completed',
    'thread',
    0,
  );
  expect(f.store.commandLifecycle('conversation', binding, f.command.id)).toMatchObject({
    state: 'completed',
    effectStatus: 'unknown',
    nextAction: 'inspect_retained_work',
  });
});

it('refuses completion-phase success evidence whose retained target was substituted by another writer', () => {
  const f = fixture();
  f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
  const phase = f.store.beginCompletionPhase(
    'conversation',
    binding,
    f.command,
    'thread',
    'turn',
    'f'.repeat(64),
  );
  const writer = new Database(f.path);
  const changed = { ...phase, target: { ...phase.target, turnId: 'other-turn' } };
  writer
    .prepare('UPDATE codex_commands SET completion_phases=? WHERE id=?')
    .run(JSON.stringify([changed]), f.command.id);
  writer.close();
  expect(() =>
    f.store.observeCompletionPhase('conversation', binding, phase.target, 'completed'),
  ).toThrow(/phase|target/);
  expect(f.store.completionPhase('conversation', binding, f.command.id, 1)?.status).not.toBe(
    'completed',
  );
});

it.each(['prior_unknown', 'pending_tool'] as const)(
  'does not erase %s uncertainty when the completion hook succeeds',
  (uncertainty) => {
    const f = fixture();
    f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
    if (uncertainty === 'prior_unknown') {
      const writer = new Database(f.path);
      writer.prepare('UPDATE codex_commands SET ambiguous=1 WHERE id=?').run(f.command.id);
      writer.close();
    } else
      f.store.claimTool('conversation', binding, f.command.id, 'pending-effect', {
        turnId: 'turn',
        toolName: 'RequestGithubPublish',
        requestHash: 'a'.repeat(64),
      });
    const phase = f.store.beginCompletionPhase(
      'conversation',
      binding,
      f.command,
      'thread',
      'turn',
      'f'.repeat(64),
    );
    f.store.finish('conversation', binding, f.command.id, 'completed', 'turn', true);
    f.store.observeCompletionPhase('conversation', binding, phase.target, 'completed');
    f.store.reconcileCompletionPhase('conversation', binding, phase.target, phase.workspaceDigest);
    expect(f.store.commandLifecycle('conversation', binding, f.command.id)).toMatchObject({
      state: 'completed',
      effectStatus: 'unknown',
      nextAction: 'inspect_retained_work',
    });
  },
);

it('does not advertise hook-only reconciliation when prior effect uncertainty remains', () => {
  const f = fixture();
  f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
  const writer = new Database(f.path);
  writer.prepare('UPDATE codex_commands SET ambiguous=1 WHERE id=?').run(f.command.id);
  writer.close();
  const phase = f.store.beginCompletionPhase(
    'conversation',
    binding,
    f.command,
    'thread',
    'turn',
    'f'.repeat(64),
  );
  f.store.finish('conversation', binding, f.command.id, 'completed', 'turn', true);
  f.store.observeCompletionPhase('conversation', binding, phase.target, 'completed');
  expect(f.store.commandLifecycle('conversation', binding, f.command.id)).toMatchObject({
    state: 'completed',
    effectStatus: 'unknown',
    nextAction: 'inspect_retained_work',
  });
});

it('refuses strict native acknowledgement when a known hook still has prior unknown effects', () => {
  const f = fixture();
  f.store.recordNativeTurnAck('conversation', binding, f.command, 'thread', 'turn');
  const writer = new Database(f.path);
  writer.prepare('UPDATE codex_commands SET ambiguous=1 WHERE id=?').run(f.command.id);
  writer.close();
  const phase = f.store.beginCompletionPhase(
    'conversation',
    binding,
    f.command,
    'thread',
    'turn',
    'f'.repeat(64),
  );
  f.store.finish('conversation', binding, f.command.id, 'completed', 'turn', true);
  f.store.observeCompletionPhase('conversation', binding, phase.target, 'completed');
  f.store.reconcileCompletionPhase('conversation', binding, phase.target, phase.workspaceDigest);
  f.store.enqueue('conversation', binding, { id: 'after-prior-unknown', prompt: 'later' });
  f.store.pauseForRecovery('conversation', binding);
  expect(() => f.store.acknowledgeRecovery('conversation', binding, phase.target)).toThrow(
    /phase|effect/,
  );
  expect(f.store.read('conversation', binding).recovery).toBeTruthy();
  expect(f.store.commands('conversation', binding)).toMatchObject([
    { status: 'completed' },
    { status: 'queued' },
  ]);
});
