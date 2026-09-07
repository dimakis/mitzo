import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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
