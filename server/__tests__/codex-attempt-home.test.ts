import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversation, type CodexConversationOptions } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
const binding = {
  accountId: 'seat',
  accountLabel: 'Seat',
  provider: 'openai-codex' as const,
  model: 'offline',
  profileRevision: '1',
};
const stores: CodexConversationStore[] = [];
const directories: string[] = [];
const conversations: CodexConversation[] = [];
afterEach(() => {
  conversations.splice(0).forEach((c) => c.close());
  stores.splice(0).forEach((s) => s.close());
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-attempt-continuity-'));
  directories.push(root);
  const store = new CodexConversationStore(join(root, 'codex.db'));
  stores.push(store);
  return store;
}
function attempt(
  store: CodexConversationStore,
  id: string,
  history: { role: 'user' | 'assistant'; text: string }[],
  scoped = true,
  beforeThreadStart?: () => void,
) {
  let callbacks!: CodexLifecycleTransport;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const accepted = vi.fn();
  const options: CodexConversationOptions = {
    conversationId: 'seat-runtime',
    cwd: '/workspace',
    profile: {
      accountId: 'seat',
      accountLabel: 'Seat',
      model: 'offline',
      email: 'offline@example.test',
      planType: 'test',
    },
    storedBinding: binding,
    store,
    systemPrompt: 'Seat instructions',
    tools: [],
    verifyBinding: async () => binding,
    ...(scoped ? { providerThreadLifecycle: 'attempt' as const } : {}),
    loadConversationHistory: () => history,
    emit: vi.fn(),
    executeTool: async () => ({ content: '', isError: false }),
    onProviderAccepted: accepted,
    createClient: (cb) => {
      callbacks = cb;
      return {
        initialize: async () => {},
        close: () => {},
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'config/read') return { config: {} };
          if (method === 'thread/start') {
            beforeThreadStart?.();
            return { thread: { id }, model: 'offline', modelProvider: 'openai' };
          }
          if (method === 'thread/resume')
            throw Error('Thread absent from this isolated attempt home');
          if (method === 'turn/start') return { turn: { id: `turn-${id}` } };
          return {};
        },
      };
    },
  };
  const c = new CodexConversation(options);
  conversations.push(c);
  return {
    c,
    requests,
    accepted,
    complete: () =>
      callbacks.onNotification('turn/completed', {
        threadId: id,
        turn: { id: `turn-${id}`, status: 'completed' },
      }),
  };
}
it('preserves first, second and third attempt continuity with explicit transcript-backed lineage', async () => {
  const store = fixture();
  const one = attempt(store, 'one', []);
  await one.c.initialize();
  await one.c.send({ id: 'claim1', prompt: 'Remember marker' });
  one.complete();
  one.c.close();
  const history = [
    { role: 'user' as const, text: 'Remember marker' },
    { role: 'assistant' as const, text: 'Marker retained' },
  ];
  const two = attempt(store, 'two', history);
  await two.c.initialize();
  store.assertAttemptHomeReplacement('seat-runtime', binding, 'one', 'two');
  await two.c.send({ id: 'claim2', prompt: 'Recall marker' });
  expect(
    JSON.stringify(two.requests.find((r) => r.method === 'turn/start')?.params.additionalContext),
  ).toContain('Marker retained');
  expect(two.requests.some((r) => r.method === 'thread/resume')).toBe(false);
  two.complete();
  two.c.close();
  const three = attempt(store, 'three', [
    ...history,
    { role: 'user', text: 'Recall marker' },
    { role: 'assistant', text: 'Marker recalled' },
  ]);
  await three.c.initialize();
  store.assertAttemptHomeReplacement('seat-runtime', binding, 'two', 'three');
  await three.c.send({ id: 'claim3', prompt: 'Continue' });
  expect(
    JSON.stringify(three.requests.find((r) => r.method === 'turn/start')?.params.additionalContext),
  ).toContain('Marker recalled');
  expect(() =>
    store.assertAttemptHomeReplacement('seat-runtime', binding, 'foreign', 'three'),
  ).toThrow();
  expect(() => store.assertAttemptHomeReplacement('seat-runtime', binding, 'one', 'two')).toThrow();
});
it.each([{ history: [] }, { history: [{ role: 'user' as const, text: 'x'.repeat(65537) }] }])(
  'rejects absent or oversized continuity before a replacement thread is started',
  async ({ history }) => {
    const store = fixture();
    const one = attempt(store, 'one', []);
    await one.c.initialize();
    one.c.close();
    const two = attempt(store, 'two', history);
    await expect(two.c.initialize()).rejects.toThrow(/continuity/i);
    expect(two.requests.some((r) => r.method === 'thread/start' || r.method === 'turn/start')).toBe(
      false,
    );
    expect(two.accepted).not.toHaveBeenCalled();
  },
);
it('does not change generic resume semantics when the trusted attempt option is absent', async () => {
  const store = fixture();
  const one = attempt(store, 'one', []);
  await one.c.initialize();
  one.c.close();
  const two = attempt(store, 'two', [{ role: 'user', text: 'Retained' }], false);
  await expect(two.c.initialize()).rejects.toThrow('Thread absent');
  expect(two.requests.some((r) => r.method === 'thread/start')).toBe(false);
});

