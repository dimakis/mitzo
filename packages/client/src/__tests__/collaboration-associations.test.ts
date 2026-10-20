import { expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { EventStore } from '@mitzo/protocol/event-store';
import { CollaborationApiClient, CollaborationApiError } from '../collaboration-api.js';
import type { ApiFetch } from '../api-client.js';

const source = 'ordinary-source';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, sessionId = source) => ({
  version: 1,
  collaborationId: uuid(n),
  revision: 1,
  participantSessionIds: [sessionId, 'peer'],
});
const page = (count = 1) => ({
  collaborations: Array.from({ length: count }, (_, index) => row(index + 1)),
  nextCursor: null as string | null,
});
const response = (body: unknown) => new Response(JSON.stringify(body));

it('does not fetch until the caller explicitly requests a page', () => {
  const fetch = vi.fn();
  new CollaborationApiClient(fetch);
  expect(fetch).not.toHaveBeenCalled();
});

it('uses one exact encoded authenticated GET with the caller cursor and cancellation signal', async () => {
  const sessionId = 'source/π?&=+';
  const body = { collaborations: [row(2, sessionId)], nextCursor: null };
  const fetch = vi.fn().mockResolvedValue(response(body));
  const controller = new AbortController();
  await expect(
    new CollaborationApiClient(fetch).listForSession(sessionId, uuid(1), controller.signal),
  ).resolves.toEqual(body);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `/api/session-collaborations?sessionId=source%2F%CF%80%3F%26%3D%2B&after=${uuid(1)}`,
    { credentials: 'include', signal: controller.signal },
  );
});

it('omits absent cursors and never automatically fetches the next page', async () => {
  const body = { ...page(50), nextCursor: uuid(50) };
  const fetch = vi.fn().mockResolvedValue(response(body));
  await expect(new CollaborationApiClient(fetch).listForSession(source)).resolves.toEqual(body);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    '/api/session-collaborations?sessionId=ordinary-source',
    { credentials: 'include', signal: undefined },
  );
});

it.each([0, 50])('accepts a terminal metadata page with %i rows', async (count) => {
  const body = page(count);
  const fetch = vi.fn().mockResolvedValue(response(body));
  await expect(new CollaborationApiClient(fetch).listForSession(source)).resolves.toEqual(body);
});

it('reads actual EventStore keyset pages without creating sessions, revisions, or context', async () => {
  const store = new EventStore(':memory:');
  try {
    for (const sessionId of [source, 'peer', 'other'])
      store.upsertSession({ sessionId, conversationSource: 'mitzo' });
    for (let n = 1; n <= 52; n++)
      store.setSessionCollaboration(uuid(n), {
        expectedRevision: 0,
        participantSessionIds: [source, 'peer'],
      });
    store.setSessionCollaboration(uuid(53), {
      expectedRevision: 0,
      participantSessionIds: ['other', 'peer'],
    });
    // Only the current revision determines the association list.
    store.setSessionCollaboration(uuid(52), {
      expectedRevision: 1,
      participantSessionIds: ['other', 'peer'],
    });
    const before = store.listSessions();
    const first = store.listSessionCollaborations(source);
    const second = store.listSessionCollaborations(source, first.nextCursor!);
    const fetch = vi.fn<ApiFetch>(async (url) => {
      const query = new URL(url, 'https://offline.invalid').searchParams;
      return response(
        store.listSessionCollaborations(query.get('sessionId')!, query.get('after') ?? undefined),
      );
    });
    const api = new CollaborationApiClient(fetch);
    expect(await api.listForSession(source)).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.collaborations).toHaveLength(50);
    expect(first.nextCursor).toBe(uuid(50));
    expect(await api.listForSession(source, first.nextCursor!)).toEqual(second);
    expect(second).toEqual({ collaborations: [row(51)], nextCursor: null });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.listSessions()).toEqual(before);
    expect(store.getSessionCollaboration(uuid(52))?.revision).toBe(2);
    for (const sessionId of [source, 'peer', 'other']) {
      expect(store.getSessionEvents(sessionId)).toEqual([]);
      expect(store.getOrdinaryInitialCommandId(sessionId)).toBeUndefined();
    }
  } finally {
    store.close();
  }
});

