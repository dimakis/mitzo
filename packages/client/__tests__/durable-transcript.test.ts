import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '../src/api-client.js';

const body = () => ({
  sourceConversationId: 'one',
  boundary: { sequence: 3, messageId: 'answer' },
  messages: [
    {
      conversationId: 'one',
      messageId: 'answer',
      sequence: 2,
      author: { sessionId: 'one' },
      source: null,
      blocks: [
        {
          blockId: 'text',
          content: 'Answer',
          sha256: createHash('sha256').update('Answer').digest('hex'),
        },
      ],
    },
  ],
});
afterEach(() => vi.useRealTimers());
it('uses the exact same-origin durable route with credentials and abort propagation', async () => {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body())),
  );
  const controller = new AbortController();
  const api = new MitzoApiClient(fetch);
  await expect(api.getDurableSessionTranscript('one', controller.signal)).resolves.toEqual(body());
  expect(fetch).toHaveBeenCalledWith(
    '/api/sessions/one/messages?transcript=durable',
    expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
  );
});
it('encodes source IDs without changing path, query or origin', async () => {
  const value = body();
  value.sourceConversationId = 'one/?#';
  value.messages[0].conversationId = 'one/?#';
  value.messages[0].author.sessionId = 'one/?#';
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(value)),
  );
  await new MitzoApiClient(fetch).getDurableSessionTranscript('one/?#');
  expect(fetch.mock.calls[0][0]).toBe('/api/sessions/one%2F%3F%23/messages?transcript=durable');
});
it.each(['', 'a b', 'x'.repeat(201)])('refuses invalid request ID %s before fetch', async (id) => {
  const fetch = vi.fn();
  await expect(new MitzoApiClient(fetch).getDurableSessionTranscript(id)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  'array',
  'empty',
  'source',
  'messageSource',
  'author',
  'boundaryId',
  'boundarySeq',
  'order',
  'duplicate',
  'private',
  'block',
  'tooMany',
])('strictly refuses %s response without legacy normalization', async (kind) => {
  const value = body();
  let raw: unknown = value;
  if (kind === 'array') raw = [];
  if (kind === 'empty') value.messages = [];
  if (kind === 'source') value.sourceConversationId = 'other';
  if (kind === 'messageSource') value.messages[0].conversationId = 'other';
  if (kind === 'author') value.messages[0].author.sessionId = 'other';
  if (kind === 'boundaryId') value.boundary.messageId = 'other';
  if (kind === 'boundarySeq') value.boundary.sequence = 1;
  if (kind === 'order')
    value.messages.unshift({ ...value.messages[0], messageId: 'later', sequence: 3 });
  if (kind === 'duplicate') value.messages.unshift({ ...value.messages[0], sequence: 1 });
  if (kind === 'private') raw = { ...value, operatorId: 'PRIVATE' };
  if (kind === 'block')
    raw = {
      ...value,
      messages: [
        { ...value.messages[0], blocks: [{ ...value.messages[0].blocks[0], rawInput: 'PRIVATE' }] },
      ],
    };
  if (kind === 'tooMany')
    value.messages = Array.from({ length: 501 }, (_, n) => ({
      ...value.messages[0],
      messageId: `m${n}`,
      sequence: n + 1,
    }));
  await expect(
    new MitzoApiClient(async () => new Response(JSON.stringify(raw))).getDurableSessionTranscript(
      'one',
    ),
  ).rejects.toThrow();
});
it('bounds raw body bytes before JSON parsing, including excessive whitespace', async () => {
  const text = ' '.repeat(520 * 1024) + JSON.stringify(body());
  await expect(
    new MitzoApiClient(async () => new Response(text)).getDurableSessionTranscript('one'),
  ).rejects.toThrow();
});
it('cancels an oversized response stream without reading its continuation', async () => {
  const cancelled = vi.fn();
  let read = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        read++;
        controller.enqueue(new Uint8Array(520 * 1024));
      },
      cancel: cancelled,
    },
    { highWaterMark: 0 },
  );
  await expect(
    new MitzoApiClient(async () => new Response(stream)).getDurableSessionTranscript('one'),
  ).rejects.toThrow();
  expect(cancelled).toHaveBeenCalled();
  expect(read).toBe(1);
});
it('preserves the existing authenticated API error path', async () => {
  await expect(
    new MitzoApiClient(
      async () => new Response('{"error":"Not authenticated"}', { status: 401 }),
    ).getDurableSessionTranscript('one'),
  ).rejects.toThrow('API 401: {"error":"Not authenticated"}');
});
it('refuses pre-aborted reads without sending', async () => {
  const fetch = vi.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    new MitzoApiClient(fetch).getDurableSessionTranscript('one', controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['cancel', 'deadline'])('bounds %s when transport ignores AbortSignal', async (kind) => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
  const controller = new AbortController();
  const pending = new MitzoApiClient(fetch).getDurableSessionTranscript('one', controller.signal);
  const assertion =
    kind === 'cancel'
      ? expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      : expect(pending).rejects.toThrow('Transcript request timed out');
  if (kind === 'cancel') controller.abort();
  else await vi.advanceTimersByTimeAsync(30000);
  await assertion;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not start body hydration if an abort-ignoring fetch resolves after cancellation', async () => {
  let resolveFetch!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = new MitzoApiClient(fetch).getDurableSessionTranscript('one', controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  const pull = vi.fn((stream: ReadableStreamDefaultController<Uint8Array>) => stream.close());
  resolveFetch(new Response(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(pull).not.toHaveBeenCalled();
});
it('cancels a stalled body read and releases the bounded transcript timer', async () => {
  const cancelled = vi.fn();
  const reading = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({ pull: reading, cancel: cancelled }, { highWaterMark: 0 }),
  );
  const controller = new AbortController();
  const pending = new MitzoApiClient(async () => response).getDurableSessionTranscript(
    'one',
    controller.signal,
  );
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(reading).toHaveBeenCalled());
  controller.abort();
  await assertion;
  expect(cancelled).toHaveBeenCalled();
});
