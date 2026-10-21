// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import { TelosWorkLifecycleViewSchema, type TelosWorkLifecycleView } from '@mitzo/protocol';
import { useTelosLifecycle } from '../useTelosLifecycle';
const events = vi.hoisted(() => new Set<() => void>());
const auth = vi.hoisted(() => ({ id: 'fixture-operator', base: '' }));
vi.mock('../../lib/api-fetch', async (load) => ({
  ...(await load<typeof import('../../lib/api-fetch')>()),
  currentVerifiedAuthSessionId: () => auth.id || undefined,
  getApiBaseUrl: () => auth.base,
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (_name: string, callback: () => void) => {
      events.add(callback);
      return () => events.delete(callback);
    },
    onConnectionChange: () => () => {},
  },
}));
const initial = TelosWorkLifecycleViewSchema.parse({
  itemId: 'selected',
  revision: 'a'.repeat(64),
  disposition: 'active',
  effectiveDisposition: 'active',
  inheritedFrom: null,
  pause: { stage: 'running', controls: [] },
  history: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  auth.id = 'fixture-operator';
  auth.base = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
it('reads current stage without creating a pause or changing requested into applied on refresh', async () => {
  let value = initial;
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockImplementation(async () => value);
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  value = { ...initial, pause: { stage: 'requested', controls: [] } };
  act(() => events.forEach((callback) => callback()));
  await waitFor(() => expect(result.current.lifecycle?.pause.stage).toBe('requested'));
  expect(write).not.toHaveBeenCalled();
  expect(result.current.pending).toBeNull();
});
it('uses one exact current revision/request and fresh read after acknowledgement, even if the retained receipt is older', async () => {
  let value = initial;
  const held = deferred<Awaited<ReturnType<TelosWorkApiClient['executeLifecycle']>>>();
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockImplementation(async () => value);
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockReturnValue(held.promise);
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  act(() => {
    void result.current.send('pause');
    void result.current.send('pause');
  });
  expect(write).toHaveBeenCalledTimes(1);
  const command = write.mock.calls[0][0];
  expect(command).toMatchObject({
    itemId: 'selected',
    expectedRevision: initial.revision,
    operation: 'pause',
    requestId: expect.any(String),
  });
  expect(command).not.toHaveProperty('actorId');
  value = { ...initial, revision: 'b'.repeat(64), pause: { stage: 'applied', controls: [] } };
  await act(async () =>
    held.resolve({
      requestId: command.requestId,
      itemId: 'selected',
      operation: 'pause',
      lifecycle: { ...initial, pause: { stage: 'requested', controls: [] } },
    }),
  );
  await waitFor(() => expect(result.current.lifecycle?.pause.stage).toBe('applied'));
  expect(result.current.pending).toBeNull();
});
it('retains uncertain delivery across remount and explicitly retries the identical envelope without posting on mount', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockResolvedValue(initial);
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(new TypeError('connection lost'));
  const first = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(first.result.current.current).toBe(true));
  await act(async () => {
    await first.result.current.send('archive');
  });
  const original = structuredClone(write.mock.calls[0][0]);
  expect(first.result.current.pending?.status).toBe('uncertain');
  first.unmount();
  const second = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(second.result.current.current).toBe(true));
  expect(write).toHaveBeenCalledTimes(1);
  expect(second.result.current.pending?.command).toEqual(original);
  write.mockResolvedValue({
    requestId: original.requestId,
    itemId: 'selected',
    operation: 'archive',
    lifecycle: initial,
  });
  await act(async () => {
    await second.result.current.retry();
  });
  expect(write.mock.calls[1][0]).toEqual(original);
});
it('keeps a conflict refused until explicit current-state review and does not silently retry with a new revision', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockResolvedValue(initial);
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockRejectedValue(new TelosWorkApiError(409, 'conflict', 'Lifecycle changed'));
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(async () => {
    await result.current.send('trash');
  });
  expect(result.current.pending?.status).toBe('refused');
  expect(result.current.error).toContain('Lifecycle changed');
  await act(async () => {
    await result.current.send('trash');
  });
  expect(write).toHaveBeenCalledTimes(1);
  act(() => result.current.reviewRefused());
  await waitFor(() => expect(result.current.pending).toBeNull());
  expect(write).toHaveBeenCalledTimes(1);
});
it('fences an old item read after route navigation even when abort is ignored', async () => {
  const old = deferred<TelosWorkLifecycleView>();
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockImplementation((id) =>
    id === 'selected' ? old.promise : Promise.resolve({ ...initial, itemId: id }),
  );
  const { result, rerender } = renderHook(({ id }) => useTelosLifecycle(id, 0), {
    initialProps: { id: 'selected' },
  });
  rerender({ id: 'other' });
  await waitFor(() => expect(result.current.lifecycle?.itemId).toBe('other'));
  await act(async () => old.resolve(initial));
  expect(result.current.lifecycle?.itemId).toBe('other');
});
it('does not post when the current read is unavailable or the exact retry envelope cannot be retained', async () => {
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'readLifecycle')
    .mockRejectedValue(Error('offline'));
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.error).toContain('offline'));
  await act(async () => {
    await result.current.send('pause');
  });
  expect(write).not.toHaveBeenCalled();
  read.mockResolvedValue(initial);
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.current).toBe(true));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('storage denied');
  });
  await act(async () => {
    await result.current.send('pause');
  });
  expect(write).not.toHaveBeenCalled();
  expect(result.current.error).toContain('retain');
});
it('requires exact item confirmation for permanent deletion and treats an acknowledged deletion as deletion only', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockResolvedValue({
    ...initial,
    disposition: 'trashed',
    effectiveDisposition: 'trashed',
  });
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockImplementation(async (command) => ({
      requestId: command.requestId,
      itemId: command.itemId,
      operation: command.operation,
      lifecycle: null,
    }));
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(async () => {
    await result.current.send('delete_permanently');
  });
  expect(write).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.send('delete_permanently', {
      confirmation: { itemId: 'selected', phrase: 'DELETE PERMANENTLY' },
    });
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(result.current.deleted).toBe(true);
});

