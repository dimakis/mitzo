import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverableLocalCodexCommand } from '../retained-local-codex-recovery.js';
import type { EventStore } from '../event-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { CodexConversationStore } from '../codex-conversation-store.js';

const roots: string[] = [];
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-model',
  profileRevision: 'offline-revision',
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-predispatch-proof-'));
  roots.push(root);
  const path = join(root, 'native.db');
  const store = new CodexConversationStore(path);
  store.create('chat', binding, '/offline');
  store.bindThread('chat', binding, 'thread');
  store.enqueue('chat', binding, { id: 'command', prompt: 'Retained input', model: binding.model });
  const command = store.claimNext('chat', binding)!;
  return { store, path, command };
}

it('never infers an unmarked failed attempt was undispatched from missing native history', () => {
  const f = fixture();
  f.store.finish('chat', binding, 'command', 'failed');
  expect(() => f.store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
  const record = () => {
    throw Error('An unproved failure must not write public recovery');
  };
  expect(() => f.store.requeueUndispatchedCommand('chat', binding, 'command', record)).toThrow();
  expect(f.store.commandStatus('chat', binding, 'command')).toBe('failed');
  f.store.close();
});

it('retains a positive pre-dispatch failure proof across reopen and consumes it before the next claim', () => {
  const f = fixture();
  f.store.finish('chat', binding, 'command', 'failed');
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  f.store.close();
  const store = new CodexConversationStore(f.path);
  expect(store.assertUndispatchedCommand('chat', binding, 'command')).toMatchObject({
    status: 'failed',
    attempt: 1,
  });
  let records = 0;
  store.requeueUndispatchedCommand('chat', binding, 'command', () => {
    records++;
  });
  expect(records).toBe(1);
  expect(store.claimNext('chat', binding)?.id).toBe('command');
  store.finish('chat', binding, 'command', 'failed');
  // The previous proof cannot bless a later possible dispatch or lost ACK.
  expect(() => store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
  store.close();
});

it.each(['ack', 'history', 'pending-dispatch', 'pending-ownership', 'later-attempt'] as const)(
  'does not record pre-dispatch proof over %s evidence',
  (kind) => {
    const f = fixture();
    if (kind === 'ack') f.store.recordNativeTurnAck('chat', binding, f.command, 'thread', 'turn');
    if (kind === 'pending-dispatch')
      f.store.beginThreadReplacementDispatch('chat', binding, 'thread', 'next-thread', f.command);
    const writer = new Database(f.path);
    if (kind === 'history')
      writer
        .prepare('UPDATE codex_commands SET native_execution_history=? WHERE id=?')
        .run('[{}]', 'command');
    if (kind === 'pending-ownership')
      writer
        .prepare(
          'INSERT INTO codex_thread_acceptances(conversation_id,command_id,attempt,thread_id,turn_id,generation,ownership_pending,accepted_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run('chat', 'command', 1, 'thread', 'turn', 0, 1, 1);
    if (kind === 'later-attempt')
      writer.prepare('UPDATE codex_commands SET attempt=2 WHERE id=?').run('command');
    writer.close();
    f.store.finish('chat', binding, 'command', 'failed');
    expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(false);
    expect(() => f.store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
    f.store.close();
  },
);

it('does not probe an empty placeholder for a positively undispatched first failure', () => {
  const f = fixture();
  f.store.finish('chat', binding, 'command', 'failed');
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  expect(f.store.recoveryProbeThreadId('chat', binding)).toBeUndefined();
  f.store.close();
});

it('still probes the current thread for an unproved failed request', () => {
  const f = fixture();
  f.store.finish('chat', binding, 'command', 'failed');
  expect(f.store.recoveryProbeThreadId('chat', binding)).toBe('thread');
  f.store.close();
});

it('finds the last dispatched generation behind an undispatched failure on an empty replacement', () => {
  const f = fixture();
  f.store.recordNativeTurnAck('chat', binding, f.command, 'thread', 'completed-turn');
  f.store.finish('chat', binding, 'command', 'completed');
  f.store.replaceThread('chat', binding, 'thread', 'empty-replacement', 'tool_surface_change');
  f.store.enqueue('chat', binding, {
    id: 'followup',
    prompt: 'Saved followup',
    model: binding.model,
  });
  const followup = f.store.claimNext('chat', binding)!;
  f.store.finish('chat', binding, followup.id, 'failed');
  expect(f.store.recordPreDispatchFailure('chat', binding, followup)).toBe(true);
  expect(f.store.recoveryProbeThreadId('chat', binding)).toBe('thread');
  f.store.close();
});

it('polls recovery candidates without hydrating historical input and still validates the exact candidate', () => {
  const f = fixture();
  f.store.finish('chat', binding, 'command', 'completed');
  const writer = new Database(f.path);
  writer
    .prepare('UPDATE codex_commands SET input=? WHERE id=?')
    .run('{unreadable historical prompt', 'command');
  f.store.enqueue('chat', binding, {
    id: 'followup',
    prompt: 'Exact saved input',
    model: binding.model,
  });
  const runtime = {
    version: 2,
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'fixture' },
  };
  const receipt = {
    state: 'consumed',
    binding: runtime,
    workspace: { workspaceId: 'workspace', cwd: '/offline' },
    selection: {
      version: 1,
      model: binding.model,
      thinking: null,
      agent: { profileId: 'profile', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
    },
    requestFingerprint: 'retained',
  };
  const events = {
    getSession: () => ({
      accountBinding: binding,
      mode: 'agent',
      cwd: '/offline',
      repositoryWorkspaceId: 'workspace',
    }),
    getOrdinaryLocalCommandExecutionAdmission: () => receipt,
    observePreparedRepositoryCommandRouting: () => undefined,
    getSendCommand: () => ({ sessionId: 'chat', payload: { text: 'Exact saved input' } }),
    hasUncertainOrdinaryCommand: () => false,
    getSessionRuntimeBinding: () => runtime,
  } as unknown as EventStore;
  const custody = vi
    .spyOn(f.store, 'readHostCustody')
    .mockReturnValue({ authSessionId: 'operator' } as ReturnType<typeof f.store.readHostCustody>);
  try {
    expect(f.store.undispatchedRecoveryCandidateIds('chat', binding)).toEqual(['followup']);
    expect(recoverableLocalCodexCommand(events, f.store, 'chat', 'operator')).toBe('followup');
    writer
      .prepare('UPDATE codex_commands SET input=? WHERE id=?')
      .run(
        JSON.stringify({ id: 'followup', prompt: 'Changed saved input', model: binding.model }),
        'followup',
      );
    expect(recoverableLocalCodexCommand(events, f.store, 'chat', 'operator')).toBeUndefined();
    writer.prepare('UPDATE codex_commands SET input=? WHERE id=?').run(
      JSON.stringify({
        id: 'different-command',
        prompt: 'Exact saved input',
        model: binding.model,
      }),
      'followup',
    );
    expect(recoverableLocalCodexCommand(events, f.store, 'chat', 'operator')).toBeUndefined();
  } finally {
    custody.mockRestore();
    writer.close();
    f.store.close();
  }
});

it.each([
  'marker-absent',
  'later-attempt',
  'interrupted',
  'completed',
  'native-ack',
  'prepared-history',
  'accepted-history',
  'malformed-native-turns',
  'malformed-history',
  'oversized-history',
  'pending-tool',
  'completed-tool',
  'acceptance',
  'ownership',
  'terminal-conflict',
  'capacity-ack',
  'capacity-source',
  'pending-dispatch',
  'phase',
  'input-identity',
  'continuation',
] as const)('never qualifies a positive preparation witness contradicted by %s', (kind) => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  if (kind === 'capacity-source')
    f.store.enqueue('chat', binding, { id: 'other', prompt: 'Reserved child' });
  const writer = new Database(f.path);
  const update = (column: string, value: unknown) =>
    writer.prepare(`UPDATE codex_commands SET ${column}=? WHERE id='command'`).run(value);
  if (kind === 'marker-absent') update('pre_dispatch_failure', 0);
  if (kind === 'later-attempt') update('attempt', 2);
  if (kind === 'interrupted' || kind === 'completed') update('status', kind);
  if (kind === 'native-ack')
    update(
      'native_turns',
      JSON.stringify([{ attempt: 1, threadId: 'thread', turnId: 'turn', generation: 0 }]),
    );
  if (kind === 'prepared-history' || kind === 'accepted-history') {
    const other = fixture();
    other.store.prepareNativeExecution(
      'chat',
      binding,
      other.command,
      'thread',
      codexNativeExecutionPolicy({
        bindingRevision: 'offline',
        mode: 'agent',
        cwd: '/offline',
        readableRoots: ['/offline'],
        writableRoots: ['/offline'],
        deniedRoots: ['/credentials'],
      }),
    );
    if (kind === 'accepted-history') {
      other.store.recordNativeTurnAck('chat', binding, other.command, 'thread', 'turn');
      other.store.acceptNativeExecution('chat', binding, other.command, 'thread', 'turn');
    }
    update(
      'native_execution_history',
      JSON.stringify(other.store.readNativeExecutionHistory('chat', binding, 'command')),
    );
    other.store.close();
  }
  if (kind === 'malformed-history') update('native_execution_history', '[{}]');
  if (kind === 'malformed-native-turns') update('native_turns', 'null');
  if (kind === 'oversized-history')
    update('native_execution_history', ' '.repeat(512 * 1024) + '[]');
  if (kind === 'phase') update('completion_phases', 'null');
  if (kind === 'pending-tool' || kind === 'completed-tool')
    writer
      .prepare(
        'INSERT INTO codex_tools(conversation_id,command_id,call_id,result_content) VALUES (?,?,?,?)',
      )
      .run('chat', 'command', 'effect', kind === 'pending-tool' ? null : 'effect completed');
  if (['acceptance', 'ownership', 'terminal-conflict'].includes(kind))
    writer
      .prepare('INSERT INTO codex_thread_acceptances VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        'chat',
        'command',
        1,
        'thread',
        'turn',
        0,
        kind === 'ownership' ? 1 : 0,
        1,
        kind === 'terminal-conflict' ? 1 : 0,
      );
  if (kind === 'capacity-ack')
    writer
      .prepare('INSERT INTO codex_capacity_native_acks VALUES (?,?,?,?,?,?,?)')
      .run('chat', 'command', 1, 'thread', 'turn', 0, 1);
  if (kind === 'capacity-source')
    writer
      .prepare('INSERT INTO codex_capacity_continuations VALUES (?,?,?,?,?,?,?,?,?)')
      .run('chat', 'other', 'command', 'episode', 1, 'thread', null, 0, null);
  if (kind === 'pending-dispatch')
    writer
      .prepare('INSERT INTO codex_pending_thread_dispatches VALUES (?,?,?,?,?,?)')
      .run('chat', 'thread', 'replacement', 'command', 1, 0);
  if (kind === 'input-identity' || kind === 'continuation')
    update(
      'input',
      JSON.stringify({
        id: kind === 'input-identity' ? 'substituted' : 'command',
        prompt: 'Retained input',
        ...(kind === 'continuation' ? { allowedTools: ['Read'] } : {}),
      }),
    );
  writer.close();
  if (!['marker-absent', 'interrupted', 'completed'].includes(kind)) {
    const malformed = [
      'phase',
      'malformed-history',
      'malformed-native-turns',
      'oversized-history',
    ].includes(kind);
    if (malformed)
      expect(() => f.store.retryLatestFailed('chat', binding, Date.now(), true)).toThrow();
    else expect(f.store.retryLatestFailed('chat', binding, Date.now(), true)).toBe('not_retryable');
  }
  expect(() => f.store.acknowledgeRecovery('chat', binding)).toThrow();
  if (!['phase', 'malformed-history', 'malformed-native-turns', 'oversized-history'].includes(kind))
    expect(f.store.commandLifecycle('chat', binding, 'command').state).not.toBe(
      'pre_effect_failure',
    );
  expect(() => f.store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
  if (kind === 'native-ack')
    expect(f.store.nativeRecoveryTarget('chat', binding)).toMatchObject({ turnId: 'turn' });
  else expect(() => f.store.nativeRecoveryTarget('chat', binding)).toThrow();
  const recordRecovery = vi.fn();
  expect(() =>
    f.store.requeueUndispatchedCommand('chat', binding, 'command', recordRecovery),
  ).toThrow();
  expect(recordRecovery).not.toHaveBeenCalled();
  f.store.enqueue('chat', binding, { id: 'later', prompt: 'New explicit task' });
  expect(() => f.store.claimNext('chat', binding)).toThrow();
  expect(f.store.read('chat', binding).recovery).toBe(1);
  f.store.close();
});

it('acknowledges a genuine pre-dispatch failure after cold reopen without erasing its ambiguity receipt', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  f.store.close();
  const store = new CodexConversationStore(f.path);
  store.recoverAtStartup();
  expect(store.nativeRecoveryTarget('chat', binding)).toBeUndefined();
  expect(store.recoveryProbeThreadId('chat', binding)).toBeUndefined();
  expect(store.commandLifecycle('chat', binding, 'command')).toMatchObject({
    state: 'pre_effect_failure',
    effectStatus: 'not_established',
    nextAction: 'retry_admission',
  });
  const db = (store as unknown as { db: Database.Database }).db;
  const statements = vi.spyOn(db, 'prepare');
  store.acknowledgeRecovery('chat', binding);
  expect(statements.mock.calls.filter(([sql]) => sql.includes('WITH scope AS'))).toHaveLength(1);
  statements.mockRestore();
  expect(store.queueSummary('chat', binding).operation).toMatchObject({
    state: 'pre_effect_failure',
    effectStatus: 'not_established',
    nextAction: 'retry_admission',
  });
  store.enqueue('chat', binding, { id: 'new-explicit', prompt: 'New task' });
  expect(store.claimNext('chat', binding)?.id).toBe('new-explicit');
  const writer = new Database(f.path);
  expect(
    writer
      .prepare(
        "SELECT status,ambiguous,pre_dispatch_failure FROM codex_commands WHERE id='command'",
      )
      .get(),
  ).toEqual({ status: 'failed', ambiguous: 1, pre_dispatch_failure: 1 });
  writer.close();
  store.close();
});

it('does not let a qualified newer preparation failure hide an older unknown effect', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  f.store.acknowledgeRecovery('chat', binding);
  f.store.enqueue('chat', binding, { id: 'newer', prompt: 'Newer preparation' });
  const newer = f.store.claimNext('chat', binding)!;
  f.store.pauseForRecovery('chat', binding, newer.id, 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, newer)).toBe(true);
  const writer = new Database(f.path);
  writer.prepare("UPDATE codex_commands SET pre_dispatch_failure=0 WHERE id='command'").run();
  writer.close();
  expect(storeOperation(f.store)).toMatchObject({ commandId: 'command', effectStatus: 'unknown' });
  expect(() => f.store.acknowledgeRecovery('chat', binding)).toThrow();
  f.store.close();
});
function storeOperation(store: CodexConversationStore) {
  return store.queueSummary('chat', binding).operation;
}

it('keeps a historical preparation witness qualified during a different capacity episode', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  f.store.acknowledgeRecovery('chat', binding);
  f.store.enqueue('chat', binding, { id: 'capacity-source', prompt: 'New native turn' });
  const source = f.store.claimNext('chat', binding)!;
  f.store.recordCapacityAck('chat', binding, source, 'thread', 'capacity-turn');
  f.store.pauseForRecovery('chat', binding, source.id, 'failed', 'resume', undefined, true, true);
  const episode = f.store.recordCapacityFailure(
    'chat',
    binding,
    source,
    'thread',
    'capacity-turn',
    1000,
  );
  const child = f.store.queueCapacityRetry('chat', binding, episode.id, source.id, 31000, false);
  expect(f.store.claimNext('chat', binding)?.id).toBe(child.id);
  f.store.close();
});

