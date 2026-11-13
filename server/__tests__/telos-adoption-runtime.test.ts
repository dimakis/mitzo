import { expect, it, vi } from 'vitest';
import { createTelosAdoptionRuntime } from '../telos-adoption-runtime.js';
import { getCodexRuntime, retireIdleCodexChat } from '../codex-chat-session.js';
import { drainQueryLoopFinalization } from '../query-loop.js';
vi.mock('../codex-chat-session.js', () => ({
  getCodexRuntime: vi.fn(() => ({ peerMessageState: () => 'idle' })),
  retireIdleCodexChat: vi.fn(),
}));
vi.mock('../query-loop.js', () => ({ drainQueryLoopFinalization: vi.fn() }));

function fixture() {
  const owner = { clientId: 'client', session: {} };
  let live: typeof owner | null = owner;
  const deps = {
    events: {
      assertOrdinaryContextQuiescent: vi.fn(),
      getSession: () => ({ cwd: '/retained', accountBinding: {} }),
      getOrdinaryInitialCommandId: () => 'original-command',
      hasProviderDispatchForConversation: () => true,
    },
    native: () => ({ hasConversation: () => true, assertContextTransitionQuiescent: vi.fn() }),
    registry: { findBySessionId: () => live, isClosingOut: () => false, isUserClose: () => false },
  };
  return {
    owner,
    deps,
    replace: () => {
      live = { clientId: 'new-client', session: {} };
      return live;
    },
    remove: () => {
      live = null;
    },
    runtime: createTelosAdoptionRuntime(deps as never),
  };
}
it('refuses cold executed owners before acquisition, without treating absence as cleanup', () => {
  const f = fixture();
  f.remove();
  expect(() => f.runtime.assertRetirable!('chat', 'operation')).toThrow(/unconfirmed/);
  expect(retireIdleCodexChat).not.toHaveBeenCalled();
});
it.each([false, true])(
  'recovers the exact removed owner and retained cleanup failure (%s)',
  async (failure) => {
    vi.clearAllMocks();
    const f = fixture();
    const controller = new AbortController();
    const original = Error('private drain failure');
    vi.mocked(retireIdleCodexChat).mockImplementation(async (_session, current) => {
      f.remove();
      if (failure) throw original;
      controller.abort();
      current();
    });
    await expect(
      f.runtime.retire('chat', () => {}, controller.signal, 'operation'),
    ).rejects.toThrow();
    f.runtime.assertRetirable!('chat', 'operation');
    if (!failure) vi.mocked(retireIdleCodexChat).mockResolvedValue(undefined);
    const retry = f.runtime.retire('chat', () => {}, new AbortController().signal, 'operation');
    if (failure) await expect(retry).rejects.toBe(original);
    else {
      await retry;
      expect(drainQueryLoopFinalization).toHaveBeenCalledWith(f.owner.session);
    }
    expect(retireIdleCodexChat).toHaveBeenLastCalledWith(f.owner.session, expect.any(Function));
    const restarted = createTelosAdoptionRuntime(f.deps as never);
    expect(() => restarted.assertRetirable!('chat', 'operation')).toThrow(/unconfirmed/);
  },
);
it('refuses a busy exact owner without interrupting or retiring it', () => {
  vi.clearAllMocks();
  const f = fixture();
  vi.mocked(getCodexRuntime).mockReturnValueOnce({ peerMessageState: () => 'busy' } as never);
  expect(() => f.runtime.assertQuiescent('chat', 'operation')).toThrow(/busy/);
  expect(retireIdleCodexChat).not.toHaveBeenCalled();
});
it('retains original operation evidence without trapping a later reviewed adoption', async () => {
  vi.clearAllMocks();
  const f = fixture();
  vi.mocked(retireIdleCodexChat).mockImplementation(async () => {
    f.remove();
  });
  await f.runtime.retire('chat', () => {}, new AbortController().signal, 'first');
  const next = f.replace();
  expect(() => f.runtime.assertRetirable!('chat', 'first')).toThrow(/owner changed/);
  f.runtime.assertRetirable!('chat', 'second');
  await f.runtime.retire('chat', () => {}, new AbortController().signal, 'second');
  expect(retireIdleCodexChat).toHaveBeenLastCalledWith(next.session, expect.any(Function));
});
