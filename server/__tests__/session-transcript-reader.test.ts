import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { StoredEvent } from '../event-store.js';
import { createSessionTranscriptReader } from '../session-transcript-reader.js';

vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

function fixture(events: StoredEvent[] = []) {
  const store = {
    getSession: vi.fn(() => ({
      sessionId: 'private-session',
      createdAt: Date.now() - 60_000,
      cwd: '/private/workspace',
      accountBinding: { provider: 'openai-codex' },
    })),
    getSessionEvents: vi.fn(() => events),
    getSessionEventsThroughCursor: vi.fn(() => events),
    getOrdinaryLocalVertexCustody: vi.fn(() => null),
    getSendCommand: vi.fn(() => null),
    upsertSession: vi.fn(),
  };
  const dependencies = {
    store,
    getSessionDirs: vi.fn(async () => ['/private/workspace']),
    getSessionInfo: vi.fn(async () => ({ cwd: '/private/workspace' })),
    getLegacyMessages: vi.fn(async () => []),
    getAccountMessages: vi.fn(async () => [
      { type: 'user', message: { role: 'user', content: 'Personal history' } },
    ]),
    onLegacyParseError: vi.fn(),
  };
  const reader = createSessionTranscriptReader(
    dependencies as unknown as Parameters<typeof createSessionTranscriptReader>[0],
  );
  return { reader, ...dependencies };
}

function history(): StoredEvent[] {
  return [
    ['message_start', { messageId: 'm' }],
    ['block_start', { messageId: 'm', blockId: 'b', blockType: 'text' }],
    ['block_delta', { messageId: 'm', blockId: 'b', delta: 'private-message-content' }],
    ['block_end', { messageId: 'm', blockId: 'b' }],
    ['message_end', { messageId: 'm' }],
  ].map(([type, payload], index) => ({
    type,
    payload,
    seq: index + 1,
    sessionId: 'private-session',
    createdAt: index,
  })) as StoredEvent[];
}

it('reads an empty native event prefix once before the existing legacy fallback', async () => {
  const f = fixture();
  expect(await f.reader.getSessionTranscript('private-session')).toEqual({
    messages: [],
    current: null,
    currents: [],
    cursor: 0,
  });
  expect(f.store.getSessionEvents).toHaveBeenCalledTimes(1);
  expect(f.getLegacyMessages).toHaveBeenCalledTimes(1);
});

it.each(['getMessages', 'getSessionTranscript'] as const)(
  '%s reads personal history only from its retained account and propagates reader failures',
  async (method) => {
    const f = fixture();
    f.store.getSession.mockReturnValue({
      sessionId: 'private-session',
      createdAt: 1,
      cwd: '/personal/workspace',
      accountBinding: { provider: 'anthropic-claude' },
    });
    f.store.getOrdinaryLocalVertexCustody.mockReturnValue({
      sdkSessionId: 'personal-sdk',
      credentialAuthority: { kind: 'claude-host-login', config: { path: '/personal/login' } },
    } as never);
    const result = await f.reader[method]('private-session');
    expect(Array.isArray(result) ? result : result.messages).toHaveLength(1);
    expect(f.getAccountMessages).toHaveBeenCalledExactlyOnceWith(
      'personal-sdk',
      '/personal/workspace',
      '/personal/login',
    );
    expect(f.getSessionDirs).not.toHaveBeenCalled();
    expect(f.getLegacyMessages).not.toHaveBeenCalled();
    const failure = Error('personal reader failed');
    f.getAccountMessages.mockRejectedValueOnce(failure);
    await expect(f.reader[method]('private-session')).rejects.toBe(failure);
    f.store.getOrdinaryLocalVertexCustody.mockReturnValue(null);
    await expect(f.reader[method]('private-session')).rejects.toThrow(
      'Claude account history unavailable',
    );
    expect(f.getSessionDirs).not.toHaveBeenCalled();
  },
);

it('keeps reconnect reads synchronous and bounded, without metadata recovery or legacy discovery', () => {
  const f = fixture(history());
  const result = f.reader.getReconnectTranscript('private-session', 5);
  expect(result.messages[0].blocks[0].content).toBe('private-message-content');
  expect(f.store.getSessionEventsThroughCursor).toHaveBeenCalledExactlyOnceWith(
    'private-session',
    5,
  );
  expect(f.store.getSessionEvents).not.toHaveBeenCalled();
  expect(f.getSessionDirs).not.toHaveBeenCalled();
  expect(f.getLegacyMessages).not.toHaveBeenCalled();
});

it('separates row decoding/read from projection and records counts without transcript content', async () => {
  const f = fixture(history());
  const result = await f.reader.getSessionTranscript('private-session');
  expect(result.cursor).toBe(5);
  expect(result.messages[0].blocks[0].content).toBe('private-message-content');
  const spans = exporter.getFinishedSpans();
  expect(spans.map((span) => span.name)).toEqual(
    expect.arrayContaining([
      'transcript.events_read',
      'transcript.workspace_recovery',
      'transcript.projection',
    ]),
  );
  expect(
    spans.find((span) => span.name === 'transcript.events_read')?.attributes[
      'transcript.events_count'
    ],
  ).toBe(5);
  expect(
    JSON.stringify(spans.map((span) => [span.attributes, span.events, span.status])),
  ).not.toMatch(/private-message-content|private-session|\/private/);
});

it('preserves the original read error without placing its message in telemetry', async () => {
  const f = fixture();
  const failure = Error('secret-database-detail');
  f.store.getSessionEvents.mockImplementation(() => {
    throw failure;
  });
  await expect(f.reader.getMessages('private-session')).rejects.toBe(failure);
  expect(f.getLegacyMessages).not.toHaveBeenCalled();
  const failed = exporter.getFinishedSpans().find((span) => span.name === 'transcript.events_read');
  expect(failed?.status.code).toBe(2);
  expect(JSON.stringify([failed?.status, failed?.events])).not.toContain('secret-database-detail');
});

it('preserves a newer workspace while legacy metadata lookup awaits and retains its original replay cursor', async () => {
  const f = fixture(history());
  f.store.getSession.mockReturnValue({
    sessionId: 'private-session',
    createdAt: 1,
    cwd: '',
    accountBinding: { provider: 'anthropic-vertex' },
  });
  let complete!: (value: { cwd: string }) => void;
  f.getSessionInfo.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const pending = f.reader.getSessionTranscript('private-session');
  await vi.waitFor(() => expect(f.getSessionInfo).toHaveBeenCalledTimes(1));
  f.store.getSession.mockReturnValue({
    sessionId: 'private-session',
    createdAt: 1,
    cwd: '/newer/workspace',
    accountBinding: { provider: 'anthropic-vertex' },
  });
  complete({ cwd: '/older/workspace' });
  const result = await pending;
  expect(f.store.upsertSession).not.toHaveBeenCalled();
  expect(f.store.getSessionEvents).toHaveBeenCalledTimes(1);
  expect(result.cursor).toBe(5);
});

it('never searches mutable legacy history for an empty cursor-bounded request', async () => {
  const f = fixture();
  expect(await f.reader.getMessages('private-session', 5)).toEqual([]);
  expect(f.store.getSessionEventsThroughCursor).toHaveBeenCalledExactlyOnceWith(
    'private-session',
    5,
  );
  expect(f.getSessionDirs).not.toHaveBeenCalled();
  expect(f.getLegacyMessages).not.toHaveBeenCalled();
});