it('consumes a proved preparation failure before a repaired original command establishes a completed native turn', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  const recordRecovery = vi.fn();
  f.store.requeueUndispatchedCommand('chat', binding, 'command', recordRecovery);
  expect(recordRecovery).toHaveBeenCalledOnce();
  f.store.acknowledgeRecovery('chat', binding);
  const repaired = f.store.claimNext('chat', binding)!;
  expect(repaired).toMatchObject({ id: 'command', status: 'running', attempt: 1 });
  f.store.recordNativeTurnAck('chat', binding, repaired, 'thread', 'repaired-turn');
  f.store.finish('chat', binding, repaired.id, 'completed', 'repaired-turn');
  expect(f.store.commandLifecycle('chat', binding, repaired.id)).toMatchObject({
    state: 'completed',
    effectStatus: 'completed',
  });
  expect(f.store.read('chat', binding).recovery).toBe(0);
  f.store.close();
});

it.each(['tool', 'ack', 'prepared', 'phase', 'ownership', 'input', 'attempt'] as const)(
  'fences a requeued never-submitted receipt contradicted by %s before ACK or claim',
  (kind) => {
    const f = fixture();
    f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
    expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
    f.store.requeueUndispatchedCommand('chat', binding, 'command', () => {});
    const writer = new Database(f.path);
    if (kind === 'tool')
      writer
        .prepare(
          'INSERT INTO codex_tools(conversation_id,command_id,call_id,result_content) VALUES (?,?,?,?)',
        )
        .run('chat', 'command', 'observed-effect', 'completed effect');
    if (kind === 'ack')
      writer
        .prepare('UPDATE codex_commands SET native_turns=?')
        .run(JSON.stringify([{ attempt: 1, threadId: 'thread', turnId: 'turn', generation: 0 }]));
    if (kind === 'prepared') {
      const other = fixture();
      other.store.prepareNativeExecution(
        'chat',
        binding,
        other.command,
        'thread',
        codexNativeExecutionPolicy({
          bindingRevision: 'offline',
          mode: 'agent',
          cwd: '/offline',
          readableRoots: ['/offline'],
          writableRoots: ['/offline'],
          deniedRoots: ['/credentials'],
        }),
      );
      writer
        .prepare('UPDATE codex_commands SET native_execution_history=?')
        .run(JSON.stringify(other.store.readNativeExecutionHistory('chat', binding, 'command')));
      other.store.close();
    }
    if (kind === 'phase')
      writer.prepare('UPDATE codex_commands SET completion_phases=?').run('null');
    if (kind === 'ownership')
      writer
        .prepare('INSERT INTO codex_thread_acceptances VALUES (?,?,?,?,?,?,?,?,?)')
        .run('chat', 'command', 1, 'thread', 'turn', 0, 1, 1, 0);
    if (kind === 'input')
      writer.prepare('UPDATE codex_commands SET input=?').run(
        JSON.stringify({
          id: 'substituted',
          prompt: 'Changed after requeue',
        }),
      );
    if (kind === 'attempt') writer.prepare('UPDATE codex_commands SET attempt=2').run();
    expect(() => f.store.cancelQueued('chat', binding, 'command')).toThrow();
    expect(
      writer
        .prepare("SELECT status,pre_dispatch_failure FROM codex_commands WHERE id='command'")
        .get(),
    ).toEqual({ status: 'queued', pre_dispatch_failure: 1 });
    writer.prepare('UPDATE codex_conversations SET recovery=0').run();
    f.store.close();
    f.store = new CodexConversationStore(f.path);
    f.store.recoverAtStartup();
    expect(f.store.read('chat', binding).recovery).toBe(1);
    expect(() => f.store.acknowledgeRecovery('chat', binding)).toThrow();
    if (kind === 'phase') expect(() => f.store.queueSummary('chat', binding)).toThrow();
    else
      expect(f.store.queueSummary('chat', binding).operation).toMatchObject({
        commandId: 'command',
        state: 'queued',
        effectStatus: 'unknown',
        nextAction: 'inspect_retained_work',
      });
    if (kind === 'tool') {
      expect(f.store.commandLifecycle('chat', binding, 'command')).toMatchObject({
        state: 'queued',
        effectStatus: 'unknown',
        nextAction: 'inspect_retained_work',
      });
      expect(f.store.queueSummary('chat', binding).operation).toMatchObject({
        commandId: 'command',
        state: 'queued',
        effectStatus: 'unknown',
        nextAction: 'inspect_retained_work',
      });
    }
    // A stale recovery projection must not hide queued receipt custody.
    writer.prepare('UPDATE codex_conversations SET recovery=0').run();
    expect(() => f.store.claimNext('chat', binding)).toThrow();
    f.store.enqueue('chat', binding, {
      id: 'later-explicit',
      prompt: 'New user input after refused cancel',
    });
    expect(() => f.store.claimNext('chat', binding)).toThrow();
    expect(
      writer
        .prepare("SELECT status,pre_dispatch_failure FROM codex_commands WHERE id='command'")
        .get(),
    ).toEqual({ status: 'queued', pre_dispatch_failure: 1 });
    writer.close();
    f.store.close();
  },
);

