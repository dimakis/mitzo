import { describe, expect, it, vi } from 'vitest';
import { EventStore, type StoredEvent } from '../event-store.js';
import { sessionHistoryTools, type HistoryAccess } from '../session-history-tools.js';

function fixture() {
  let current = true;
  const abort = new AbortController();
  const assertCurrent = vi.fn(() => {
    if (!current) throw Error('revoked secret detail');
  });
  const access: HistoryAccess = {
    signal: abort.signal,
    assertCurrent,
    assertCurrentAsync: vi.fn(async () => assertCurrent()),
    authorizeSearch: vi.fn(async () => {}),
    authorizeRead: vi.fn(async () => ({ assertCurrent })),
    readBoundary: vi.fn(() => 10),
    dispose: vi.fn(),
  };
  const store = {
    listSessionSummaries: vi.fn((_limit: number, _offset: number) => ({
      sessions: [
        {
          sessionId: 'past-1',
          summary: 'Project history secret',
          summaryTruncated: false,
          updatedAt: 2,
        },
        { sessionId: 'denied', summary: 'PRIVATE TITLE', summaryTruncated: false, updatedAt: 2 },
      ],
      hasMore: false,
    })),
    searchSessions: vi.fn(() => [
      {
        sessionId: 'past-1',
        summary: 'Project history secret',
        snippet: 'PRIVATE SNIPPET',
        matchedAt: 1,
        updatedAt: 2,
      },
      {
        sessionId: 'denied',
        summary: 'PRIVATE TITLE',
        snippet: 'PRIVATE SNIPPET',
        matchedAt: 1,
        updatedAt: 2,
      },
    ]),
    getEventsAfter: vi.fn((_id: string, after: number, limit?: number) =>
      rows.filter((row) => row.seq > after).slice(0, limit),
    ),
  };
  let rows: StoredEvent[] = [];
  const capture = vi.fn(() => access);
  const tools = sessionHistoryTools({
    store,
    capture,
    projectPublicText: (text) => text.replaceAll('secret', '[redacted]'),
  });
  const call = { turnId: 'turn-1', callId: 'call-1' };
  const signal = new AbortController().signal;
  return {
    store,
    access,
    capture,
    tools,
    call,
    signal,
    abort,
    revoke: () => {
      current = false;
    },
    setRows: (value: StoredEvent[]) => {
      rows = value;
    },
  };
}
function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  sessionId = 'past-1',
): StoredEvent {
  return { seq, sessionId, type, payload, createdAt: 1 };
}

