import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient } from '../codex-app-server-client.js';
import { summarizeTurnStartFrame } from '../codex-turn-input-receipt.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const params = {
  threadId: 'thread',
  clientUserMessageId: 'claim',
  input: [
    { type: 'text', text: 'history — secret' },
    { type: 'text', text: 'current 🦉' },
  ],
  additionalContext: { history: { kind: 'untrusted', value: 'private history' } },
  config: { token: 'NEVER-RETAIN-CONFIG' },
};
describe('private final RPC input metadata', () => {
  it('summarizes exact serialized ordered text with UTF-8 lengths without retaining text/config', () => {
    const result = summarizeTurnStartFrame(JSON.stringify({ id: 7, method: 'turn/start', params }));
    expect(result).toMatchObject({
      version: 1,
      requestId: 7,
      commandId: 'claim',
      threadId: 'thread',
      inputCount: 2,
      inputs: [
        {
          type: 'text',
          utf8Bytes: Buffer.byteLength(params.input[0].text),
          sha256: digest(params.input[0].text),
        },
        {
          type: 'text',
          utf8Bytes: Buffer.byteLength(params.input[1].text),
          sha256: digest(params.input[1].text),
        },
      ],
      inputSha256: digest(JSON.stringify(params.input)),
      additionalContext: {
        utf8Bytes: Buffer.byteLength(JSON.stringify(params.additionalContext)),
        sha256: digest(JSON.stringify(params.additionalContext)),
      },
    });
    for (const privateText of ['secret', 'current', 'private history', 'NEVER-RETAIN-CONFIG'])
      expect(JSON.stringify(result)).not.toContain(privateText);
    expect(() =>
      summarizeTurnStartFrame(
        JSON.stringify({
          id: 7,
          method: 'turn/start',
          params: { ...params, input: Array(65).fill(params.input[0]) },
        }),
      ),
    ).toThrow();
    expect(() =>
      summarizeTurnStartFrame(
        JSON.stringify({
          id: 7,
          method: 'turn/start',
          params: { ...params, input: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1) }] },
        }),
      ),
    ).toThrow();
  });
  it('persists prepared before write and reports only local writable boundary states', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const frames: Record<string, unknown>[] = [];
    const states: string[] = [];
    child.stdin.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
    const client = new CodexAppServerClient(child, {
      lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: vi.fn() },
      observeTurnStartWrite: (receipt) => {
        if (receipt.boundary === 'prepared')
          expect(frames.some((f) => f.method === 'turn/start')).toBe(false);
        states.push(receipt.boundary);
      },
    });
    const initialized = client.initialize();
    child.stdout.write(JSON.stringify({ id: frames[0].id, result: {} }) + '\n');
    await initialized;
    const request = client.request('turn/start', params);
    child.stdout.write(JSON.stringify({ id: frames.at(-1)!.id, result: {} }) + '\n');
    await request;
    await new Promise((resolve) => setImmediate(resolve));
    expect(states).toEqual(['prepared', 'write_queued', 'write_completed']);
    client.close();
  });
  it('prevents write when required prepared persistence fails and never retries', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const frames: Record<string, unknown>[] = [];
    child.stdin.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
    const observer = vi.fn(() => {
      throw new Error('private diagnostic failure');
    });
    const client = new CodexAppServerClient(child, {
      lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: vi.fn() },
      observeTurnStartWrite: observer,
    });
    const initialized = client.initialize();
    child.stdout.write(JSON.stringify({ id: frames[0].id, result: {} }) + '\n');
    await initialized;
    await expect(client.request('turn/start', params)).rejects.toThrow('connection');
    expect(frames.filter((f) => f.method === 'turn/start')).toHaveLength(0);
    expect(observer).toHaveBeenCalledTimes(1);
  });
});

