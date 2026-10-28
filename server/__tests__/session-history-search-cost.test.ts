import { expect, it, vi } from 'vitest';
import { captureSessionHistoryAuthorization } from '../session-history-authorization.js';
import { sessionHistoryTools } from '../session-history-tools.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import type { EventStore } from '../event-store.js';

// Compose the real search and authorization adapter. Only the underlying native
// owner is counted here; no credentials, provider RPC, filesystem or model calls.
async function measureSearch(size: number, matches = false) {
  const call = { turnId: 'offline-turn', callId: 'offline-call' };
  const context = {
    signal: new AbortController().signal,
    toolName: 'SearchPastSessions',
    ...call,
    assertCurrentSync: vi.fn(),
    assertCurrent: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  const sessions = Array.from({ length: size }, (_, index) => ({
    sessionId: `candidate-${index}`,
    summary: matches ? 'absent public match' : 'Unrelated public summary',
    summaryTruncated: false,
    updatedAt: index,
    createdAt: index,
    conversationSource: 'mitzo',
    isHidden: false,
  }));
  const getSession = vi.fn((id: string) => sessions.find((s) => s.sessionId === id));
  const tools = sessionHistoryTools({
    store: {
      listSessionSummaries: () => ({ sessions, hasMore: true }),
      getEventsAfter: () => [],
    },
    capture: () =>
      captureSessionHistoryAuthorization({
        context: context as unknown as NativeHostToolContext,
        events: { getSession } as unknown as EventStore,
        call,
        toolName: 'SearchPastSessions',
      }),
    projectPublicText: (text) => text,
  });
  const result = await tools.execute(
    'SearchPastSessions',
    { query: 'absent' },
    context.signal,
    call,
  );
  expect(result?.isError).toBe(false);
  expect(JSON.parse(result!.content).sessions).toHaveLength(matches ? Math.min(size, 20) : 0);
  expect(JSON.parse(result!.content).nextOffset).toBe(matches ? Math.min(size, 20) : size);
  expect(context.dispose).toHaveBeenCalledOnce();
  return {
    size,
    ownerSync: context.assertCurrentSync.mock.calls.length,
    ownerAsync: context.assertCurrent.mock.calls.length,
    targetReads: getSession.mock.calls.length,
  };
}

it('keeps native owner validation linear when scanning a full page of unrelated sessions', async () => {
  const small = await measureSearch(10);
  const large = await measureSearch(100);
  console.info('history-search-cost', JSON.stringify({ small, large }));
  expect(large.ownerSync).toBeLessThanOrEqual(small.ownerSync * 10);
  expect(large.targetReads).toBeLessThanOrEqual(small.targetReads * 10);
});

it.each([false, true])(
  'bounds full asynchronous validation for a search page (matches: %s)',
  async (matches) => {
    const result = await measureSearch(100, matches);
    expect(result.ownerAsync).toBeLessThanOrEqual(8);
    expect(result.ownerSync).toBeLessThanOrEqual(200);
    expect(result.targetReads).toBeLessThanOrEqual(400);
  },
);
