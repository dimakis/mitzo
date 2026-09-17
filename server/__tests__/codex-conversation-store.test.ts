import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
const roots: string[] = [];
const binding = {
  accountId: 'personal',
  accountLabel: 'ChatGPT',
  provider: 'openai-codex',
  model: 'test-model',
  profileRevision: 'ref',
};
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-codex-store-'));
  roots.push(root);
  return { path: join(root, 'private.db'), root };
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});
it('persists a canonical conversation and immutable account/model binding before work', () => {
  const { path } = setup();
  let s = new CodexConversationStore(path);
  s.create('conversation', binding, '/workspace');
  s.bindThread('conversation', binding, 'provider-thread');
  s.close();
  s = new CodexConversationStore(path);
  expect(s.read('conversation', binding)).toMatchObject({
    conversationId: 'conversation',
    threadId: 'provider-thread',
    cwd: '/workspace',
  });
  expect(() => s.read('conversation', { ...binding, model: 'other' })).toThrow('binding');
  expect(() => s.create('conversation', binding, '/other')).toThrow('workspace');
  expect(() => s.bindThread('conversation', binding, 'other')).toThrow('thread');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  s.close();
});
it('deduplicates queued prompts and preserves pending work through restart without replaying running work', () => {
  const { path } = setup();
  let s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  expect(s.enqueue('c', binding, { id: 'one', prompt: 'hello', allowedTools: ['Read'] })).toBe(
    true,
  );
  expect(s.enqueue('c', binding, { id: 'one', prompt: 'hello', allowedTools: ['Read'] })).toBe(
    false,
  );
  expect(() => s.enqueue('c', binding, { id: 'one', prompt: 'changed' })).toThrow('reused');
  s.enqueue('c', binding, { id: 'two', prompt: 'next' });
  expect(s.claimNext('c', binding)?.id).toBe('one');
  expect(() => s.claimNext('c', binding)).toThrow('running');
  s.close();
  s = new CodexConversationStore(path);
  s.recoverAtStartup();
  expect(s.commands('c', binding).map((c) => [c.id, c.status])).toEqual([
    ['one', 'interrupted'],
    ['two', 'queued'],
  ]);
  expect(() => s.claimNext('c', binding)).toThrow('recovery');
  s.acknowledgeRecovery('c', binding);
  expect(s.claimNext('c', binding)?.id).toBe('two');
  s.finish('c', binding, 'two', 'completed');
  expect(s.claimNext('c', binding)).toBeUndefined();
  s.close();
});
it('deduplicates a legacy command with an equivalent raw intent without weakening input collisions', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  const db = new Database(path);
  db.prepare(
    "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES (?,?,?,'queued')",
  ).run(
    'c',
    'legacy',
    JSON.stringify({
      id: 'legacy',
      prompt: '<context>search Gmail for Cat</context>\nraw request',
      model: 'gpt',
    }),
  );
  db.close();

  expect(
    s.enqueue('c', binding, {
      id: 'legacy',
      prompt: '<context>search Gmail for Cat</context>\nraw request',
      model: 'gpt',
      intent: 'raw request',
    }),
  ).toBe(false);
  expect(() =>
    s.enqueue('c', binding, {
      id: 'legacy',
      prompt: 'different provider prompt',
      model: 'gpt',
      intent: 'different raw intent',
    }),
  ).toThrow('reused');

  expect(
    s.enqueue('c', binding, {
      id: 'modern',
      prompt: 'rendered skill prompt',
      model: 'gpt',
      intent: 'first raw intent',
    }),
  ).toBe(true);
  expect(() =>
    s.enqueue('c', binding, {
      id: 'modern',
      prompt: 'rendered skill prompt',
      model: 'gpt',
      intent: 'second raw intent',
    }),
  ).toThrow('reused');
  expect(() =>
    s.enqueue('c', binding, {
      id: 'modern',
      prompt: 'rendered skill prompt',
      model: 'other-model',
      intent: 'first raw intent',
    }),
  ).toThrow('reused');
  s.close();
});
it('records tool claims before execution and never repeats an uncertain effect', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'one', prompt: 'edit' });
  s.claimNext('c', binding);
  expect(s.claimTool('c', binding, 'one', 'call-1')).toBe(true);
  expect(s.claimTool('c', binding, 'one', 'call-1')).toBe(false);
  s.recoverAtStartup();
  s.acknowledgeRecovery('c', binding);
  expect(s.claimTool('c', binding, 'one', 'call-1')).toBe(false);
  expect(() => s.claimTool('c', binding, 'one', 'call-2')).toThrow('running');
  s.close();
});
it('durably pauses same-process replacement without requiring startup recovery', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'one', prompt: 'active' });
  s.enqueue('c', binding, { id: 'two', prompt: 'queued' });
  s.claimNext('c', binding);
  s.pauseForRecovery('c', binding, 'one');
  expect(s.commands('c', binding).map((command) => command.status)).toEqual([
    'interrupted',
    'queued',
  ]);
  expect(() => s.claimNext('c', binding)).toThrow('recovery');
  s.close();
});

