import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';

const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'test-model',
  profileRevision: 'test',
};
const policy = codexNativeExecutionPolicy({
  bindingRevision: 'offline',
  mode: 'agent',
  cwd: '/offline',
  readableRoots: ['/offline'],
  writableRoots: ['/offline'],
  deniedRoots: ['/credentials'],
  writeProtectedRoots: ['/runtime'],
});
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-thread-owner-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'native.db');
  const store = new CodexConversationStore(path);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };
  cleanups.push(close);
  store.create('chat', binding, '/offline');
  store.bindThread('chat', binding, 'initial');
  const claim = (id: string) => {
    store.enqueue('chat', binding, { id, prompt: id });
    return store.claimNext('chat', binding)!;
  };
  return { store, path, claim, close };
}
it('permits only live authorized dispatch and exact accepted generations, including a second replacement', () => {
  const { store, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  let parent = 'initial';
  for (const id of ['first', 'second']) {
    const command = claim(id);
    owner.authorizeDispatch(id);
    store.beginThreadReplacementDispatch('chat', binding, parent, id, command);
    expect(() => owner.assertCurrentSync()).not.toThrow();
    expect(() => store.assertNoPendingThreadDispatch('chat', binding)).toThrow(/recovery/);
    store.acceptThreadReplacement(
      'chat',
      binding,
      parent,
      id,
      command,
      'surface',
      undefined,
      'tool_surface_change',
      `${id}-turn`,
    );
    expect(() => owner.assertCurrentSync()).not.toThrow();
    expect(() => store.captureLiveThreadOwner('chat', binding)).toThrow(/recovery/);
    store.completeThreadOwnership('chat', binding, id);
    store.finish('chat', binding, command.id, 'completed');
    expect(() => owner.assertCurrentSync()).not.toThrow();
    parent = id;
  }
});
it('does not inherit pending dispatches, acceptances, or authorization from another owner', () => {
  const { store, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const other = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  expect(() => other.assertCurrentSync()).toThrow();
  expect(() => store.captureLiveThreadOwner('chat', binding)).toThrow(/recovery/);
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next',
    command,
    'surface',
    undefined,
    'tool_surface_change',
    'turn',
  );
  store.completeThreadOwnership('chat', binding, 'next');
  expect(() => other.assertCurrentSync()).toThrow();
  expect(() => owner.assertCurrentSync()).not.toThrow();
});
it.each(['attempt', 'parent_generation', 'parent_thread_id'])(
  'rejects changed pending %s',
  (column) => {
    const { store, path, claim } = fixture();
    const owner = store.captureLiveThreadOwner('chat', binding);
    const command = claim('first');
    owner.authorizeDispatch(command.id);
    store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
    const db = new Database(path);
    cleanups.push(() => db.close());
    db.prepare(`UPDATE codex_pending_thread_dispatches SET ${column}=?`).run(
      column === 'parent_thread_id' ? 'foreign' : 99,
    );
    expect(() => owner.assertCurrentSync()).toThrow();
  },
);
it('rejects direct generation changes and rewrites of an already observed acceptance', () => {
  const { store, path, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next',
    command,
    'surface',
    undefined,
    'tool_surface_change',
    'turn',
  );
  store.completeThreadOwnership('chat', binding, 'next');
  expect(() => owner.assertCurrentSync()).not.toThrow();
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.prepare('UPDATE codex_thread_acceptances SET turn_id=?').run('forged-turn');
  expect(() => owner.assertCurrentSync()).toThrow();
});
it('rejects generation changes without an authorized acceptance and definite rejection leaves no pending authority', () => {
  const { store, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'rejected', command);
  store.rejectThreadReplacementDispatch('chat', binding, 'rejected', command);
  expect(() => owner.assertCurrentSync()).not.toThrow();
  store.replaceThread('chat', binding, 'initial', 'foreign', 'tool_surface_change');
  expect(() => owner.assertCurrentSync()).toThrow();
});
it('pins the dispatched child before any notification and consumes rejected dispatch authority', () => {
  const { store, path, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.prepare('UPDATE codex_pending_thread_dispatches SET thread_id=?').run('foreign');
  expect(() => owner.assertCurrentSync()).toThrow();
  db.prepare('UPDATE codex_pending_thread_dispatches SET thread_id=?').run('next');
  store.rejectThreadReplacementDispatch('chat', binding, 'next', command);
  expect(() => owner.assertCurrentSync()).not.toThrow();
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'retry', command);
  expect(() => owner.assertCurrentSync()).toThrow();
});
it('does not launder an ACK rewritten before its first notification or resurrect completed ownership', () => {
  const { store, path, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next',
    command,
    'surface',
    undefined,
    'tool_surface_change',
    'turn',
  );
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.prepare('UPDATE codex_thread_acceptances SET turn_id=?').run('forged');
  expect(() => owner.assertCurrentSync()).toThrow();
  db.prepare('UPDATE codex_thread_acceptances SET turn_id=?').run('turn');
  store.completeThreadOwnership('chat', binding, 'next');
  db.prepare('UPDATE codex_thread_acceptances SET ownership_pending=1').run();
  expect(() => owner.assertCurrentSync()).toThrow();
});
it('keeps evidence unchanged after an ACK transaction rolls back', () => {
  const { store, path, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON codex_thread_acceptances BEGIN SELECT RAISE(ABORT, 'offline rollback'); END",
  );
  expect(() =>
    store.acceptThreadReplacement(
      'chat',
      binding,
      'initial',
      'next',
      command,
      'surface',
      undefined,
      'tool_surface_change',
      'turn',
    ),
  ).toThrow(/rollback/);
  expect(() => owner.assertCurrentSync()).not.toThrow();
  expect(store.read('chat', binding).threadGeneration).toBe(0);
  db.exec('DROP TRIGGER fail_accept');
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next',
    command,
    'surface',
    undefined,
    'tool_surface_change',
    'turn',
  );
  expect(() => owner.assertCurrentSync()).not.toThrow();
});
it('expires disposed owners before late ACK callbacks and leaves a new cold owner conservative', () => {
  const { store, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('first');
  owner.authorizeDispatch(command.id);
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next', command);
  owner.dispose();
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next',
    command,
    'surface',
    undefined,
    'tool_surface_change',
    'turn',
  );
  expect(() => owner.assertCurrentSync()).toThrow(/closed/);
  expect(() => owner.authorizeDispatch(command.id)).toThrow(/closed/);
  expect(() => store.captureLiveThreadOwner('chat', binding)).toThrow(/recovery/);
});
it('invalidates the evidence owner when its store closes', () => {
  const { store, close } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  close();
  expect(() => owner.assertCurrentSync()).toThrow(/closed/);
  expect(() => owner.authorizeDispatch('late')).toThrow(/closed/);
  owner.dispose();
});
it('captures a live queued primary interruption only after the exact authorized native ACK', () => {
  const { store, claim } = fixture();
  const owner = store.captureLiveThreadOwner('chat', binding);
  const command = claim('primary');
  owner.authorizeDispatch(command.id);
  store.prepareNativeExecution('chat', binding, command, 'initial', policy);
  expect(() => owner.assertAcceptedCommand(command.id)).toThrow();
  store.recordNativeTurnAck('chat', binding, command, 'initial', 'turn');
  store.acceptNativeExecution('chat', binding, command, 'initial', 'turn');
  store.finish('chat', binding, command.id, 'interrupted');
  expect(() => owner.assertAcceptedCommand(command.id)).not.toThrow();
  const witness = store.assertPreparedRepositoryRecovery('chat', binding, command.id)!;
  expect(() => witness.assertCurrentSync()).not.toThrow();
});
it('retains exact interrupted receipt and native target evidence across acknowledged generations and cold capture', () => {
  const { store, path, claim } = fixture();
  const primary = claim('primary');
  store.prepareNativeExecution('chat', binding, primary, 'initial', policy);
  store.recordNativeTurnAck('chat', binding, primary, 'initial', 'original-turn');
  store.acceptNativeExecution('chat', binding, primary, 'initial', 'original-turn');
  store.finish('chat', binding, primary.id, 'interrupted');
  const witness = store.assertPreparedRepositoryRecovery('chat', binding, primary.id)!;
  const next = claim('next');
  store.beginThreadReplacementDispatch('chat', binding, 'initial', 'next-thread', next);
  store.prepareNativeExecution('chat', binding, next, 'next-thread', policy);
  store.acceptThreadReplacement(
    'chat',
    binding,
    'initial',
    'next-thread',
    next,
    'surface',
    undefined,
    'tool_surface_change',
    'next-turn',
  );
  store.recordNativeTurnAck('chat', binding, next, 'next-thread', 'next-turn');
  store.acceptNativeExecution('chat', binding, next, 'next-thread', 'next-turn');
  store.completeThreadOwnership('chat', binding, 'next-thread');
  store.finish('chat', binding, next.id, 'completed');
  expect(() => witness.assertCurrentSync()).not.toThrow();
  const coldWitness = store.assertPreparedRepositoryRecovery('chat', binding, primary.id)!;
  expect(() => coldWitness.assertCurrentSync()).not.toThrow();
  const db = new Database(path);
  cleanups.push(() => db.close());
  db.prepare('UPDATE codex_thread_acceptances SET turn_id=?').run('forged-turn');
  expect(() => coldWitness.assertCurrentSync()).toThrow(/historical/);
  db.prepare('UPDATE codex_thread_acceptances SET turn_id=?').run('next-turn');
  db.prepare('UPDATE codex_thread_generations SET thread_id=? WHERE generation=0').run(
    'forged-parent',
  );
  expect(() => coldWitness.assertCurrentSync()).toThrow(/historical/);
  db.prepare('UPDATE codex_thread_generations SET thread_id=? WHERE generation=0').run('initial');
  db.prepare('UPDATE codex_commands SET native_turns=NULL WHERE id=?').run(primary.id);
  expect(() => witness.assertCurrentSync()).toThrow(/historical/);
  expect(() => store.assertPreparedRepositoryRecovery('chat', binding, primary.id)).toThrow();
});
it('refuses historical interruption lineage without an exact successor ACK', () => {
  const { store, claim } = fixture();
  const primary = claim('primary');
  store.prepareNativeExecution('chat', binding, primary, 'initial', policy);
  store.recordNativeTurnAck('chat', binding, primary, 'initial', 'original-turn');
  store.acceptNativeExecution('chat', binding, primary, 'initial', 'original-turn');
  store.finish('chat', binding, primary.id, 'interrupted');
  store.replaceThread('chat', binding, 'initial', 'unacknowledged', 'tool_surface_change');
  expect(() => store.assertPreparedRepositoryRecovery('chat', binding, primary.id)).toThrow(
    /acceptance/,
  );
});
