import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../event-store.js';
import { createHash } from 'node:crypto';
import { codexRolloverHistory, codexRolloverSources } from '../codex-rollover-context.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

it('rebuilds only completed user and assistant text without the pending command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-rollover-context-'));
  const store = new EventStore(join(dir, 'events.db'));
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.upsertSession({ sessionId: 'session', initialPrompt: 'First question' });
  store.append('session', 'user_message', { messageId: 'u1', text: 'First question' });
  store.append('session', 'block_delta', {
    messageId: 'a1',
    blockType: 'text',
    delta: 'First ',
  });
  store.append('session', 'block_delta', {
    messageId: 'a1',
    blockType: 'text',
    delta: 'answer',
  });
  store.append('session', 'message_end', { messageId: 'a1' });
  store.append('session', 'user_message', { messageId: 'pending', text: 'Continue' });

  expect(codexRolloverHistory(store, 'session')).toEqual([
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'First answer' },
  ]);
});

it.each(['hash', 'date', 'bytes'] as const)(
  'refuses an invalid durable %s snapshot before rollover',
  (invalid) => {
    const dir = mkdtempSync(join(tmpdir(), 'mitzo-rollover-invalid-'));
    const store = new EventStore(join(dir, 'events.db'));
    cleanup.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const content = invalid === 'bytes' ? 'é'.repeat(1024 * 1024 + 1) : 'Saved source';
    const source = {
      kind: 'briefing',
      date: invalid === 'date' ? '2026-02-30' : '2026-10-09',
      revision:
        invalid === 'hash' ? 'a'.repeat(64) : createHash('sha256').update(content).digest('hex'),
      content,
    };
    store.append('session', 'user_message', {
      messageId: 'source',
      text: 'Short intent',
      sourceSnapshots: [source],
    });
    expect(() => codexRolloverSources(store, 'session')).toThrow();
  },
);

it('deduplicates repeated sources and keeps unrelated conversations and seat payloads out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mitzo-rollover-scope-'));
  const store = new EventStore(join(dir, 'events.db'));
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = {
    kind: 'briefing',
    date: '2026-10-09',
    revision: createHash('sha256').update('Exact source').digest('hex'),
    content: 'Exact source',
  };
  for (const id of ['a', 'b'])
    store.append('session', 'user_message', {
      messageId: id,
      text: 'Short intent',
      sourceSnapshots: [source],
    });
  store.append('other', 'user_message', {
    messageId: 'other',
    text: 'Other',
    sourceSnapshots: [{ ...source, content: 'Private other source' }],
  });
  store.append('session', 'tool_result', {
    sourceSnapshots: [{ ...source, content: 'Adversarial tool source' }],
  });
  expect(codexRolloverSources(store, 'session')).toEqual([source]);
});
