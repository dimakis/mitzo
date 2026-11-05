import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import type Database from 'better-sqlite3';
import { sessionHistoryTools, type HistoryAccess } from '../session-history-tools.js';
import { sessionDisplayName } from '../session-naming-context.js';
import { readHistoryMessages } from '../session-history-reader.js';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.upsertSession({
    sessionId: 'past',
    conversationSource: 'mitzo',
    summary: 'Unrelated title',
  });
  const abort = new AbortController();
  const current = vi.fn(() => abort.signal.throwIfAborted());
  const access: HistoryAccess = {
    signal: abort.signal,
    assertCurrent: current,
    assertCurrentAsync: async () => current(),
    authorizeSearch: async () => {},
    allowTranscriptSearch: () => true,
    authorizeRead: async () => ({ assertCurrent: current }),
    readBoundary: (id) => store.captureReconnectState(id, 0, false).cursor,
    dispose: vi.fn(),
  };
  const project = vi.fn((text: string) => text.replaceAll('secret', '[redacted]'));
  const tools = sessionHistoryTools({ store, capture: () => access, projectPublicText: project });
  const execute = async (name: string, input: Record<string, unknown>) => {
    const result = await tools.execute(name, input, abort.signal, {
      turnId: 'turn',
      callId: 'call',
    });
    expect(result?.isError, result?.content).toBe(false);
    return JSON.parse(result!.content);
  };
  const user = (text: string) => store.append('past', 'user_message', { text });
  const delta = (text: string, messageId = 'answer') =>
    store.append('past', 'block_delta', {
      blockType: 'text',
      messageId,
      blockId: 'text',
      delta: text,
    });
  return {
    store,
    access,
    abort,
    project,
    tools,
    execute,
    user,
    delta,
    read: (input: Record<string, unknown> = {}) =>
      execute('ReadPastSession', { conversationId: 'past', ...input }),
    search: (input: Record<string, unknown> = {}) =>
      execute('SearchPastSessions', { query: 'release decision', ...input }),
  };
}