it('retains migration lineage across initialization that ends before dispatch', async () => {
  const store = fixture();
  const one = attempt(store, 'one', []);
  await one.c.initialize();
  one.c.close();
  const history = [
    { role: 'user' as const, text: 'Previously delivered' },
    { role: 'assistant' as const, text: 'Completed' },
  ];
  const two = attempt(store, 'two', history);
  await two.c.initialize();
  two.c.close();
  const three = attempt(store, 'three', history);
  await three.c.initialize();
  expect(() =>
    store.assertAttemptHomeReplacement('seat-runtime', binding, 'one', 'three'),
  ).not.toThrow();
  expect(three.accepted).not.toHaveBeenCalled();
});

it('does not commit a replacement when the current attempt closes during thread initialization', async () => {
  const store = fixture();
  const one = attempt(store, 'one', []);
  await one.c.initialize();
  one.c.close();
  const two = attempt(
    store,
    'two',
    [
      { role: 'user', text: 'Prior' },
      { role: 'assistant', text: 'Completed' },
    ],
    true,
    () => two.c.close(),
  );
  await expect(two.c.initialize()).rejects.toThrow(/continuity.*closed/i);
  expect(store.read('seat-runtime', binding).threadId).toBe('one');
  expect(two.requests.some((r) => r.method === 'turn/start')).toBe(false);
});

it('accepts exactly 64 KiB of complete continuity and rejects the next UTF-8 byte without truncation', async () => {
  const store = fixture();
  const one = attempt(store, 'one', []);
  await one.c.initialize();
  one.c.close();
  const two = attempt(store, 'two', [
    { role: 'user', text: 'x' },
    { role: 'assistant', text: 'y' },
  ]);
  await two.c.initialize();
  const overhead =
    Buffer.byteLength(store.read('seat-runtime', binding).rolloverContext!, 'utf8') - 2;
  two.c.close();
  const text = 'x'.repeat(65536 - overhead - 1);
  const three = attempt(store, 'three', [
    { role: 'user', text },
    { role: 'assistant', text: 'y' },
  ]);
  await three.c.initialize();
  expect(Buffer.byteLength(store.read('seat-runtime', binding).rolloverContext!, 'utf8')).toBe(
    65536,
  );
  three.c.close();
  const four = attempt(store, 'four', [
    { role: 'user', text: text + 'x' },
    { role: 'assistant', text: 'y' },
  ]);
  await expect(four.c.initialize()).rejects.toThrow('64 KiB');
  expect(four.requests.some((r) => r.method === 'thread/start' || r.method === 'turn/start')).toBe(
    false,
  );
  expect(store.read('seat-runtime', binding).threadId).toBe('three');
});
