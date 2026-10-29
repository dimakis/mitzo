import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { CodexConversationStore } from '../codex-conversation-store.js';
const binding = {
  accountId: 'account',
  accountLabel: 'Account',
  provider: 'openai-codex',
  model: 'model',
  profileRevision: 'revision',
};
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-capacity-ledger-'));
  const path = join(root, 'db');
  let store = new CodexConversationStore(path);
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.create('chat', binding, '/workspace', 'tools');
  store.bindThread('chat', binding, 'thread', 'tools');
  store.enqueue('chat', binding, {
    id: 'source',
    prompt: 'Never replay this original prompt',
    model: 'model',
    reasoningEffort: 'medium',
  });
  const source = store.claimNext('chat', binding)!;
  store.recordCapacityAck('chat', binding, source, 'thread', 'source-turn');
  store.enqueue('chat', binding, { id: 'later', prompt: 'Preserved FIFO' });
  store.pauseForRecovery('chat', binding, source.id, 'failed', 'resume', undefined, true, true);
  const episode = store.recordCapacityFailure(
    'chat',
    binding,
    source,
    'thread',
    'source-turn',
    1000,
  );
  return {
    path,
    source,
    episode,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new CodexConversationStore(path);
    },
  };
}
it('waits thirty seconds then reserves exactly one linked continuation ahead of preserved FIFO', () => {
  const f = setup();
  const original = f.store.commands('chat', binding)[0];
  expect(f.episode).toMatchObject({
    status: 'waiting',
    nextRetryAt: 31_000,
    attempts: 0,
    maxAttempts: 5,
  });
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 30_999, false),
  ).toThrow('wait');
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, false);
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, true),
  ).toThrow('active');
  expect(f.store.claimNext('chat', binding)?.id).toBe(child.id);
  f.store.beginCapacityDispatch('chat', binding, child.id);
  expect(f.store.capacityContinuation('chat', binding, child.id)).toMatchObject({
    sourceCommandId: 'source',
    ordinal: 1,
    threadId: 'thread',
  });
  expect(f.store.commands('chat', binding)[0]).toEqual(original);
  expect(f.store.commands('chat', binding).find((c) => c.id === 'later')?.status).toBe('queued');
});
it('shares five attempts with manual requests, then requires an explicit new episode', () => {
  const f = setup();
  let episode = f.episode;
  for (let i = 1; i <= 5; i++) {
    const child = f.store.queueCapacityRetry('chat', binding, episode.id, 'source', 1000 + i, true);
    const command = f.store.claimNext('chat', binding)!;
    f.store.beginCapacityDispatch('chat', binding, child.id);
    f.store.acceptCapacityTurn('chat', binding, child.id, 'thread', `child-${i}`);
    f.store.recordCapacityAck('chat', binding, command, 'thread', `child-${i}`);
    f.store.pauseForRecovery('chat', binding, child.id, 'failed', 'resume', undefined, true, true);
    episode = f.store.recordCapacityFailure(
      'chat',
      binding,
      command,
      'thread',
      `child-${i}`,
      1000 + i,
    );
    expect(episode.attempts).toBe(i);
    expect(episode.status).toBe(i === 5 ? 'exhausted' : 'waiting');
  }
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, episode.id, 'source', 999_999, false),
  ).toThrow('exhausted');
  f.store.queueCapacityRetry('chat', binding, episode.id, 'source', 999_999, true);
  expect(f.store.capacityRecovery('chat', binding)).toMatchObject({
    attempts: 0,
    status: 'queued',
  });
  expect(f.store.capacityRecovery('chat', binding)?.id).not.toBe(episode.id);
});
it('reopens pending intent without duplicating it and rejects stale or changed custody', () => {
  const f = setup();
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, false);
  f.reopen();
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 99_999, true),
  ).toThrow('active');
  expect(f.store.commands('chat', binding).filter((c) => c.id === child.id)).toHaveLength(1);
  expect(() => f.store.stopCapacityRecovery('chat', binding, 'stale', 'source')).toThrow('changed');
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, 'source');
  expect(f.store.commands('chat', binding).find((c) => c.id === child.id)?.status).toBe(
    'cancelled',
  );
  expect(f.store.commands('chat', binding).find((c) => c.id === 'later')?.status).toBe('queued');
  f.store.replaceThread('chat', binding, 'thread', 'different', 'tool_surface_change');
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 99_999, true),
  ).toThrow('identity');
});