it('tracks provider thread generations and their last known-good turn atomically', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.bindThread('c', binding, 'thread-0');
  s.enqueue('c', binding, { id: 'good', prompt: 'good' });
  s.claimNext('c', binding);
  s.finish('c', binding, 'good', 'completed', 'turn-good');
  expect(s.read('c', binding)).toMatchObject({
    threadId: 'thread-0',
    threadGeneration: 0,
    lastCompletedTurnId: 'turn-good',
  });

  s.enqueue('c', binding, { id: 'failed', prompt: 'uncertain' });
  s.claimNext('c', binding);
  s.pauseForRecovery('c', binding, 'failed', 'failed', 'fork');
  expect(s.read('c', binding).recoveryStrategy).toBe('fork');
  expect(
    s.replaceThread(
      'c',
      binding,
      'thread-0',
      'thread-1',
      'provider_transport_failure',
      'turn-good',
    ),
  ).toBe(1);
  expect(s.read('c', binding)).toMatchObject({
    threadId: 'thread-1',
    threadGeneration: 1,
    lastCompletedTurnId: 'turn-good',
    recoveryStrategy: 'fork',
  });
  expect(() =>
    s.replaceThread('c', binding, 'thread-0', 'thread-2', 'provider_transport_failure'),
  ).toThrow('generation changed');
  s.acknowledgeRecovery('c', binding);
  expect(s.read('c', binding).recoveryStrategy).toBe('resume');
  s.close();
});
it('exposes raw queued, running, and recovery state for lifecycle protection', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'one', prompt: 'active' });
  s.enqueue('c', binding, { id: 'two', prompt: 'queued' });
  s.claimNext('c', binding);
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 1, running: 1, recovery: false });
  s.pauseForRecovery('c', binding, 'one');
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 1, running: 0, recovery: true });
  expect(() => s.lifecycleQueue('missing', binding)).toThrow('binding');
  s.close();
});
it('does not require recovery after cleanly completed work', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'one', prompt: 'done' });
  s.claimNext('c', binding);
  s.finish('c', binding, 'one', 'completed');
  s.pauseForRecovery('c', binding);
  expect(s.read('c', binding).recovery).toBe(0);
  s.close();
});

it('cancels only queued commands and retains an idempotency tombstone across restart', () => {
  const { path } = setup();
  let s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'running', prompt: 'first' });
  s.enqueue('c', binding, { id: 'duplicate', prompt: 'second' });
  expect(s.claimNext('c', binding)?.id).toBe('running');
  expect(s.cancelQueued('c', binding, 'running')).toBe('not_queued');
  expect(s.cancelQueued('c', binding, 'missing')).toBe('not_found');
  expect(() => s.cancelQueued('c', { ...binding, accountId: 'other' }, 'duplicate')).toThrow(
    'binding',
  );
  expect(s.cancelQueued('c', binding, 'duplicate')).toBe('cancelled');
  expect(s.cancelQueued('c', binding, 'duplicate')).toBe('cancelled');
  s.finish('c', binding, 'running', 'completed');
  expect(s.cancelQueued('c', binding, 'running')).toBe('not_queued');
  s.close();
  s = new CodexConversationStore(path);
  expect(s.enqueue('c', binding, { id: 'duplicate', prompt: 'second' })).toBe(false);
  expect(s.claimNext('c', binding)).toBeUndefined();
  expect(s.commands('c', binding).find((c) => c.id === 'duplicate')?.status).toBe('cancelled');
  s.close();
});