describe('authorized durable session history tools', () => {
  it('keeps synchronous history-page authorization work bounded independently of row count', async () => {
    const f = fixture();
    vi.mocked(f.access.readBoundary).mockReturnValue(100);
    const read = () =>
      f.tools.execute('ReadPastSession', { conversationId: 'past-1' }, f.signal, f.call);
    f.setRows([event(1, 'block_delta', { blockType: 'text', delta: 'part' })]);
    expect((await read())?.isError).toBe(false);
    const singleRowChecks = vi.mocked(f.access.assertCurrent).mock.calls.length;
    vi.mocked(f.access.assertCurrent).mockClear();
    f.setRows(
      Array.from({ length: 100 }, (_, index) =>
        event(index + 1, 'block_delta', { blockType: 'text', delta: 'part' }),
      ),
    );
    const result = await read();
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content).entries).toHaveLength(100);
    expect(vi.mocked(f.access.assertCurrent).mock.calls.length).toBeLessThanOrEqual(
      singleRowChecks + 2,
    );
  });

  it.each(['revoked', 'aborted'] as const)(
    'withholds the entire history page when authority is %s during synchronous projection',
    async (reason) => {
      const f = fixture();
      f.setRows([
        event(1, 'user_message', { text: 'first' }),
        event(2, 'user_message', { text: 'second' }),
      ]);
      const tools = sessionHistoryTools({
        store: f.store,
        capture: () => f.access,
        projectPublicText: (text) => {
          if (text === 'second') {
            if (reason === 'revoked') f.revoke();
            else f.abort.abort();
          }
          return text;
        },
      });
      const result = await tools.execute(
        'ReadPastSession',
        { conversationId: 'past-1' },
        f.signal,
        f.call,
      );
      expect(result?.isError).toBe(true);
      expect(result!.content).not.toContain('first');
      expect(result!.content).not.toContain('second');
      expect(f.access.dispose).toHaveBeenCalledOnce();
    },
  );

  it('does not reveal session membership from hidden reasoning or redacted summary markers with the real EventStore', async () => {
    const f = fixture();
    const store = new EventStore(':memory:');
    try {
      store.upsertSession({
        sessionId: 'past-1',
        conversationSource: 'mitzo',
        summary: 'Public project secret',
      });
      store.append('past-1', 'block_delta', {
        blockType: 'thinking',
        delta: 'thinking-only-needle',
      });
      store.append('past-1', 'block_delta', { blockType: 'text', delta: 'Visible assistant text' });
      const tools = sessionHistoryTools({
        store,
        capture: () => f.access,
        projectPublicText: (text) => text.replaceAll('secret', '[redacted]'),
      });
      for (const query of ['thinking-only-needle', 'secret']) {
        const result = await tools.execute('SearchPastSessions', { query }, f.signal, f.call);
        expect(result?.isError).toBe(false);
        expect(JSON.parse(result!.content).sessions).toEqual([]);
      }
      const publicMatch = await tools.execute(
        'SearchPastSessions',
        { query: 'Public project' },
        f.signal,
        f.call,
      );
      expect(JSON.parse(publicMatch!.content).sessions).toMatchObject([
        { conversationId: 'past-1', summary: 'Public project [redacted]' },
      ]);
    } finally {
      store.close();
    }
  });
  it('authenticates search and each candidate before exposing bounded public summaries, without snippets', async () => {
    const f = fixture();
    vi.mocked(f.access.authorizeRead).mockImplementation(async (id) => {
      if (id === 'denied') throw Error('denied');
      return { assertCurrent: f.access.assertCurrent };
    });
    const result = await f.tools.execute(
      'SearchPastSessions',
      { query: 'project', limit: 2 },
      f.signal,
      f.call,
    );
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content)).toEqual({
      sessions: [{ conversationId: 'past-1', summary: 'Project history [redacted]', updatedAt: 2 }],
      candidateLimit: 2,
      nextOffset: null,
      searchCoverage: {
        source: 'projected-session-summaries',
        summaryCharacters: 4096,
        scanLimit: 100,
        metadataMayChange: true,
        capped: false,
      },
    });
    expect(f.access.authorizeSearch).toHaveBeenCalledWith('project', expect.anything());
    expect(f.access.authorizeRead).toHaveBeenCalledTimes(2);
    expect(result!.content).not.toContain('PRIVATE');
    expect(f.access.dispose).toHaveBeenCalledOnce();
  });

  it('uses a trusted immutable boundary and emits only public user/text deltas with advancing cursors', async () => {
    const f = fixture();
    f.setRows([
      event(1, 'user_message', { text: 'work on project', credential: 'PRIVATE' }),
      event(2, 'block_delta', { blockType: 'thinking', delta: 'PRIVATE reasoning' }),
      event(3, 'tool_result', { content: 'PRIVATE token' }),
      event(4, 'block_delta', { blockType: 'text', delta: 'public secret', messageId: 'm1' }),
      event(11, 'user_message', { text: 'future' }),
    ]);
    const first = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past-1', limit: 3 },
      f.signal,
      f.call,
    );
    expect(first?.isError).toBe(false);
    expect(JSON.parse(first!.content)).toEqual({
      conversationId: 'past-1',
      throughSeq: 10,
      entries: [{ seq: 1, kind: 'user', text: 'work on project' }],
      nextAfterSeq: 3,
    });
    expect(f.store.getEventsAfter).toHaveBeenCalledWith('past-1', 0, 4);
    const next = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past-1', throughSeq: 10, afterSeq: 3, limit: 3 },
      f.signal,
      f.call,
    );
    expect(JSON.parse(next!.content)).toEqual({
      conversationId: 'past-1',
      throughSeq: 10,
      entries: [{ seq: 4, kind: 'assistant', text: 'public [redacted]' }],
      nextAfterSeq: null,
    });
    expect(next!.content).not.toContain('PRIVATE');
    expect(next!.content).not.toContain('future');
    expect(f.access.authorizeRead).toHaveBeenCalledTimes(2);
  });

  it('continues after the last consumed candidate without exposing denied IDs or skipping later matches', async () => {
    const f = fixture();
    const rows = [
      { sessionId: 'past-1', summary: 'Project one', summaryTruncated: false, updatedAt: 3 },
      {
        sessionId: 'denied-private-id',
        summary: 'Project denied',
        summaryTruncated: false,
        updatedAt: 2,
      },
      { sessionId: 'past-2', summary: 'Project two', summaryTruncated: false, updatedAt: 1 },
    ];
    f.store.listSessionSummaries.mockImplementation((limit, offset) => ({
      sessions: rows.slice(offset, offset + limit),
      hasMore: offset + limit < rows.length,
    }));
    vi.mocked(f.access.authorizeRead).mockImplementation(async (id) => {
      if (id.startsWith('denied')) throw Error('private target');
      return { assertCurrent: f.access.assertCurrent };
    });
    const first = await f.tools.execute(
      'SearchPastSessions',
      { query: 'Project', limit: 1 },
      f.signal,
      f.call,
    );
    expect(JSON.parse(first!.content)).toMatchObject({
      sessions: [{ conversationId: 'past-1' }],
      nextOffset: 1,
    });
    const next = await f.tools.execute(
      'SearchPastSessions',
      { query: 'Project', limit: 1, offset: 1 },
      f.signal,
      f.call,
    );
    expect(JSON.parse(next!.content)).toMatchObject({
      sessions: [{ conversationId: 'past-2' }],
      nextOffset: null,
    });
    expect(first!.content + next!.content).not.toContain('denied');
  });

  it('reports scan and summary bounds and a hard search cap without assuming that all history was searched', async () => {
    const f = fixture();
    const rows = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `past-${index}`,
      summary: 'Other title',
      summaryTruncated: false,
      updatedAt: index,
    }));
    f.store.listSessionSummaries.mockReturnValue({ sessions: rows, hasMore: true });
    const scan = await f.tools.execute(
      'SearchPastSessions',
      { query: 'unmatched' },
      f.signal,
      f.call,
    );
    expect(JSON.parse(scan!.content)).toMatchObject({
      sessions: [],
      nextOffset: 100,
      searchCoverage: { scanLimit: 100, summaryCharacters: 4096, capped: false },
    });
    const cap = await f.tools.execute(
      'SearchPastSessions',
      { query: 'unmatched', offset: 100000 },
      f.signal,
      f.call,
    );
    expect(JSON.parse(cap!.content)).toMatchObject({
      sessions: [],
      nextOffset: null,
      searchCoverage: { capped: true },
    });
    expect(f.store.listSessionSummaries).toHaveBeenCalledTimes(1);
  });

  it('keeps byte-bounded search continuation at the unconsumed next candidate', async () => {
    const f = fixture();
    const rows = Array.from({ length: 20 }, (_, index) => ({
      sessionId: `${index}` + '\0'.repeat(125),
      summary: 'Project ' + '\0'.repeat(4088),
      summaryTruncated: false,
      updatedAt: index,
    }));
    f.store.listSessionSummaries.mockImplementation((limit, offset) => ({
      sessions: rows.slice(offset, offset + limit),
      hasMore: offset + limit < rows.length,
    }));
    const result = await f.tools.execute(
      'SearchPastSessions',
      { query: 'Project' },
      f.signal,
      f.call,
    );
    const page = JSON.parse(result!.content);
    expect(result?.isError).toBe(false);
    expect(Buffer.byteLength(result!.content)).toBeLessThanOrEqual(32768);
    expect(page.sessions.length).toBeGreaterThan(0);
    expect(page.sessions.length).toBeLessThan(20);
    expect(page.nextOffset).toBe(page.sessions.length);
    const next = await f.tools.execute(
      'SearchPastSessions',
      { query: 'Project', offset: page.nextOffset },
      f.signal,
      f.call,
    );
    expect(JSON.parse(next!.content).sessions[0].conversationId).toBe(
      rows[page.nextOffset].sessionId,
    );
  });

  it('accepts the SQL Unicode character bound without treating UTF-16 length as private row overflow', async () => {
    const f = fixture();
    f.store.listSessionSummaries.mockReturnValue({
      sessions: [
        { sessionId: 'past-1', summary: '😀'.repeat(4096), summaryTruncated: false, updatedAt: 2 },
      ],
      hasMore: false,
    });
    const result = await f.tools.execute('SearchPastSessions', { query: '😀' }, f.signal, f.call);
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content).sessions).toMatchObject([
      { conversationId: 'past-1', summaryTruncated: true },
    ]);
  });

  it('denies reads before touching storage and refuses unauthenticated or malformed calls', async () => {
    const f = fixture();
    vi.mocked(f.access.authorizeRead).mockRejectedValue(Error('PRIVATE denial'));
    expect(
      (await f.tools.execute('ReadPastSession', { conversationId: 'past-1' }, f.signal, f.call))
        ?.isError,
    ).toBe(true);
    expect(f.store.getEventsAfter).not.toHaveBeenCalled();
    expect(
      (await f.tools.execute('SearchPastSessions', { query: 'project' }, f.signal))?.isError,
    ).toBe(true);
    expect(
      (
        await f.tools.execute(
          'ReadPastSession',
          { conversationId: 'past-1', limit: 101 },
          f.signal,
          f.call,
        )
      )?.isError,
    ).toBe(true);
    expect(await f.tools.execute('OtherTool', {}, f.signal, f.call)).toBeUndefined();
    expect(f.store.searchSessions).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'cancelled'] as const)(
    'withholds results when authorization is %s during a wait',
    async (reason) => {
      const f = fixture();
      vi.mocked(f.access.authorizeRead).mockImplementation(async () => {
        if (reason === 'revoked') f.revoke();
        else f.abort.abort();
        return { assertCurrent: f.access.assertCurrent };
      });
      const result = await f.tools.execute(
        'ReadPastSession',
        { conversationId: 'past-1' },
        f.signal,
        f.call,
      );
      expect(result?.isError).toBe(true);
      expect(result!.content).not.toContain('secret detail');
      expect(f.store.getEventsAfter).not.toHaveBeenCalled();
      expect(f.access.dispose).toHaveBeenCalledOnce();
    },
  );

  it('rejects invented future boundaries, mismatched records, and nonadvancing event streams', async () => {
    const f = fixture();
    expect(
      (
        await f.tools.execute(
          'ReadPastSession',
          { conversationId: 'past-1', throughSeq: 11 },
          f.signal,
          f.call,
        )
      )?.isError,
    ).toBe(true);
    expect(f.store.getEventsAfter).not.toHaveBeenCalled();
    for (const rows of [
      [event(1, 'user_message', { text: 'PRIVATE' }, 'other')],
      [event(0, 'user_message', { text: 'PRIVATE' })],
    ]) {
      f.store.getEventsAfter.mockImplementationOnce(() => rows);
      const result = await f.tools.execute(
        'ReadPastSession',
        { conversationId: 'past-1' },
        f.signal,
        f.call,
      );
      expect(result?.isError).toBe(true);
      expect(result!.content).not.toContain('PRIVATE');
    }
  });

  it('withholds earlier search candidates if their authorization is revoked during a later authorization wait', async () => {
    const f = fixture();
    let firstAuthorized = true;
    vi.mocked(f.access.authorizeRead).mockImplementation(async (id) => {
      if (id === 'past-1')
        return {
          assertCurrent: () => {
            if (!firstAuthorized) throw Error('revoked target');
          },
        };
      firstAuthorized = false;
      return { assertCurrent: () => {} };
    });
    const result = await f.tools.execute(
      'SearchPastSessions',
      { query: 'project' },
      f.signal,
      f.call,
    );
    expect(result?.isError).toBe(true);
    expect(result!.content).not.toContain('Project history');
  });

  it('continues a byte-bounded page without skipping the next complete event', async () => {
    const f = fixture();
    f.setRows([
      event(1, 'user_message', { text: 'a'.repeat(20000) }),
      event(2, 'user_message', { text: 'b'.repeat(20000) }),
    ]);
    const first = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past-1' },
      f.signal,
      f.call,
    );
    expect(JSON.parse(first!.content)).toMatchObject({ entries: [{ seq: 1 }], nextAfterSeq: 1 });
    expect(Buffer.byteLength(first!.content)).toBeLessThanOrEqual(32768);
    const next = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past-1', afterSeq: 1, throughSeq: 10 },
      f.signal,
      f.call,
    );
    expect(JSON.parse(next!.content)).toMatchObject({ entries: [{ seq: 2 }], nextAfterSeq: null });
    expect(Buffer.byteLength(next!.content)).toBeLessThanOrEqual(32768);
  });

  it('reports oversized events explicitly without silently skipping them or exceeding 32KiB', async () => {
    const f = fixture();
    f.setRows([
      event(1, 'user_message', { text: 'small' }),
      event(2, 'user_message', { text: 'x'.repeat(40000) }),
    ]);
    const result = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past-1' },
      f.signal,
      f.call,
    );
    expect(Buffer.byteLength(result!.content)).toBeLessThanOrEqual(32768);
    expect(JSON.parse(result!.content)).toEqual({
      conversationId: 'past-1',
      throughSeq: 10,
      entries: [{ seq: 1, kind: 'user', text: 'small' }],
      nextAfterSeq: null,
      blockedEvent: { seq: 2, reason: 'event_exceeds_output_bound' },
    });
  });

  it('integrates with real bounded EventStore SQL reads and a durable highwater without recovery or transcript fallback', async () => {
    const f = fixture();
    const store = new EventStore(':memory:');
    try {
      store.upsertSession({
        sessionId: 'past-1',
        conversationSource: 'mitzo',
        summary: 'Fixture project',
      });
      const userSeq = store.append('past-1', 'user_message', {
        text: 'Find project',
        credential: 'PRIVATE',
      });
      const thinkingSeq = store.append('past-1', 'block_delta', {
        blockType: 'thinking',
        delta: 'PRIVATE',
      });
      store.append('past-1', 'tool_result', { content: 'PRIVATE' });
      const assistantSeq = store.append('past-1', 'block_delta', {
        blockType: 'text',
        delta: 'Public result',
      });
      const boundary = vi.fn((id: string) => store.captureReconnectState(id, 0, false).cursor);
      const boundedRead = vi.spyOn(store, 'getEventsAfter');
      const unboundedRead = vi.spyOn(store, 'getSessionEvents');
      const wholePrefix = vi.spyOn(store, 'getSessionEventsThroughCursor');
      const tools = sessionHistoryTools({
        store,
        capture: () => ({ ...f.access, readBoundary: boundary }),
        projectPublicText: (text) => text,
      });
      const first = await tools.execute(
        'ReadPastSession',
        { conversationId: 'past-1', limit: 2 },
        f.signal,
        f.call,
      );
      expect(JSON.parse(first!.content)).toEqual({
        conversationId: 'past-1',
        throughSeq: assistantSeq,
        entries: [{ seq: userSeq, kind: 'user', text: 'Find project' }],
        nextAfterSeq: thinkingSeq,
      });
      store.append('past-1', 'user_message', { text: 'Future text' });
      const next = await tools.execute(
        'ReadPastSession',
        { conversationId: 'past-1', afterSeq: thinkingSeq, throughSeq: assistantSeq, limit: 2 },
        f.signal,
        f.call,
      );
      expect(JSON.parse(next!.content)).toEqual({
        conversationId: 'past-1',
        throughSeq: assistantSeq,
        entries: [{ seq: assistantSeq, kind: 'assistant', text: 'Public result' }],
        nextAfterSeq: null,
      });
      const search = await tools.execute(
        'SearchPastSessions',
        { query: 'Fixture' },
        f.signal,
        f.call,
      );
      expect(JSON.parse(search!.content).sessions).toMatchObject([
        { conversationId: 'past-1', summary: 'Fixture project' },
      ]);
      expect(boundedRead.mock.calls).toEqual([
        ['past-1', 0, 3],
        ['past-1', thinkingSeq, 3],
      ]);
      expect(boundary).toHaveBeenCalledTimes(2);
      expect(unboundedRead).not.toHaveBeenCalled();
      expect(wholePrefix).not.toHaveBeenCalled();
      expect(next!.content).not.toContain('Future');
      expect(first!.content + next!.content).not.toContain('PRIVATE');
      expect(store.getEventsAfter('past-1', 0, 10)).toHaveLength(5);
    } finally {
      store.close();
    }
  });
});