it('does not disturb ordinary capacity recovery when only Symposium owners are recovered at startup', () => {
  const f = setup();
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000);
  const before = f.store.capacityRecovery('chat', binding);
  f.store.recoverAtStartup('symposium');
  expect(f.store.capacityRecovery('chat', binding)).toEqual(before);
  expect(f.store.commands('chat', binding).find((c) => c.id === child.id)?.status).toBe('queued');
  f.store.recoverAtStartup('ordinary');
  expect(f.store.capacityRecovery('chat', binding)?.status).toBe('stopped');
  expect(f.store.commands('chat', binding).find((c) => c.id === child.id)?.status).toBe(
    'cancelled',
  );
  expect(f.store.read('chat', binding).recovery).toBe(1);
});
it('holds an uncertain dispatched continuation across restart instead of creating another attempt', () => {
  const f = setup();
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000);
  f.store.claimNext('chat', binding);
  f.store.beginCapacityDispatch('chat', binding, child.id);
  f.reopen();
  f.store.recoverAtStartup('ordinary');
  expect(f.store.commands('chat', binding).find((c) => c.id === child.id)?.status).toBe(
    'interrupted',
  );
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 99_000, true),
  ).toThrow('uncertain');
  expect(
    f.store.commands('chat', binding).filter((c) => c.id !== 'source' && c.id !== 'later'),
  ).toHaveLength(1);
});
it('requires an exact source native ACK and hides only resolved capacity failures without rewriting them', () => {
  const f = setup();
  expect(() =>
    f.store.recordCapacityFailure('chat', binding, f.source, 'thread', 'wrong-native-turn'),
  ).toThrow('acknowledgment');
  const original = f.store.commands('chat', binding)[0];
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000);
  const command = f.store.claimNext('chat', binding)!;
  f.store.beginCapacityDispatch('chat', binding, child.id);
  f.store.acceptCapacityTurn('chat', binding, child.id, 'thread', 'child-completed');
  f.store.recordCapacityAck('chat', binding, command, 'thread', 'child-completed');
  f.store.finish('chat', binding, child.id, 'completed', 'child-completed');
  f.store.completeCapacityTurn('chat', binding, child.id, 'child-completed', 'completed');
  expect(f.store.queueSummary('chat', binding).failed).toBe(0);
  expect(f.store.commands('chat', binding)[0]).toEqual(original);
  expect(f.store.claimNext('chat', binding)?.id).toBe('later');
});

it('stops a waiting schedule on owner-scoped restart without resetting counts or dispatching', () => {
  const f = setup();
  const original = f.store.commands('chat', binding);
  f.reopen();
  f.store.recoverAtStartup('ordinary');
  const stopped = f.store.capacityRecovery('chat', binding)!;
  expect(stopped).toMatchObject({
    id: f.episode.id,
    sourceCommandId: 'source',
    status: 'stopped',
    attempts: 0,
  });
  expect(stopped.nextRetryAt).toBeUndefined();
  expect(f.store.commands('chat', binding)).toEqual(original);
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, stopped.id, 'source', 99_999, false),
  ).toThrow('wait');
});
it('hides synthetic children and refuses ordinary cancellation without changing the episode', () => {
  const f = setup();
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, false);
  const before = f.store.capacityRecovery('chat', binding);
  expect(f.store.queueOverview('chat', binding).queued.map((row) => row.id)).toEqual(['later']);
  expect(f.store.queueSummary('chat', binding).queued).toBe(1);
  expect(f.store.cancelQueued('chat', binding, child.id)).toBe('not_queued');
  expect(f.store.capacityRecovery('chat', binding)).toEqual(before);
  expect(f.store.commands('chat', binding).find((row) => row.id === child.id)?.status).toBe(
    'queued',
  );
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, 'source');
  expect(f.store.cancelQueued('chat', binding, child.id)).toBe('not_queued');
  expect(f.store.queueOverview('chat', binding).cancelledIds).not.toContain(child.id);
});
it('exposes the same uncertain-child inspection fence enforced by manual retry', () => {
  const f = setup();
  expect(f.store.queueSummary('chat', binding).capacityRecovery?.requiresInspection).toBe(false);
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, false);
  f.store.claimNext('chat', binding);
  f.store.beginCapacityDispatch('chat', binding, child.id);
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, 'source');
  f.reopen();
  expect(f.store.queueSummary('chat', binding).capacityRecovery).toMatchObject({
    status: 'stopped',
    requiresInspection: true,
  });
  expect(() =>
    f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 99_000, true),
  ).toThrow('uncertain');
});
it('never cancels a dispatched continuation through admission-expiry cleanup', () => {
  const f = setup();
  const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000, false);
  f.store.claimNext('chat', binding);
  f.store.beginCapacityDispatch('chat', binding, child.id);
  const before = f.store.commands('chat', binding);
  const episode = f.store.capacityRecovery('chat', binding);
  expect(() => f.store.cancelUndispatchedCapacityContinuation('chat', binding, child.id)).toThrow(
    'not safely',
  );
  expect(f.store.commands('chat', binding)).toEqual(before);
  expect(f.store.capacityRecovery('chat', binding)).toEqual(episode);
});