it('clears startup recovery when cancelling the only queued command', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'only', prompt: 'saved' });
  s.recoverAtStartup();
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 1, running: 0, recovery: true });

  expect(s.cancelQueued('c', binding, 'only')).toBe('cancelled');
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 0, running: 0, recovery: false });
  expect(s.claimNext('c', binding)).toBeUndefined();
  s.close();
});

it('retains recovery when cancelled work is accompanied by interrupted or failed uncertainty', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('interrupted', binding, '/workspace');
  s.enqueue('interrupted', binding, { id: 'running', prompt: 'uncertain' });
  s.enqueue('interrupted', binding, { id: 'queued', prompt: 'saved' });
  s.claimNext('interrupted', binding);
  s.pauseForRecovery('interrupted', binding, 'running');

  expect(s.cancelQueued('interrupted', binding, 'queued')).toBe('cancelled');
  expect(s.read('interrupted', binding).recovery).toBe(1);
  expect(() => s.claimNext('interrupted', binding)).toThrow('recovery');

  s.create('failed', binding, '/workspace');
  s.enqueue('failed', binding, { id: 'running', prompt: 'uncertain' });
  s.enqueue('failed', binding, { id: 'queued', prompt: 'saved' });
  s.claimNext('failed', binding);
  s.pauseForRecovery('failed', binding, 'running', 'failed');
  expect(s.cancelQueued('failed', binding, 'queued')).toBe('cancelled');
  expect(s.read('failed', binding).recovery).toBe(1);

  // A repeated cancellation is an idempotent acknowledgement, not a reason to
  // clear an uncertainty fence that was intentionally retained.
  expect(s.cancelQueued('failed', binding, 'queued')).toBe('cancelled');
  expect(s.read('failed', binding).recovery).toBe(1);
  s.close();
});

it('clears later startup recovery after prior interrupted work was acknowledged', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'prior', prompt: 'uncertain' });
  s.claimNext('c', binding);
  s.pauseForRecovery('c', binding, 'prior');
  s.acknowledgeRecovery('c', binding);

  s.enqueue('c', binding, { id: 'later', prompt: 'saved' });
  s.recoverAtStartup();
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 1, running: 0, recovery: true });
  expect(s.cancelQueued('c', binding, 'later')).toBe('cancelled');
  expect(s.lifecycleQueue('c', binding)).toEqual({ queued: 0, running: 0, recovery: false });
  s.close();
});

it('migrates legacy recovery flags into acknowledged and unacknowledged command state', () => {
  const { path } = setup();
  const db = new Database(path);
  db.exec(`CREATE TABLE codex_conversations (
    id TEXT PRIMARY KEY, binding TEXT NOT NULL, cwd TEXT NOT NULL, thread_id TEXT, recovery INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE codex_commands (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES codex_conversations(id),
      id TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(conversation_id,id));`);
  const key = JSON.stringify([
    binding.accountId,
    binding.provider,
    binding.model,
    binding.profileRevision,
  ]);
  for (const [id, recovery] of [
    ['acknowledged', 0],
    ['uncertain', 1],
  ] as const) {
    db.prepare('INSERT INTO codex_conversations(id,binding,cwd,recovery) VALUES (?,?,?,?)').run(
      id,
      key,
      '/workspace',
      recovery,
    );
    db.prepare(
      "INSERT INTO codex_commands(conversation_id,id,input,status) VALUES (?,?,?,'failed')",
    ).run(id, 'prior', JSON.stringify({ id: 'prior', prompt: 'uncertain' }));
  }
  db.close();

  const s = new CodexConversationStore(path);
  s.enqueue('acknowledged', binding, { id: 'later', prompt: 'saved' });
  s.recoverAtStartup();
  expect(s.cancelQueued('acknowledged', binding, 'later')).toBe('cancelled');
  expect(s.read('acknowledged', binding).recovery).toBe(0);

  s.enqueue('uncertain', binding, { id: 'later', prompt: 'saved' });
  expect(s.read('uncertain', binding).recoveryStrategy).toBe('fork');
  expect(s.cancelQueued('uncertain', binding, 'later')).toBe('cancelled');
  expect(s.read('uncertain', binding).recovery).toBe(1);
  s.close();
});