describe('message-oriented session retrieval', () => {
  it('bounds session-list title recovery and projects only public naming context', () => {
    const f = fixture();
    f.user('Continue');
    f.store.append('past', 'tool_result', { content: 'PRIVATE'.repeat(100000) });
    f.store.append('past', 'message_start', { messageId: 'answer' });
    for (const [blockId, blockType, delta] of [
      ['thinking', 'thinking', '## PRIVATE reasoning title'],
      ['text', 'text', '## Fix bounded naming'],
    ]) {
      const identity = { messageId: 'answer', blockId, blockType };
      f.store.append('past', 'block_start', identity);
      f.store.append('past', 'block_delta', { ...identity, delta });
      f.store.append('past', 'block_end', identity);
    }
    f.store.append('past', 'message_end', { messageId: 'answer' });
    f.store.append('past', 'user_message', { text: 'Fix PRIVATE closeout', source: 'closeout' });
    f.store.append('past', 'user_message', { text: 'Fix PRIVATE seat', seatId: 'other' });
    for (let i = 0; i < 300; i++) f.store.append('past', 'tool_result', { content: 'PRIVATE' });
    const fullRead = vi.spyOn(f.store, 'getSessionEvents');
    const events = f.store.getSessionNamingEvents('past');
    expect(events).toHaveLength(256);
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(100000);
    const title = sessionDisplayName({ sessionId: 'past', summary: 'Continue' }, events);
    expect(title).toBe('Fix bounded naming');
    expect(JSON.stringify(events)).not.toContain('PRIVATE reasoning');
    expect(JSON.stringify(events)).not.toContain('PRIVATEPRIVATE');
    expect(fullRead).not.toHaveBeenCalled();
  });

  it.each(['seatId', 'symposiumProvenance'])(
    'refuses nested %s audiences in history text',
    async (field) => {
      const f = fixture();
      f.store.append('past', 'user_message', { text: 'PRIVATE audience', [field]: 'other' });
      const result = await f.tools.execute(
        'ReadPastSession',
        { conversationId: 'past' },
        f.abort.signal,
        { turnId: 'turn', callId: 'audience' },
      );
      expect(result?.isError).toBe(true);
      expect(result?.content).not.toContain('PRIVATE');
      expect(f.project).not.toHaveBeenCalled();
    },
  );

  it.each(['oversized-event', 'aggregate-text'])(
    'stops naming at the %s text budget without interpreting clipped content',
    (bound) => {
      const f = fixture();
      f.user('Continue');
      const start = f.store.append('past', 'message_start', { messageId: 'answer' });
      const identity = { messageId: 'answer', blockId: 'text', blockType: 'text' };
      f.store.append('past', 'block_start', identity);
      const first = f.delta(
        '## Wrong clipped title\n' + 'x'.repeat(bound === 'oversized-event' ? 40000 : 20000),
      );
      if (bound === 'aggregate-text') f.delta('x'.repeat(20000));
      f.store.append('past', 'block_end', identity);
      f.store.append('past', 'message_end', { messageId: 'answer' });
      const events = f.store.getSessionNamingEvents('past');
      expect(events.map((event) => event.seq)).toEqual([
        1,
        start,
        start + 1,
        ...(bound === 'aggregate-text' ? [first] : []),
      ]);
      expect(sessionDisplayName({ sessionId: 'past', summary: 'Continue' }, events)).toBe(
        'Chat past',
      );
    },
  );

  it('crosses 2000 excluded tool events in one call without returning empty continuation pages', async () => {
    const f = fixture();
    for (let i = 0; i < 2000; i++)
      f.store.append('past', 'tool_result', { content: 'PRIVATE tool payload' });
    const seq = f.delta('A useful answer');
    const page = await f.read();
    expect(page.entries).toEqual([{ seq, kind: 'assistant', text: 'A useful answer' }]);
    expect(page.nextAfterSeq).toBeNull();
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
  });

  it('assembles a 2000-fragment answer and counts messages rather than fragments', async () => {
    const f = fixture();
    const start = f.user('Question');
    let end = 0;
    for (let i = 0; i < 2000; i++) end = f.delta('word ');
    const page = await f.read({ limit: 2 });
    expect(page.entries).toEqual([
      { seq: start, kind: 'user', text: 'Question' },
      { seq: start + 1, endSeq: end, kind: 'assistant', text: 'word '.repeat(2000) },
    ]);
    expect(page.nextAfterSeq).toBeNull();
    expect(f.project).toHaveBeenCalledTimes(2);
  });

  it('continues at the end of an assembled message and retains the original snapshot', async () => {
    const f = fixture();
    f.user('Question');
    f.delta('first ');
    const end = f.delta('answer');
    const last = f.user('Another question');
    const first = await f.read({ limit: 2 });
    expect(first.nextAfterSeq).toBe(end);
    f.user('future');
    const next = await f.read({ afterSeq: first.nextAfterSeq, throughSeq: first.throughSeq });
    expect(next.entries).toEqual([{ seq: last, kind: 'user', text: 'Another question' }]);
    expect(next.nextAfterSeq).toBeNull();
    expect(JSON.stringify(next)).not.toContain('future');
  });

  it('searches assembled projected text and never matches reasoning, tool payloads or redacted text', async () => {
    const f = fixture();
    f.store.append('past', 'block_delta', {
      blockType: 'thinking',
      delta: 'release decision PRIVATE',
    });
    f.store.append('past', 'tool_result', { content: 'release decision PRIVATE' });
    f.delta('The release ');
    const end = f.delta('decision was recorded.');
    const page = await f.read({ query: 'release decision' });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      endSeq: end,
      text: 'The release decision was recorded.',
    });
    f.delta('sec', 'redacted');
    f.delta('ret', 'redacted');
    expect((await f.read({ query: 'secret' })).entries).toEqual([]);
    expect((await f.read({ query: 'PRIVATE' })).entries).toEqual([]);
  });

  it('reads recent messages and pages backwards without including later appends', async () => {
    const f = fixture();
    const old = f.user('old');
    f.delta('middle', 'middle');
    const latest = f.user('latest');
    const first = await f.read({ recent: true, limit: 1 });
    expect(first.entries).toEqual([{ seq: latest, kind: 'user', text: 'latest' }]);
    expect(first.nextBeforeSeq).toBe(latest);
    f.user('future');
    const next = await f.read({
      recent: true,
      beforeSeq: first.nextBeforeSeq,
      throughSeq: first.throughSeq,
    });
    expect(next.entries.map((entry: { text: string }) => entry.text)).toEqual(['old', 'middle']);
    expect(next.entries[0].seq).toBe(old);
    expect(next.nextBeforeSeq).toBeNull();
  });

  it('splits large streamed answers at event boundaries without losing or repeating text', async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.delta(`${i}:` + 'x'.repeat(1000));
    let afterSeq = 0;
    let throughSeq: number | undefined;
    let text = '';
    let calls = 0;
    do {
      const page = await f.read({ afterSeq, ...(throughSeq === undefined ? {} : { throughSeq }) });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768);
      text += page.entries.map((entry: { text: string }) => entry.text).join('');
      throughSeq = page.throughSeq;
      afterSeq = page.nextAfterSeq;
      calls++;
    } while (afterSeq !== null && calls < 10);
    expect(calls).toBeLessThanOrEqual(4);
    expect(text).toBe(Array.from({ length: 80 }, (_, i) => `${i}:` + 'x'.repeat(1000)).join(''));
  });

  it('withholds a whole page when projection revokes authority', async () => {
    const f = fixture();
    f.user('visible');
    f.project.mockImplementation(() => {
      f.abort.abort();
      return 'must not escape';
    });
    const result = await f.tools.execute(
      'ReadPastSession',
      { conversationId: 'past' },
      f.abort.signal,
      { turnId: 'turn', callId: 'call' },
    );
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain('must not escape');
    expect(f.access.dispose).toHaveBeenCalledOnce();
  });

  it('bounds a no-match scan and provides advancing continuation rather than claiming complete coverage', async () => {
    const f = fixture();
    for (let i = 0; i < 9000; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    const answer = f.delta('release decision');
    const first = await f.read({ query: 'release decision' });
    expect(first.entries).toEqual([]);
    expect(first.nextAfterSeq).toBeGreaterThan(0);
    expect(first.nextAfterSeq).toBeLessThan(answer);
    const next = await f.read({
      query: 'release decision',
      afterSeq: first.nextAfterSeq,
      throughSeq: first.throughSeq,
    });
    expect(next.entries[0].text).toBe('release decision');
    expect(next.nextAfterSeq).toBeNull();
  });

  it('finds transcript-only matches across fragments and returns a usable anchor', async () => {
    const f = fixture();
    const seq = f.delta('release ');
    f.delta('decision');
    const result = await f.search();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      conversationId: 'past',
      matchedSeq: seq,
      snippet: 'release decision',
    });
    expect(result.nextOffset).toBeNull();
  });

  it('finds a phrase crossing both the scan boundary and the assembled entry byte boundary', async () => {
    const f = fixture();
    for (let i = 0; i < 8191; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    f.delta('release ');
    f.delta('decision');
    const first = await f.read({ query: 'release decision' });
    const next = await f.read({
      query: 'release decision',
      afterSeq: first.nextAfterSeq,
      throughSeq: first.throughSeq,
    });
    expect(next.entries[0].text).toContain('release decision');
    const g = fixture();
    g.delta('x'.repeat(30000) + ' release ');
    g.delta('decision');
    expect((await g.read({ query: 'release decision' })).entries[0].text).toContain(
      'release decision',
    );
  });

  it('retains the starting block when a continuation also contains another text block', async () => {
    const f = fixture();
    for (let i = 0; i < 8191; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    const start = f.delta('release ');
    f.delta('decision');
    f.store.append('past', 'block_delta', {
      blockType: 'text',
      messageId: 'answer',
      blockId: 'another',
      delta: 'Another block',
    });
    const first = await f.read({ query: 'release decision' });
    expect(first.nextAfterSeq).toBe(start);
    const next = await f.read({
      query: 'release decision',
      afterSeq: first.nextAfterSeq,
      throughSeq: first.throughSeq,
    });
    expect(next.entries[0].text).toContain('release decision');
    const search = await f.search();
    expect(search.sessions).toEqual([]);
    const continuation = await f.search({ cursor: search.nextCursor });
    expect(continuation.sessions[0].snippet).toContain('release decision');
  });

  it.each([
    {
      example: 'paragraph separator',
      query: 'release\n\ndecision',
      prefix: 'release',
      suffix: 'decision',
      blockId: 'another',
    },
    { example: 'expanded query', query: 'İx', prefix: 'i\u0307', suffix: 'x', blockId: 'text' },
    {
      example: '256-character expanded query',
      query: 'İ'.repeat(255) + 'x',
      prefix: 'i\u0307'.repeat(255),
      suffix: 'x',
      blockId: 'text',
    },
  ])(
    'preserves assembled matching across a scan boundary ($example)',
    async ({ query, prefix, suffix, blockId }) => {
      const f = fixture();
      for (let i = 0; i < 8191; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
      const boundary = f.delta(prefix);
      f.store.append('past', 'block_delta', {
        blockType: 'text',
        messageId: 'answer',
        blockId,
        delta: suffix,
      });
      const first = await f.read({ query });
      expect(first.entries).toEqual([]);
      expect(first.nextAfterSeq).toBe(boundary);
      const next = await f.read({ query, afterSeq: boundary, throughSeq: first.throughSeq });
      expect(next.entries).toHaveLength(1);
      expect(next.entries[0].text).toContain(suffix);
      expect(next.nextAfterSeq).toBeNull();
      const g = fixture();
      g.delta(prefix);
      g.store.append('past', 'block_delta', {
        blockType: 'text',
        messageId: 'answer',
        blockId,
        delta: suffix,
      });
      // Fill precisely the rest of the recent raw-event window, leaving its
      // first fragment in the look-behind rather than in the main page.
      const contextBudget = Math.min(512, query.toLowerCase().length);
      for (let i = 0; i < 8192 - contextBudget - 1; i++)
        g.store.append('past', 'tool_result', { content: 'excluded' });
      const recent = await g.read({ query, recent: true });
      expect(recent.entries).toHaveLength(1);
      const search = await f.search({ query });
      expect(search.sessions).toEqual([]);
      const continuation = await f.search({ query, cursor: search.nextCursor });
      expect(continuation.sessions[0]).toMatchObject({
        conversationId: 'past',
        matchedSeq: boundary,
      });
      expect(continuation.sessions[0].snippet.toLowerCase()).toContain(
        query.toLowerCase().slice(0, 8),
      );
      expect(continuation.nextCursor).toBeNull();
    },
  );

  it('anchors a continuation near its contributing tail rather than the full look-behind window', async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) f.delta('unrelated '.repeat(200));
    const boundary = f.delta('x'.repeat(2000) + 'release ');
    f.delta('decision');
    const page = await f.read({ query: 'release decision', afterSeq: boundary });
    expect(page.entries[0]).toMatchObject({ seq: boundary });
    expect(page.entries[0].text).toContain('release decision');
  });

  it('reports incomplete coverage when excluded deltas exhaust query overlap', async () => {
    const f = fixture();
    for (let i = 0; i < 8191; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    const boundary = f.delta('release ');
    for (let i = 0; i < 20; i++)
      f.store.append('past', 'block_delta', {
        messageId: 'answer',
        blockId: 'reasoning',
        blockType: 'thinking',
        delta: 'PRIVATE reasoning',
      });
    const suffix = f.delta('decision');
    const first = await f.read({ query: 'release decision' });
    expect(first.nextAfterSeq).toBe(boundary);
    const next = await f.read({
      query: 'release decision',
      afterSeq: boundary,
      throughSeq: first.throughSeq,
    });
    expect(next.blockedEvent).toEqual({ seq: suffix, reason: 'query_overlap_exceeds_scan_bound' });
    expect(JSON.stringify(next)).not.toContain('PRIVATE');
    const search = await f.search();
    const continuation = await f.search({ cursor: search.nextCursor });
    expect(continuation.sessions).toEqual([]);
    expect(continuation.searchCoverage.blockedSessions).toBe(1);
    expect(continuation.searchCoverage.scannedEvents).toBeLessThanOrEqual(8192);
    // An observed match remains valid even if earlier overlap was incomplete.
    f.delta('release decision');
    const matched = await f.read({ query: 'release decision', afterSeq: suffix });
    expect(matched.entries[0].text).toContain('release decision');
    expect(matched.blockedEvent).toBeUndefined();
  });

  it.each([false, true])(
    'reports incomplete overlap with a one-event budget (recent: %s)',
    (recent) => {
      const f = fixture();
      const boundary = f.delta('release ');
      const suffix = f.delta('decision');
      const result = readHistoryMessages({
        store: f.store,
        conversationId: 'past',
        afterSeq: boundary,
        throughSeq: suffix,
        query: 'release decision',
        recent,
        limit: 1,
        scanLimit: 1,
        project: f.project,
      });
      expect(result.blockedEvent).toEqual({
        seq: suffix,
        reason: 'query_overlap_exceeds_scan_bound',
      });
      expect(result.scannedEvents).toBe(1);
    },
  );

  it('uses original Unicode offsets for excerpts in both history tools', async () => {
    const f = fixture();
    f.user('İ'.repeat(300) + 'needle' + 'z'.repeat(300));
    const page = await f.read({ query: 'NEEDLE' });
    expect(page.entries[0].text).toContain('needle');
    expect(page.entries[0].text.startsWith('İ'.repeat(80))).toBe(true);
    expect(page.entries[0].excerpt).toBe(true);
    const search = await f.search({ query: 'NEEDLE' });
    expect(search.sessions[0].snippet).toContain('needle');
  });

  it('seeks backwards from the requested boundary rather than filtering newer rows', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.user(String(i));
    const db = (f.store as unknown as { db: Database.Database }).db;
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      queries.push(sql);
      return prepare(sql);
    });
    expect(
      f.store.getHistoryEventPage('past', 0, 100, 2, 10, true).events.map((row) => row.seq),
    ).toEqual([9, 8]);
    // The actual read must place the continuation in the seek argument, not a
    // residual predicate. Assert both the planner and the bound parameter.
    const plan = prepare('EXPLAIN QUERY PLAN ' + queries[0]).all(
      { textStart: 1, textLength: 32769 },
      'past',
      0,
      9,
      3,
    ) as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(
      /SEARCH events USING INDEX .*\(session_id=\? AND (?:seq|rowid)>\? AND (?:seq|rowid)<\?\)/,
    );
    expect(f.store.getHistoryEventPage('past', 0, 100, 2, 0, true).events).toEqual([]);
  });

  it.each([undefined, ['text', String.fromCharCode(0), 'thinking'].join('')])(
    'retains the final authorization check for unsupported message pages (%s)',
    async (blockType) => {
      const f = fixture();
      f.store.append('past', 'block_delta', { blockType, delta: 'PRIVATE unknown format' });
      const format = await f.tools.execute(
        'ReadPastSession',
        { conversationId: 'past' },
        f.abort.signal,
        { turnId: 'turn', callId: 'format' },
      );
      expect(format?.isError).toBe(true);
      expect(format?.content).toContain('unsupported');
      expect(f.project).not.toHaveBeenCalled();
      let refreshes = 0;
      f.access.assertCurrentAsync = async () => {
        if (++refreshes === 4) throw Error('revoked');
      };
      const result = await f.tools.execute(
        'ReadPastSession',
        { conversationId: 'past' },
        f.abort.signal,
        { turnId: 'turn', callId: 'call' },
      );
      expect(result?.isError).toBe(true);
      expect(result?.content).not.toContain('unsupported');
      expect(result?.content).not.toContain('PRIVATE');
      expect(refreshes).toBe(4);
    },
  );

  it('projects large excluded payloads inside SQLite and bounds returned text bytes', () => {
    const f = fixture();
    f.store.append('past', 'tool_result', { content: 'PRIVATE'.repeat(100000) });
    f.store.append('past', 'block_delta', {
      blockType: 'thinking',
      delta: 'PRIVATE'.repeat(100000),
    });
    for (let i = 0; i < 30; i++) f.delta('x'.repeat(10000));
    const boundary = f.access.readBoundary('past');
    const page = f.store.getHistoryEventPage('past', 0, boundary, 8192);
    expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(150000);
    expect(JSON.stringify(page)).not.toContain('PRIVATE');
    expect(page.events[0].payload).not.toHaveProperty('content');
    expect(page.events[1].payload.delta).toBeNull();
  });

  it('reports a single oversized event instead of silently treating its clipped prefix as complete', async () => {
    const f = fixture();
    const seq = f.user('x'.repeat(50000) + 'release decision');
    const result = await f.read({ query: 'release decision' });
    expect(result.blockedEvent).toEqual({ seq, reason: 'event_exceeds_output_bound' });
    expect(result.nextAfterSeq).toBeNull();
    const search = await f.search();
    expect(search.searchCoverage.blockedSessions).toBe(1);
    f.project.mockImplementation((text) => text.replace(/x+/g, ''));
    const redacted = await f.read();
    expect(redacted.blockedEvent).toEqual({ seq, reason: 'event_exceeds_output_bound' });
    expect(redacted.entries).toEqual([]);
  });

  it('seeks query overlap by conversation, message and sequence instead of scanning earlier chat events', () => {
    const f = fixture();
    f.delta('release ');
    for (let i = 0; i < 2000; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    const seq = f.delta('decision');
    const db = (f.store as unknown as { db: Database.Database }).db;
    const prepare = db.prepare.bind(db);
    const queries: string[] = [];
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      queries.push(sql);
      return prepare(sql);
    });
    expect(f.store.getHistoryMessagePrefix('past', 'answer', seq, 16)[0].payload.delta).toBe(
      'release ',
    );
    const plan = prepare('EXPLAIN QUERY PLAN ' + queries[0]).all(
      { textStart: -512, textLength: 512 },
      'past',
      'answer',
      seq,
      16,
    ) as { detail: string }[];
    expect(plan.map((row) => row.detail).join('\n')).toMatch(
      /SEARCH events USING INDEX .*\(session_id=\?(?: AND type=\?)? AND <expr>=\? AND (?:seq|rowid)<\?\)/,
    );
    expect(plan.map((row) => row.detail).join('\n')).not.toContain('TEMP B-TREE');
  });

  it('preserves embedded NUL, Unicode and JSON escapes in projected messages', async () => {
    const f = fixture();
    const text = [
      'before',
      String.fromCharCode(0),
      'after',
      '🌈',
      String.fromCharCode(92),
      '"',
    ].join('');
    f.user(text);
    expect((await f.read()).entries[0].text).toBe(text);
    expect((await f.read({ query: 'after' })).entries[0].text).toBe(text);
  });

  it('resumes bounded transcript search inside a conversation without skipping its later match', async () => {
    const f = fixture();
    for (let i = 0; i < 9000; i++) f.store.append('past', 'tool_result', { content: 'excluded' });
    f.delta('release decision');
    const first = await f.search();
    expect(first.sessions).toEqual([]);
    expect(first.nextCursor).toMatchObject({
      conversationId: 'past',
      afterSeq: expect.any(Number),
      throughSeq: expect.any(Number),
    });
    const next = await f.search({ cursor: first.nextCursor });
    expect(next.sessions[0].snippet).toBe('release decision');
    expect(next.nextCursor).toBeNull();
    expect(next.nextOffset).toBeNull();
  });
});