it.each(['intent', 'stop', 'custody', 'unsettled', 'restart'] as const)(
  'releases only settled explicit supersession with unchanged authority (%s)',
  (scenario) => {
    const f = setup();
    const child = f.store.queueCapacityRetry('chat', binding, f.episode.id, 'source', 31_000);
    const command = f.store.claimNext('chat', binding)!;
    f.store.beginCapacityDispatch('chat', binding, child.id);
    f.store.acceptCapacityTurn('chat', binding, child.id, 'thread', 'completed-child');
    f.store.recordCapacityAck('chat', binding, command, 'thread', 'completed-child');
    const db = new Database(f.path);
    try {
      const sourceBefore = db
        .prepare("SELECT * FROM codex_commands WHERE conversation_id='chat' AND id='source'")
        .get();
      const ackBefore = db
        .prepare(
          "SELECT * FROM codex_capacity_native_acks WHERE conversation_id='chat' ORDER BY command_id",
        )
        .all();
      f.store.enqueue(
        'chat',
        binding,
        { id: 'new-intent', prompt: 'New authorized instruction' },
        true,
      );
      expect(f.store.capacityRecovery('chat', binding)?.supersedingCommandId).toBe('new-intent');
      if (scenario === 'stop')
        f.store.stopCapacityRecovery('chat', binding, f.episode.id, 'source');
      if (scenario === 'custody') f.store.bindThread('chat', binding, 'thread', 'changed-tools');
      if (scenario === 'unsettled')
        db.prepare(
          "UPDATE codex_commands SET status='failed',ambiguous=1 WHERE conversation_id='chat' AND id='later'",
        ).run();
      if (scenario === 'restart') f.store.recoverAtStartup('ordinary');
      f.store.finish('chat', binding, child.id, 'completed', 'completed-child');
      const resumed = f.store.completeCapacityTurn(
        'chat',
        binding,
        child.id,
        'completed-child',
        'completed',
      );
      expect(resumed).toBe(scenario === 'intent');
      expect(f.store.read('chat', binding).recovery).toBe(scenario === 'intent' ? 0 : 1);
      expect(
        db
          .prepare("SELECT * FROM codex_commands WHERE conversation_id='chat' AND id='source'")
          .get(),
      ).toEqual(sourceBefore);
      expect(
        db
          .prepare(
            "SELECT * FROM codex_capacity_native_acks WHERE conversation_id='chat' ORDER BY command_id",
          )
          .all(),
      ).toEqual(ackBefore);
      if (scenario === 'intent') expect(f.store.claimNext('chat', binding)?.id).toBe('later');
      else expect(() => f.store.claimNext('chat', binding)).toThrow(/acknowledgement|phase|effect/);
    } finally {
      db.close();
    }
  },
);