it('bounds queue overview and excludes historical payloads from polling', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, { id: 'completed', prompt: 'historical private input' });
  s.claimNext('c', binding);
  s.finish('c', binding, 'completed', 'completed');
  for (let i = 0; i < 101; i++) {
    s.enqueue('c', binding, { id: `cancelled-${i}`, prompt: 'not returned' });
    s.cancelQueued('c', binding, `cancelled-${i}`);
    s.enqueue('c', binding, { id: `queued-${i}`, prompt: 'x'.repeat(200) });
  }
  const summary = s.queueOverview('c', binding);
  expect(summary.queued).toHaveLength(100);
  expect(summary.queued[0]).toEqual({ id: 'queued-0', preview: 'x'.repeat(160) });
  expect(summary.cancelledIds).toHaveLength(100);
  expect(summary.cancelledIds[0]).toBe('cancelled-100');
  expect(summary.hasMore).toBe(true);
  expect(JSON.stringify(summary)).not.toContain('historical private input');
  expect(() => s.queueOverview('c', { ...binding, accountId: 'other' })).toThrow('binding');
  s.close();
});

it('reports queue truncation independently from cancelled tombstone truncation', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  for (let i = 0; i < 101; i++) {
    s.enqueue('c', binding, { id: `cancelled-${i}`, prompt: 'tombstone' });
    s.cancelQueued('c', binding, `cancelled-${i}`);
  }
  s.enqueue('c', binding, { id: 'queued', prompt: 'waiting' });

  const overview = s.queueOverview('c', binding);
  expect(overview.queued).toEqual([{ id: 'queued', preview: 'waiting' }]);
  expect(overview.cancelledIds).toHaveLength(100);
  expect(overview.hasMore).toBe(false);
  s.close();
});

it('summarizes metadata without loading the historical command list', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('c', binding, '/workspace');
  s.enqueue('c', binding, {
    id: 'historical',
    prompt: 'x'.repeat(100_000),
    images: [{ data: 'a'.repeat(1_000), mediaType: 'image/png' }],
  });
  s.claimNext('c', binding);
  s.finish('c', binding, 'historical', 'interrupted');
  s.enqueue('c', binding, { id: 'waiting', prompt: 'queued', reasoningEffort: 'high' });
  const commands = vi.spyOn(s, 'commands');

  expect(s.queueSummary('c', binding)).toEqual({
    queued: 1,
    interrupted: 1,
    model: 'test-model',
    reasoningEffort: 'high',
  });
  expect(commands).not.toHaveBeenCalled();
  s.close();
});

it('preserves an explicit reasoning reset separately from an omitted value in metadata', () => {
  const { path } = setup();
  const s = new CodexConversationStore(path);
  s.create('reset', binding, '/workspace');
  s.enqueue('reset', binding, { id: 'explicit-null', prompt: 'reset', reasoningEffort: null });
  expect(s.queueSummary('reset', binding).reasoningEffort).toBeNull();

  s.create('missing', binding, '/workspace');
  s.enqueue('missing', binding, { id: 'missing-value', prompt: 'default' });
  expect(s.queueSummary('missing', binding).reasoningEffort).toBeUndefined();
  s.close();
});