it('blocks a new mutation during a held refresh while retaining the last readable lifecycle', async () => {
  const held = deferred<TelosWorkLifecycleView>();
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockResolvedValue(initial);
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const { result } = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  read.mockReturnValue(held.promise);
  act(() => {
    result.current.refresh();
    void result.current.send('pause');
  });
  expect(write).not.toHaveBeenCalled();
  expect(result.current.lifecycle).toEqual(initial);
  expect(result.current.current).toBe(false);
  await act(async () => held.resolve({ ...initial, revision: 'b'.repeat(64) }));
  await waitFor(() => expect(result.current.current).toBe(true));
});

it('fences an old authentication read synchronously and requires a fresh verified identity read after login', async () => {
  const held = deferred<TelosWorkLifecycleView>();
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'readLifecycle')
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue(initial);
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const view = renderHook(() => useTelosLifecycle('selected', 0));
  act(() => {
    auth.id = '';
    window.dispatchEvent(new Event('mitzo:auth-lost'));
    void view.result.current.send('pause');
  });
  await act(async () => held.resolve(initial));
  expect(view.result.current.current).toBe(false);
  expect(view.result.current.lifecycle).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
  act(() => {
    auth.id = 'other-operator';
    window.dispatchEvent(new Event('mitzo:auth-restored'));
  });
  await waitFor(() => expect(view.result.current.current).toBe(true));
  expect(read).toHaveBeenCalledTimes(2);
  expect(write).not.toHaveBeenCalled();
});
it('retains uncertain delivery in the original verified login and server scope without replaying it under another scope', async () => {
  const held = deferred<Awaited<ReturnType<TelosWorkApiClient['executeLifecycle']>>>();
  vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle').mockResolvedValue(initial);
  const write = vi
    .spyOn(TelosWorkApiClient.prototype, 'executeLifecycle')
    .mockReturnValue(held.promise);
  const view = renderHook(() => useTelosLifecycle('selected', 0));
  await waitFor(() => expect(view.result.current.current).toBe(true));
  act(() => {
    void view.result.current.send('archive');
  });
  const original = structuredClone(write.mock.calls[0][0]);
  act(() => {
    auth.id = '';
    window.dispatchEvent(new Event('mitzo:auth-lost'));
  });
  await act(async () =>
    held.resolve({
      requestId: original.requestId,
      itemId: original.itemId,
      operation: original.operation,
      lifecycle: initial,
    }),
  );
  expect(view.result.current.notice).toBe('');
  expect(view.result.current.current).toBe(false);
  expect(sessionStorage.length).toBe(1);
  act(() => {
    auth.id = 'other-operator';
    window.dispatchEvent(new Event('mitzo:auth-restored'));
  });
  await waitFor(() => expect(view.result.current.current).toBe(true));
  expect(view.result.current.pending).toBeNull();
  await act(async () => {
    await view.result.current.retry();
  });
  expect(write).toHaveBeenCalledTimes(1);
  act(() => {
    auth.id = 'fixture-operator';
    auth.base = 'https://another-fixture.invalid';
    window.dispatchEvent(new Event('mitzo:auth-restored'));
  });
  await waitFor(() => expect(view.result.current.current).toBe(true));
  expect(view.result.current.pending).toBeNull();
  act(() => {
    auth.base = '';
    window.dispatchEvent(new Event('mitzo:auth-restored'));
  });
  await waitFor(() => expect(view.result.current.pending?.status).toBe('uncertain'));
  expect(view.result.current.pending?.command).toEqual(original);
  expect(view.result.current.busy).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
});
it('does not read or mutate lifecycle without the existing verified interactive login identity', async () => {
  auth.id = '';
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'readLifecycle');
  const write = vi.spyOn(TelosWorkApiClient.prototype, 'executeLifecycle');
  const view = renderHook(() => useTelosLifecycle('selected', 0));
  await act(async () => {
    await view.result.current.send('pause');
  });
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(view.result.current.error).toContain('Verified interactive login');
});
