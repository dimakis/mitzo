import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';

const roots: string[] = [];
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-fixture',
  profileRevision: 'p1',
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-native-call-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'native.db'));
  store.create('chat', binding, '/offline');
  store.bindThread('chat', binding, 'thread');
  store.enqueue('chat', binding, { id: 'command', prompt: 'Explicit command' });
  const command = store.claimNext('chat', binding)!;
  const identity = {
    turnId: 'turn',
    toolName: 'RequestGithubMainPublication',
    requestHash: 'a'.repeat(64),
  };
  return { store, command, identity };
}

it('reads the exact pending native call through its generic ACK without creating capacity authority', () => {
  const f = fixture();
  try {
    f.store.recordNativeTurnAck('chat', binding, f.command, 'thread', 'turn');
    f.store.claimTool('chat', binding, f.command.id, 'call', f.identity);
    expect(f.store.hasAcceptedProviderTurn('chat', binding)).toBe(false);
    const before = f.store.commands('chat', binding);
    const proof = f.store.pendingNativeHostTool('chat', binding, 'call', f.identity);
    expect(proof).toEqual({
      commandId: f.command.id,
      attempt: f.command.attempt,
      threadId: 'thread',
      generation: 0,
      turnId: 'turn',
      callId: 'call',
      toolName: f.identity.toolName,
      requestHash: f.identity.requestHash,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(f.store.pendingNativeHostTool('chat', binding, 'call', f.identity)).toEqual(proof);
    expect(f.store.commands('chat', binding)).toEqual(before);
    expect(f.store.hasAcceptedProviderTurn('chat', binding)).toBe(false);
  } finally {
    f.store.close();
  }
});

it.each([
  'no-ack',
  'wrong-turn',
  'wrong-tool',
  'wrong-input',
  'wrong-call',
  'legacy',
  'completed',
  'finished',
] as const)('refuses %s instead of inferring a current native call from labels', (failure) => {
  const f = fixture();
  try {
    if (failure !== 'no-ack')
      f.store.recordNativeTurnAck('chat', binding, f.command, 'thread', 'turn');
    f.store.claimTool(
      'chat',
      binding,
      f.command.id,
      'call',
      failure === 'legacy' ? undefined : f.identity,
    );
    const identity = { ...f.identity };
    if (failure === 'wrong-turn') identity.turnId = 'foreign-turn';
    if (failure === 'wrong-tool') identity.toolName = 'OtherTool';
    if (failure === 'wrong-input') identity.requestHash = 'b'.repeat(64);
    if (failure === 'completed')
      f.store.recordToolResult('chat', binding, f.command.id, 'call', f.identity, {
        content: 'Known result',
        isError: false,
      });
    if (failure === 'finished') f.store.finish('chat', binding, f.command.id, 'completed', 'turn');
    expect(
      f.store.pendingNativeHostTool(
        'chat',
        binding,
        failure === 'wrong-call' ? 'foreign-call' : 'call',
        identity,
      ),
    ).toBeUndefined();
  } finally {
    f.store.close();
  }
});

it('refuses a foreign account binding while preserving the original pending claim', () => {
  const f = fixture();
  try {
    f.store.recordNativeTurnAck('chat', binding, f.command, 'thread', 'turn');
    f.store.claimTool('chat', binding, f.command.id, 'call', f.identity);
    expect(() =>
      f.store.pendingNativeHostTool(
        'chat',
        { ...binding, accountId: 'foreign' },
        'call',
        f.identity,
      ),
    ).toThrow();
    expect(f.store.pendingNativeHostTool('chat', binding, 'call', f.identity)).toBeDefined();
  } finally {
    f.store.close();
  }
});