it.each([
  'ack-turn',
  'ack-generation',
  'attempt',
  'conflict',
  'acceptance-conflict',
  'ownership',
  'no-episode',
  'unrelated',
  'null-tool',
  'pending-phase',
  'completed-unknown',
  'native-contradiction',
] as const)('retains effect custody when capacity terminal proof has %s', (hazard) => {
  const f = setup();
  const writer = new Database(f.path);
  if (hazard === 'ack-turn')
    writer.prepare("UPDATE codex_capacity_native_acks SET turn_id='other'").run();
  if (hazard === 'ack-generation')
    writer.prepare('UPDATE codex_capacity_native_acks SET generation=99').run();
  if (hazard === 'attempt')
    writer.prepare("UPDATE codex_commands SET attempt=2 WHERE id='source'").run();
  if (hazard === 'conflict')
    writer.prepare("UPDATE codex_capacity_continuations SET terminal='conflict'").run();
  if (hazard === 'acceptance-conflict' || hazard === 'ownership')
    writer
      .prepare(
        `
      INSERT INTO codex_thread_acceptances(conversation_id,command_id,attempt,thread_id,turn_id,generation,
        ownership_pending,accepted_at,terminal_conflict) VALUES('chat','source',1,'thread','source-turn',0,?,1,?)
    `,
      )
      .run(hazard === 'ownership' ? 1 : 0, hazard === 'acceptance-conflict' ? 1 : 0);
  if (hazard === 'no-episode') writer.prepare('DELETE FROM codex_capacity_recoveries').run();
  if (hazard === 'unrelated')
    writer
      .prepare(
        `INSERT INTO codex_commands(conversation_id,id,input,status,ambiguous)
      VALUES('chat','unrelated',?,'interrupted',1)`,
      )
      .run(JSON.stringify({ id: 'unrelated', prompt: 'other' }));
  if (hazard === 'null-tool')
    writer
      .prepare(
        `INSERT INTO codex_tools(conversation_id,command_id,call_id)
      VALUES('chat','source','lost-result')`,
      )
      .run();
  if (hazard === 'pending-phase' || hazard === 'native-contradiction') {
    const target = {
      commandId: 'source',
      attempt: 1,
      threadId: 'thread',
      turnId: 'source-turn',
      generation: 0,
    };
    writer.prepare("UPDATE codex_commands SET native_turns=? WHERE id='source'").run(
      JSON.stringify([
        {
          attempt: 1,
          threadId: 'thread',
          turnId: hazard === 'native-contradiction' ? 'other' : 'source-turn',
          generation: 0,
        },
      ]),
    );
    if (hazard === 'pending-phase')
      writer.prepare("UPDATE codex_commands SET completion_phases=? WHERE id='source'").run(
        JSON.stringify([
          {
            version: 1,
            target,
            status: 'pending',
            observedOutcome: 'unknown',
            priorEffectsUnknown: false,
            workspaceDigest: 'a'.repeat(64),
            startedAt: 1,
          },
        ]),
      );
  }
  if (hazard === 'completed-unknown')
    writer.prepare("UPDATE codex_commands SET status='completed' WHERE id='source'").run();
  writer.close();
  expect(() => f.store.acknowledgeRecovery('chat', binding)).toThrow();
  const bypass = new Database(f.path);
  bypass.prepare('UPDATE codex_conversations SET recovery=0').run();
  bypass.close();
  expect(() => f.store.claimNext('chat', binding)).toThrow();
});

it('retains exact acknowledged capacity evidence after the stopped episode is consumed', () => {
  const f = setup();
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, f.source.id);
  f.store.acknowledgeRecovery('chat', binding);
  expect(f.store.capacityRecovery('chat', binding)).toBeUndefined();
  expect(f.store.claimNext('chat', binding)?.id).toBe('later');
  expect(f.store.commandStatus('chat', binding, f.source.id)).toBe('failed');
  const reader = new Database(f.path);
  expect(reader.prepare("SELECT ambiguous FROM codex_commands WHERE id='source'").get()).toEqual({
    ambiguous: 1,
  });
  reader.close();
});

it('omits resolved capacity ambiguity from quiet operation metadata after acknowledged FIFO admission', () => {
  const f = setup();
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, f.source.id);
  f.store.acknowledgeRecovery('chat', binding);
  expect(f.store.claimNext('chat', binding)?.id).toBe('later');
  const db = (f.store as unknown as { db: Database.Database }).db;
  const queries = vi.spyOn(db, 'prepare');
  try {
    expect(f.store.queueSummary('chat', binding).operation).toBeUndefined();
    // One candidate selector and one shared full proof, never a query per source.
    expect(queries.mock.calls.filter(([sql]) => sql.includes('codex_tools'))).toHaveLength(2);
  } finally {
    queries.mockRestore();
  }
});

it('projects an older actual unknown source instead of a newer qualified capacity receipt', () => {
  const f = setup();
  f.store.stopCapacityRecovery('chat', binding, f.episode.id, f.source.id);
  f.store.acknowledgeRecovery('chat', binding);
  const writer = new Database(f.path);
  writer.prepare("UPDATE codex_commands SET sequence=5 WHERE id='source'").run();
  writer
    .prepare(
      `INSERT INTO codex_commands(sequence,conversation_id,id,input,status,ambiguous,recovery_acknowledged)
    VALUES(1,'chat','older-unknown',?,'interrupted',1,1)`,
    )
    .run(JSON.stringify({ id: 'older-unknown', prompt: 'old' }));
  writer.close();
  expect(f.store.queueSummary('chat', binding).operation?.commandId).toBe('older-unknown');
  expect(() => f.store.claimNext('chat', binding)).toThrow(/phase|effect/);
});
