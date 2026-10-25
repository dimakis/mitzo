// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../api-fetch';
import {
  commitNativeContinuation,
  NativeContinuationReviewSchema,
} from '../legacy-native-continuation';
vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('observes uncertain admission with the exact review identity instead of issuing a fresh command', async () => {
  const body = {
    ok: false,
    sessionId: 'native-child',
    clientMsgId: 'original-command',
    state: 'uncertain',
    dispatched: false,
  };
  vi.mocked(apiFetch).mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 202 }),
  );
  const review = {
    reviewHash: 'a'.repeat(64),
    nativeSessionId: 'native-child',
    commandId: 'original-command',
  };
  expect(await commitNativeContinuation('source', review, 'connection', true, true)).toEqual(body);
  expect(await commitNativeContinuation('source', review, 'connection', true, true)).toEqual(body);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  for (const [path, init] of vi.mocked(apiFetch).mock.calls) {
    expect(path).toBe('/api/sessions/source/native-continuation/commit');
    expect(JSON.parse(init!.body as string)).toEqual({
      reviewHash: review.reviewHash,
      acknowledgeUncertainOutcomes: true,
      acknowledgeSelectionChange: true,
    });
    expect(new Headers(init!.headers).get('X-Connection-Id')).toBe('connection');
  }
});

it('refuses a receipt belonging to another native conversation', async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        sessionId: 'other',
        clientMsgId: 'original-command',
        state: 'consumed',
        dispatched: true,
      }),
      { status: 202 },
    ),
  );
  await expect(
    commitNativeContinuation(
      'source',
      {
        reviewHash: 'a'.repeat(64),
        nativeSessionId: 'native-child',
        commandId: 'original-command',
      },
      'connection',
      false,
      false,
    ),
  ).rejects.toThrow('Native continuation receipt identity changed');
});

it('rejects an unbounded or malformed review before showing it for approval', () => {
  expect(NativeContinuationReviewSchema.safeParse({ context: 'x'.repeat(48001) }).success).toBe(
    false,
  );
});
