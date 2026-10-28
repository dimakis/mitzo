import { afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { captureSessionHistoryAuthorization } from '../session-history-authorization.js';
import { sessionHistoryTools } from '../session-history-tools.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function fixture() {
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
  const context = {
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
    search: () => tools.execute('SearchPastSessions', { query: 'match' }, context.signal, call),
  };
}

it('individually authorizes visible targets and rechecks their original identity without granting unregistered history', async () => {
  const f = fixture();
  const targets = await f.access.authorizeSearchPage!(
    ['first', 'hidden', 'missing'],
    f.context.signal,
  );
  expect(targets[0]).toBeTruthy();
  expect(targets.slice(1)).toEqual([null, null]);
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
