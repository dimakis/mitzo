// @vitest-environment jsdom
// The original steering contract is an immutable approved-design check.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTurnSteering } from '../useTurnSteering';
import { apiFetch } from '../../lib/api-fetch';
import { chatStorage, CHAT_STORAGE_CHANGED } from '../../lib/large-chat-storage';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.mocked(apiFetch).mockReset();
});

it('does not restore an old correction owner after selecting another session', async () => {
  const original = JSON.stringify({
    requestId: 'old',
    targetCommandId: 'old-turn',
    text: 'Original correction',
  });
  localStorage.setItem('mitzo-turn-steering:old-chat', original);
  vi.spyOn(chatStorage, 'getItem').mockImplementationOnce(() => {
    throw Error('Storage unavailable');
  });
  const hook = renderHook(({ id }) => useTurnSteering(id, 'turn', true), {
    initialProps: { id: 'old-chat' },
  });
  const oldRetry = hook.result.current.retry!;
  hook.rerender({ id: 'new-chat' });
  await act(async () => {
    window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED));
    oldRetry();
  });
  expect(hook.result.current.error).toBe('');
  expect(hook.result.current.retry).toBeUndefined();
  expect(localStorage.getItem('mitzo-turn-steering:old-chat')).toBe(original);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('keeps malformed correction bytes blocked through read retries and new submissions', async () => {
  localStorage.setItem('mitzo-turn-steering:malformed', '{invalid');
  const hook = renderHook(() => useTurnSteering('malformed', 'turn', true));
  const delivery = vi.fn();
  await act(async () => {
    window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED));
    hook.result.current.retry!();
    hook.result.current.submit('Replacement', delivery);
  });
  expect(hook.result.current.error).toMatch(/Saved correction is unavailable/);
  expect(delivery).toHaveBeenCalledWith('failed');
  expect(localStorage.getItem('mitzo-turn-steering:malformed')).toBe('{invalid');
  expect(apiFetch).not.toHaveBeenCalled();
});

it('re-reads a previously unavailable correction after storage recovers without dispatching it', async () => {
  const original = {
    requestId: 'retained',
    targetCommandId: 'original-turn',
    text: 'Keep this correction',
  };
  localStorage.setItem('mitzo-turn-steering:storage-recovery', JSON.stringify(original));
  const read = vi.spyOn(chatStorage, 'getItem').mockImplementationOnce(() => {
    throw Error('Storage is loading');
  });
  const hook = renderHook(() => useTurnSteering('storage-recovery', 'new-turn', true));
  expect(hook.result.current.error).toMatch(/Saved correction is unavailable/);
  await act(async () => window.dispatchEvent(new Event(CHAT_STORAGE_CHANGED)));
  expect(hook.result.current.error).toMatch(/not confirmed/);
  expect(apiFetch).not.toHaveBeenCalled();
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ requestId: original.requestId, status: 'accepted' }),
  );
  await act(async () => hook.result.current.retry!());
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual(original);
  read.mockRestore();
});

it('lets an unavailable correction read be retried without treating it as permission to send', async () => {
  vi.spyOn(chatStorage, 'getItem').mockImplementationOnce(() => {
    throw Error('Storage is loading');
  });
  const hook = renderHook(() => useTurnSteering('empty-storage-recovery', 'turn', true));
  expect(hook.result.current.retry).toBeTypeOf('function');
  await act(async () => hook.result.current.retry!());
  expect(hook.result.current.error).toBe('');
  expect(apiFetch).not.toHaveBeenCalled();
});
