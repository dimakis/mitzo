import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { recoverableLocalCodexCommand } from '../retained-local-codex-recovery.js';
import type { EventStore } from '../event-store.js';
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
