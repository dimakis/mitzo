import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore } from '../event-store.js';
import { codexRolloverHistory } from '../codex-rollover-context.js';

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
