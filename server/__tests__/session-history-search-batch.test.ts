import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { captureSessionHistoryAuthorization } from '../session-history-authorization.js';
import { sessionHistoryTools } from '../session-history-tools.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function fixture(readSelected = true) {
  const events = new EventStore(':memory:');
  stores.push(events);
  for (const id of ['first', 'second', 'hidden'])
    events.upsertSession({
      sessionId: id,
      conversationSource: 'mitzo',
      summary: `Public match ${id}`,
    });
  events.hideSession('hidden');
  const state = { valid: true, afterAsync: () => {}, project: (_text: string) => {} };
  const call = { callId: 'call', turnId: 'turn' };
  const session = { activeSkillPolicy: null as Set<string> | null };
  bindAgentToolSelection(
    session,
    {
      tools: [
        { id: 'mitzo:SearchPastSessions', version: 1 },
        ...(readSelected ? [{ id: 'mitzo:ReadPastSession', version: 1 }] : []),
      ],
    } as never,
    'codex-owned-local',
  );
  const context = {
    session,
    signal: new AbortController().signal,
    ...call,
    toolName: 'SearchPastSessions',
    assertCurrentSync: vi.fn(() => {
      if (!state.valid) throw Error('private revoked detail');
    }),
    assertCurrent: vi.fn(async () => {
      await Promise.resolve();
      state.afterAsync();
    }),
    dispose: vi.fn(),
  };
  const access = captureSessionHistoryAuthorization({
    context: context as unknown as NativeHostToolContext,
    events,
    call,
    toolName: 'SearchPastSessions',
  });
  const tools = sessionHistoryTools({
    store: events,
    capture: () => access,
    projectPublicText: (text) => {
      state.project(text);
      return text;
    },
  });
  return {
    events,
    state,
    context,
    access,
    search: (input: Record<string, unknown> = {}) =>
      tools.execute('SearchPastSessions', { query: 'match', ...input }, context.signal, call),
  };
}

it.each(['selection', 'skill'] as const)(
  'retains metadata-only access when transcript reads are excluded by %s',
  async (ceiling) => {
    const f = fixture(ceiling !== 'selection');
    if (ceiling === 'skill') f.context.session.activeSkillPolicy = new Set(['SearchPastSessions']);
    f.events.append('first', 'block_delta', {
      blockType: 'text',
      messageId: 'm',
      delta: 'Transcript needle',
    });
    const reads = vi.spyOn(f.events, 'getHistoryEventPage');
    const metadata = await f.search();
    expect(metadata?.isError).toBe(false);
    expect(JSON.parse(metadata!.content).sessions).toHaveLength(2);
    const defaultSearch = await f.search({ query: 'needle' });
    expect(defaultSearch?.isError).toBe(false);
    expect(JSON.parse(defaultSearch!.content).sessions).toEqual([]);
    expect(JSON.parse(defaultSearch!.content).searchCoverage.source).toBe(
      'projected-session-summaries',
    );
    expect((await f.search({ query: 'needle', scope: 'all' }))?.isError).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(() => f.access.readBoundary('first')).toThrow('transcript read capability');
  },
);

it('allows transcript search under both selected capabilities and the current skill ceiling', async () => {
  const f = fixture();
  f.context.session.activeSkillPolicy = new Set(['SearchPastSessions', 'ReadPastSession']);
  f.events.append('first', 'block_delta', {
    blockType: 'text',
    messageId: 'm',
    delta: 'Transcript needle',
  });
  const result = await f.search({ query: 'needle' });
  expect(result?.isError).toBe(false);
  expect(JSON.parse(result!.content).sessions[0].snippet).toBe('Transcript needle');
});

it.each(['projection', 'final-await'] as const)(
  'withholds transcript results when the read ceiling is revoked during %s',
  async (boundary) => {
    const f = fixture();
    f.events.append('first', 'block_delta', {
      blockType: 'text',
      messageId: 'm',
      delta: 'Transcript needle',
    });
    const revoke = () => {
      f.context.session.activeSkillPolicy = new Set(['SearchPastSessions']);
    };
    f.state.project = (text) => {
      if (!text.includes('Transcript')) return;
      if (boundary === 'projection') revoke();
      else f.state.afterAsync = revoke;
    };
    const result = await f.search({ query: 'needle' });
    expect(result?.isError).toBe(true);
    expect(result?.content).not.toContain('Transcript');
  },
);

it('individually authorizes visible targets and rechecks their original identity without granting unregistered history', async () => {
  const f = fixture();
  f.events.registerInternalSdkExecution({
    sdkSessionId: 'internal-target',
    parentSessionId: 'first',
    operationId: 'history-fixture-internal',
    purpose: 'web_search',
    cwd: '/offline-fixture',
  });
  const denied = ['hidden', 'missing', 'internal-target'];
  const targets = await f.access.authorizeSearchPage!(['first', ...denied], f.context.signal);
  expect(targets[0]).toBeTruthy();
  expect(targets.slice(1)).toEqual([null, null, null]);
  // The read and search consumers use the same real registration/visibility
  // boundary; vary these without repeating complete native owner bootstraps.
  for (const id of denied)
    await expect(f.access.authorizeRead(id, f.context.signal)).rejects.toThrow(
      'History target unavailable',
    );
  f.events.hideSession('first');
  expect(() => targets[0]!.assertCurrent()).toThrow('History target unavailable');
});

it.each(['hidden', 'replaced', 'revoked', 'cancelled'] as const)(
  'rejects the entire batch when a target or owner becomes %s across its final await',
  async (change) => {
    const f = fixture();
    const abort = new AbortController();
    let awaits = 0;
    f.state.afterAsync = () => {
      if (++awaits !== 2) return;
      if (change === 'hidden') f.events.hideSession('first');
      if (change === 'replaced') {
        const read = f.events.getSession.bind(f.events);
        vi.spyOn(f.events, 'getSession').mockImplementation((id) => {
          const row = read(id);
          return row && id === 'first' ? { ...row, createdAt: row.createdAt + 1 } : row;
        });
      }
      if (change === 'revoked') f.state.valid = false;
      if (change === 'cancelled') abort.abort();
    };
    await expect(
      f.access.authorizeSearchPage!(['first', 'second'], abort.signal),
    ).rejects.toThrow();
  },
);

it.each(['projection', 'final-await'] as const)(
  'withholds every projected result if a selected target is hidden during %s',
  async (boundary) => {
    const f = fixture();
    f.state.project = (text) => {
      const id = text.endsWith('first') ? 'first' : 'second';
      if (boundary === 'projection') f.events.hideSession(id);
      else f.state.afterAsync = () => f.events.hideSession(id);
    };
    const result = await f.search();
    expect(result?.isError).toBe(true);
    expect(result!.content).not.toContain('Public match');
    expect(f.context.dispose).toHaveBeenCalledOnce();
  },
);

it('refuses oversized batches before target reads and retains owner validation for empty batches', async () => {
  const f = fixture();
  const read = vi.spyOn(f.events, 'getSession');
  await expect(
    f.access.authorizeSearchPage!(Array(101).fill('first'), f.context.signal),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  f.state.valid = false;
  await expect(f.access.authorizeSearchPage!([], f.context.signal)).rejects.toThrow();
});
