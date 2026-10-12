import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';
const roots: string[] = [];
const binding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex',
  model: 'luna-fixture',
  profileRevision: 'revision',
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function setup(intent: string | undefined = 'Read my pending mail') {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-continuation-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'commands.db'));
  store.create('chat', binding, '/workspace');
  store.bindThread('chat', binding, 'thread');
  store.enqueue('chat', binding, {
    id: 'source',
    prompt: 'expanded original task',
    intent,
    model: 'luna-fixture',
    reasoningEffort: 'low',
  });
  store.claimNext('chat', binding);
  const identity = { turnId: 'turn', toolName: 'GrantIntegrationAccess', requestHash: 'hash' };
  store.claimTool('chat', binding, 'source', 'call', identity);
  store.recordToolResult('chat', binding, 'source', 'call', identity, {
    content: 'attached',
    isError: false,
  });
  return { store, root };
}
it('queues one durable exact-source continuation after a successful grant, eligible only after completed turn', () => {
  const { store } = setup();
  try {
    const child = store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call');
    expect(child).toBe(true);
    expect(store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call')).toBe(
      false,
    );
    const command = store.commands('chat', binding)[1];
    expect(command).toMatchObject({
      model: 'luna-fixture',
      reasoningEffort: 'low',
      intent: 'Read my pending mail',
      environmentContinuation: { sourceCommandId: 'source', sourceTurnId: 'turn' },
    });
    expect(command.prompt).not.toContain('expanded original task');
    expect(() => store.claimNext('chat', binding)).toThrow('already running');
    store.finish('chat', binding, 'source', 'completed', 'turn');
    expect(store.claimNext('chat', binding)?.id).toBe(command.id);
    expect(
      store.queueEnvironmentContinuation('chat', binding, command.id, 'next-turn', 'other'),
    ).toBe(false);
  } finally {
    store.close();
  }
});
it('an explicit user queue serves the new environment and suppresses or cancels synthetic continuation', () => {
  const { store } = setup();
  try {
    store.enqueue('chat', binding, { id: 'user', prompt: 'New user follow-up' }, true);
    expect(store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call')).toBe(
      false,
    );
  } finally {
    store.close();
  }
  const second = setup();
  try {
    second.store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call');
    second.store.enqueue('chat', binding, { id: 'user', prompt: 'New user follow-up' }, true);
    expect(second.store.commands('chat', binding)[1].status).toBe('cancelled');
  } finally {
    second.store.close();
  }
});
it.each(['failed', 'interrupted'] as const)(
  'never dispatches a continuation after %s or restart recovery',
  (status) => {
    const { store } = setup();
    try {
      store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call');
      store.finish('chat', binding, 'source', status, 'turn');
      expect(store.claimNext('chat', binding)).toBeUndefined();
    } finally {
      store.close();
    }
  },
);
it('requires raw user intent, exact successful tool receipt and unchanged account binding', () => {
  const { store } = setup('');
  try {
    expect(store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call')).toBe(
      false,
    );
  } finally {
    store.close();
  }
  const second = setup();
  try {
    expect(
      second.store.queueEnvironmentContinuation('chat', binding, 'source', 'other-turn', 'call'),
    ).toBe(false);
    expect(
      second.store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'unknown'),
    ).toBe(false);
    expect(() =>
      second.store.queueEnvironmentContinuation(
        'chat',
        { ...binding, accountId: 'other' },
        'source',
        'turn',
        'call',
      ),
    ).toThrow();
  } finally {
    second.store.close();
  }
});

it('restart retains the receipt and queued identity but requires explicit recovery', () => {
  const { store, root } = setup();
  store.queueEnvironmentContinuation('chat', binding, 'source', 'turn', 'call');
  const child = store.commands('chat', binding)[1].id;
  store.close();
  const restored = new CodexConversationStore(join(root, 'commands.db'));
  try {
    restored.recoverAtStartup('ordinary');
    expect(restored.commands('chat', binding)[1].id).toBe(child);
    expect(() => restored.claimNext('chat', binding)).toThrow('explicit acknowledgement');
  } finally {
    restored.close();
  }
});