it.each(
  ['', 'with space', 'x'.repeat(201), null, undefined, [], {}].map((sessionId) => ({ sessionId })),
)('validates the source before fetching ($sessionId)', ({ sessionId }) => {
  const fetch = vi.fn();
  expect(() => new CollaborationApiClient(fetch).listForSession(sessionId as string)).toThrow(
    ZodError,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['', 'not-a-cursor', null, [], {}].map((after) => ({ after })))(
  'validates an explicit cursor before fetching ($after)',
  ({ after }) => {
    const fetch = vi.fn();
    expect(() => new CollaborationApiClient(fetch).listForSession(source, after as string)).toThrow(
      ZodError,
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

const invalidPages: Array<[string, unknown]> = [
  ['null', null],
  ['array', []],
  ['missing rows', { nextCursor: null }],
  ['missing cursor', { collaborations: [] }],
  ['unknown page authority', { ...page(), execution: { ready: true } }],
  ['overbound page', page(51)],
  ['foreign source', { collaborations: [row(1, 'foreign')], nextCursor: null }],
  ['duplicate IDs', { collaborations: [row(1), row(1)], nextCursor: null }],
  ['out of order', { collaborations: [row(2), row(1)], nextCursor: null }],
  ['invalid metadata version', { collaborations: [{ ...row(1), version: 2 }], nextCursor: null }],
  ['invalid metadata revision', { collaborations: [{ ...row(1), revision: 0 }], nextCursor: null }],
  [
    'private row payload',
    { collaborations: [{ ...row(1), providerThreadId: 'PRIVATE' }], nextCursor: null },
  ],
  ['invalid cursor', { ...page(50), nextCursor: 'not-a-cursor' }],
  ['empty continuing page', { ...page(0), nextCursor: uuid(1) }],
  ['short continuing page', { ...page(49), nextCursor: uuid(49) }],
  ['cursor before final ID', { ...page(50), nextCursor: uuid(49) }],
  ['cursor after final ID', { ...page(50), nextCursor: uuid(51) }],
];
it.each(invalidPages)('refuses %s responses without another request', async (_label, body) => {
  const fetch = vi.fn().mockResolvedValue(response(body));
  await expect(new CollaborationApiClient(fetch).listForSession(source)).rejects.toBeInstanceOf(
    ZodError,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([4, 5])('refuses a stale row %i at or before the requested cursor', async (n) => {
  const fetch = vi.fn().mockResolvedValue(response({ collaborations: [row(n)], nextCursor: null }));
  await expect(
    new CollaborationApiClient(fetch).listForSession(source, uuid(5)),
  ).rejects.toBeInstanceOf(ZodError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([401, 403, 409, 503])(
  'preserves the existing %i error path without retrying',
  async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 'refused', error: 'Not available' }), { status }),
      );
    await expect(new CollaborationApiClient(fetch).listForSession(source)).rejects.toMatchObject({
      status,
      code: 'refused',
      message: 'Not available',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('uses the existing unavailable error when an error response is not JSON', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(new CollaborationApiClient(fetch).listForSession(source)).rejects.toEqual(
    new CollaborationApiError(503, 'unavailable', 'Collaboration unavailable'),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('preserves caller cancellation through the existing fetch owner without retrying', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled association read');
  const fetch = vi.fn<ApiFetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
  );
  const pending = new CollaborationApiClient(fetch).listForSession(
    source,
    undefined,
    controller.signal,
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('returns isolated parsed metadata without mutating the transport snapshot', async () => {
  const original = page();
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => original });
  const result = await new CollaborationApiClient(fetch).listForSession(source);
  result.collaborations[0].participantSessionIds.push('local-only');
  expect(original).toEqual(page());
  expect(fetch).toHaveBeenCalledTimes(1);
});