it('rolls back requeue consumption when recordRecovery reveals contradictory effects', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  const db = (f.store as unknown as { db: Database.Database }).db;
  const recordRecovery = vi.fn(() => {
    db.prepare(
      'INSERT INTO codex_tools(conversation_id,command_id,call_id,result_content) VALUES (?,?,?,?)',
    ).run('chat', 'command', 'in-transaction-effect', 'completed effect');
  });
  expect(() =>
    f.store.requeueUndispatchedCommand('chat', binding, 'command', recordRecovery),
  ).toThrow();
  expect(recordRecovery).toHaveBeenCalledOnce();
  expect(
    db
      .prepare(
        "SELECT status,ambiguous,pre_dispatch_failure FROM codex_commands WHERE id='command'",
      )
      .get(),
  ).toEqual({ status: 'failed', ambiguous: 1, pre_dispatch_failure: 1 });
  expect(db.prepare('SELECT 1 FROM codex_tools').get()).toBeUndefined();
  f.store.close();
});

it.each(['sourceCommandId', 'latestCommandId', 'childCommandId', 'malformed'] as const)(
  'refuses a marked preparation failure referenced by current capacity %s evidence',
  (field) => {
    const f = fixture();
    f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
    expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
    const other = fixture();
    other.store.recordCapacityAck('chat', binding, other.command, 'thread', 'capacity-turn');
    other.store.pauseForRecovery(
      'chat',
      binding,
      other.command.id,
      'failed',
      'resume',
      undefined,
      true,
      true,
    );
    const episode = other.store.recordCapacityFailure(
      'chat',
      binding,
      other.command,
      'thread',
      'capacity-turn',
      1000,
    );
    other.store.close();
    const data = {
      ...episode,
      sourceCommandId: 'another',
      latestCommandId: 'another',
      ...(field === 'malformed' ? {} : { [field]: 'command' }),
    };
    const writer = new Database(f.path);
    writer
      .prepare('INSERT INTO codex_capacity_recoveries VALUES (?,?)')
      .run('chat', field === 'malformed' ? '{}' : JSON.stringify(data));
    writer.close();
    expect(() => f.store.acknowledgeRecovery('chat', binding)).toThrow();
    expect(() => f.store.claimNext('chat', binding)).toThrow();
    expect(() => f.store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
    f.store.close();
  },
);

it('allows cancellation of a clean proved queued input and never replays the cancelled identity', () => {
  const f = fixture();
  f.store.pauseForRecovery('chat', binding, 'command', 'failed', 'resume', undefined, true, true);
  expect(f.store.recordPreDispatchFailure('chat', binding, f.command)).toBe(true);
  f.store.requeueUndispatchedCommand('chat', binding, 'command', () => {});
  expect(f.store.cancelQueued('chat', binding, 'command')).toBe('cancelled');
  expect(f.store.read('chat', binding).recovery).toBe(0);
  expect(() => f.store.assertUndispatchedCommand('chat', binding, 'command')).toThrow();
  f.store.enqueue('chat', binding, { id: 'new-after-cancel', prompt: 'New user input' });
  expect(f.store.claimNext('chat', binding)?.id).toBe('new-after-cancel');
  f.store.close();
});
