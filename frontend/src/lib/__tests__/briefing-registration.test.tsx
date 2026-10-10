// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { usePendingLaunch } from '../../hooks/usePendingLaunch';
import { useBriefingChat } from '../../hooks/useBriefingChat';
import {
  registerBriefing,
  confirmBriefingRegistration,
  useBriefingRegistration,
} from '../briefing-registration';
import { apiFetch } from '../api-fetch';
const config = vi.hoisted(() => ({ backend: '', sequence: 0 }));
vi.mock('../api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => config.backend,
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: null }),
}));
beforeEach(() => {
  config.backend = `https://backend-${++config.sequence}.example/workspace`;
  vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 503 }));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const binding = {
  sessionId: 'a',
  date: '2026-10-09',
  revision: 'a'.repeat(64),
  accountId: 'work',
  model: 'luna',
};
const ack = { ...binding, createdAt: '2026-10-09T07:00:00Z' };

it('persists independent per-session receipts so another tab cannot overwrite an unresolved identity', async () => {
  await registerBriefing(binding);
  await registerBriefing({ ...binding, sessionId: 'b' });
  const keys = Object.keys(localStorage).filter((key) =>
    key.startsWith('mitzo-briefing-registrations:'),
  );
  expect(keys).toHaveLength(2);
  const aKey = keys.find(
    (key) => JSON.parse(localStorage.getItem(key)!).binding.sessionId === 'a',
  )!;
  const bKey = keys.find(
    (key) => JSON.parse(localStorage.getItem(key)!).binding.sessionId === 'b',
  )!;
  const retainedB = localStorage.getItem(bKey);
  // A's acknowledgement modifies only A's durable key, preserving B's concurrent retry.
  confirmBriefingRegistration(ack);
  expect(localStorage.getItem(aKey)).toBeNull();
  expect(localStorage.getItem(bKey)).toBe(retainedB);
  const { result } = renderHook(() => useBriefingRegistration('b'));
  expect(result.current.record?.binding.sessionId).toBe('b');
  expect(result.current.error).toBeTruthy();
});

it.each(['empty', 'changed'] as const)(
  'does not discard a receipt on %s registration acknowledgement',
  async (kind) => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify(kind === 'empty' ? {} : { ...ack, model: 'other' }), {
        status: 201,
      }),
    );
    await registerBriefing(binding);
    const { result } = renderHook(() => useBriefingRegistration('a'));
    expect(result.current.record?.binding).toEqual(binding);
    expect(result.current.error).toBeTruthy();
  },
);

it('isolates native backend targets even when browser storage origin is shared', async () => {
  await registerBriefing(binding);
  const previous = config.backend;
  config.backend = 'https://another-backend.example/workspace';
  const second = renderHook(() => useBriefingRegistration('a'));
  expect(second.result.current.record).toBeNull();
  second.unmount();
  config.backend = previous;
  const first = renderHook(() => useBriefingRegistration('a'));
  expect(first.result.current.record?.binding).toEqual(binding);
});

it('retains guarded identity and visible retry through storage write failure and malformed retained storage', async () => {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage full');
  });
  await registerBriefing(binding);
  const store = createTestStore();
  store.setState({ sessions: { ...store.getState().sessions, active: 'a' } });
  const { result } = renderHook(
    () => ({ registration: useBriefingRegistration('a'), chat: useBriefingChat('a') }),
    {
      wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
    },
  );
  await waitFor(() => expect(result.current.chat.loading).toBe(false));
  expect(result.current.chat.selectionLocked).toBe(true);
  expect(result.current.chat.source).toMatchObject(binding);
  expect(result.current.registration.error).toContain('reload');
  write.mockRestore();
  await act(async () => result.current.registration.retry());
  const key = Object.keys(localStorage).find((key) =>
    key.startsWith('mitzo-briefing-registrations:'),
  )!;
  localStorage.setItem(key, '{corrupt');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key })));
  expect(result.current.chat.selectionLocked).toBe(true);
  expect(result.current.chat.source).toMatchObject(binding);
  expect(result.current.registration.error).toBeTruthy();
});

it('refuses another minion launch at retry capacity without evicting existing identities or dispatching a turn', async () => {
  for (let i = 0; i < 256; i++) await registerBriefing({ ...binding, sessionId: `pending-${i}` });
  const store = createTestStore();
  const send = vi.fn();
  store.setState({
    pendingSession: {
      prompt: 'Explain',
      context: 'Briefing',
      briefing: binding,
      accountSelection: { accountId: 'work', model: 'luna' },
    },
    sendMessage: send,
  });
  const { result } = renderHook(usePendingLaunch, {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  let queued: boolean | undefined;
  act(() => {
    queued = result.current.sendLaunch();
  });
  expect(queued).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(result.current.registrationError).toBeTruthy();
  expect(
    Object.keys(localStorage).filter((key) => key.startsWith('mitzo-briefing-registrations:')),
  ).toHaveLength(256);
  // A single assignment racing the capacity check retains a bounded memory receipt.
  await registerBriefing({ ...binding, sessionId: 'assigned-overflow' });
  const overflow = renderHook(() => useBriefingRegistration('assigned-overflow'));
  expect(overflow.result.current.record?.binding.sessionId).toBe('assigned-overflow');
  expect(overflow.result.current.error).toBeTruthy();
  expect(
    Object.keys(localStorage).filter((key) => key.startsWith('mitzo-briefing-registrations:')),
  ).toHaveLength(256);
  expect(() => registerBriefing({ ...binding, sessionId: 'second-overflow' })).toThrow(/capacity/i);
});

it('ignores a late registration acknowledgement after authentication loss', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = registerBriefing(binding);
  await Promise.resolve();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  finish(new Response(JSON.stringify(ack), { status: 201 }));
  await pending;
  const { result } = renderHook(() => useBriefingRegistration('a'));
  expect(result.current.record?.binding).toEqual(binding);
  expect(result.current.error).toBeTruthy();
});

it('retains assignment identity on supported remote HTTP without crypto.randomUUID', async () => {
  const randomValues = vi.fn((bytes: Uint8Array) => bytes.fill(7));
  vi.stubGlobal('crypto', { getRandomValues: randomValues });
  await registerBriefing(binding);
  const { result } = renderHook(() => useBriefingRegistration('a'));
  expect(randomValues).toHaveBeenCalledOnce();
  expect(result.current.record?.token).toBe('07'.repeat(16));
  expect(result.current.record?.binding).toEqual(binding);
  expect(result.current.error).toBeTruthy();
});