it('records a finite local write failure without retaining writable error text', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough() as Writable,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const frames: Record<string, unknown>[] = [];
  const receipts: unknown[] = [];
  child.stdin.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: vi.fn() },
    observeTurnStartWrite: (receipt) => receipts.push(receipt),
  });
  const initialized = client.initialize();
  child.stdout.write(JSON.stringify({ id: frames[0].id, result: {} }) + '\n');
  await initialized;
  child.stdin.write = ((_frame: unknown, done: (error: Error) => void) => {
    queueMicrotask(() => done(new Error('PRIVATE-WRITABLE-ERROR')));
    return true;
  }) as never;
  await expect(client.request('turn/start', params)).rejects.toThrow('connection');
  expect(receipts.map((receipt) => (receipt as { boundary: string }).boundary)).toEqual([
    'prepared',
    'write_queued',
    'write_failed',
  ]);
  expect(JSON.stringify(receipts)).not.toContain('PRIVATE-WRITABLE-ERROR');
});
it('normalizes malformed diagnostic errors without reflecting private field values', () => {
  expect(() => summarizeTurnStartFrame('{PRIVATE-MALFORMED')).toThrow(
    'Native turn input diagnostic unavailable',
  );
  try {
    summarizeTurnStartFrame(
      JSON.stringify({
        id: 7,
        method: 'turn/start',
        params: { ...params, threadId: 'PRIVATE-INVALID'.repeat(100) },
      }),
    );
  } catch (error) {
    expect(String(error)).toBe('Error: Native turn input diagnostic unavailable');
  }
});

it('closes uncertain transport when queued persistence fails after the single write', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const frames: Record<string, unknown>[] = [];
  child.stdin.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
  const observer = vi.fn((receipt) => {
    if (receipt.boundary === 'write_queued') throw new Error('PRIVATE-PERSISTENCE-ERROR');
  });
  const closed = vi.fn();
  const client = new CodexAppServerClient(child, {
    lifecycle: { onNotification: vi.fn(), onRequest: vi.fn(async () => ({})), onClose: closed },
    observeTurnStartWrite: observer,
  });
  const initialized = client.initialize();
  child.stdout.write(JSON.stringify({ id: frames[0].id, result: {} }) + '\n');
  await initialized;
  await expect(client.request('turn/start', params)).rejects.toThrow('connection');
  await expect(client.request('turn/start', params)).rejects.toThrow('connection');
  expect(frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
  expect(closed).toHaveBeenCalledOnce();
  expect(child.kill).toHaveBeenCalledOnce();
});
it('durably marks a queued receipt failure ambiguous and requires explicit retry confirmation', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { CodexConversation } = await import('../codex-conversation.js');
  const { CodexConversationStore } = await import('../codex-conversation-store.js');
  const root = mkdtempSync(join(tmpdir(), 'turn-write-ambiguous-'));
  const store = new CodexConversationStore(join(root, 'private.db'));
  const binding = {
    accountId: 'seat',
    accountLabel: 'Seat',
    provider: 'openai-codex' as const,
    model: 'offline',
    profileRevision: '1',
  };
  const frames: Record<string, unknown>[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on('data', (chunk) => {
    const frame = JSON.parse(chunk.toString());
    frames.push(frame);
    if (frame.id && frame.method !== 'turn/start') {
      const result =
        frame.method === 'thread/start'
          ? { thread: { id: 'thread' }, model: 'offline', modelProvider: 'openai' }
          : frame.method === 'config/read'
            ? { config: {} }
            : {};
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: frame.id, result }) + '\n'));
    }
  });
  const createClient = vi.fn(
    (lifecycle) =>
      new CodexAppServerClient(child, {
        lifecycle,
        observeTurnStartWrite: (receipt) => {
          if (receipt.boundary === 'write_queued') throw new Error('PRIVATE-PERSISTENCE-FAILURE');
        },
      }),
  );
  const c = new CodexConversation({
    conversationId: 'app',
    cwd: '/workspace',
    store,
    storedBinding: binding,
    profile: {
      accountId: 'seat',
      accountLabel: 'Seat',
      model: 'offline',
      email: 'offline@example.test',
      planType: 'test',
    },
    verifyBinding: async () => binding,
    systemPrompt: '',
    tools: [],
    emit: vi.fn(),
    executeTool: async () => ({ content: '', isError: false }),
    createClient,
  });
  try {
    await c.initialize();
    await c.send({ id: 'claim', prompt: 'PRIVATE-PROMPT' });
    const { default: Database } = await import('better-sqlite3');
    const reader = new Database(join(root, 'private.db'), { readonly: true });
    try {
      expect(
        reader.prepare('SELECT id, status, retryable, ambiguous FROM codex_commands').all(),
      ).toEqual([{ id: 'claim', status: 'failed', retryable: 1, ambiguous: 1 }]);
    } finally {
      reader.close();
    }
    expect(await c.retryLatestFailed()).toBe('confirmation_required');
    await new Promise((resolve) => setImmediate(resolve));
    expect(frames.filter((frame) => frame.method === 'turn/start')).toHaveLength(1);
    expect(createClient).toHaveBeenCalledOnce();
  } finally {
    c.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
