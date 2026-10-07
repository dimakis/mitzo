import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
