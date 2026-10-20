// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import { useTelosWorkControls } from '../useTelosWorkControls';
const receipt = {
  version: 1 as const,
  controlId: 'control',
  coordinatorItemId: 'coordinator',
  coordinatorConversationId: 'lead',
  priorityItemId: 'priority',
  scope: 'new_worker_dispatch' as const,
  stage: 'requested' as const,
  publicationRevalidation: 'not_applicable' as const,
  targets: [],
  history: [],
};
const request = {
  operation: 'request' as const,
  coordinatorItemId: 'coordinator',
  priorityItemId: 'priority',
  targetItemIds: ['other'],
  scope: 'new_worker_dispatch' as const,
};
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('discovers durable inbox controls on mount and Check acknowledgements only reads actual current stages', async () => {
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockResolvedValueOnce([receipt])
    .mockResolvedValueOnce({ ...receipt, stage: 'applied' });
  const { result } = renderHook(() => useTelosWorkControls('coordinator', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(() => result.current.read('control'));
  expect(result.current.controls[0].stage).toBe('applied');
  expect(control.mock.calls.map(([c]) => c.operation)).toEqual(['inbox', 'read']);
});
it('does not advance a request or refusal into a recipient acknowledgement or host application', async () => {
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(
      new TelosWorkApiError(403, 'unauthorized', 'Current coordinator authority required'),
    );
  const { result } = renderHook(() => useTelosWorkControls('coordinator', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(() => result.current.send(request));
  expect(result.current.error).toContain('Current coordinator authority required');
  expect(result.current.controls).toEqual([]);
  expect(result.current.pending?.status).toBe('refused');
  expect(control.mock.calls.map(([c]) => c.operation)).toEqual(['inbox', 'request']);
});
it('retains the original uncertain mutation through reload and only retries its exact original request id and body on explicit action', async () => {
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce([receipt]);
  const first = renderHook(() => useTelosWorkControls('coordinator', 0));
  await waitFor(() => expect(first.result.current.current).toBe(true));
  await act(() => first.result.current.send(request));
  const original = structuredClone(control.mock.calls[1][0]);
  expect(first.result.current.pending?.status).toBe('uncertain');
  expect(control).toHaveBeenCalledTimes(2);
  first.unmount();
  const second = renderHook(() => useTelosWorkControls('coordinator', 0));
  await waitFor(() => expect(second.result.current.current).toBe(true));
  expect(second.result.current.pending?.command).toEqual(original);
  expect(control).toHaveBeenCalledTimes(3);
  await act(() => second.result.current.retry());
  await waitFor(() => expect(second.result.current.pending).toBeNull());
  expect(control.mock.calls[3][0]).toEqual(original);
  expect(second.result.current.controls[0].stage).toBe('requested');
});
it('does not send a mutation if its retry identity cannot be retained', async () => {
  const control = vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValueOnce([]);
  const { result } = renderHook(() => useTelosWorkControls('coordinator', 0));
  await waitFor(() => expect(result.current.current).toBe(true));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Storage denied');
  });
  await act(() => result.current.send(request));
  expect(result.current.error).toContain('No control request was sent');
  expect(control).toHaveBeenCalledOnce();
});
it('does not let an old item inbox overwrite the new item even if the old transport ignores abort', async () => {
  let release!: (v: (typeof receipt)[]) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'control').mockImplementation(async (command) =>
    command.operation === 'inbox' && command.itemId === 'coordinator'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : [],
  );
  const { result, rerender } = renderHook(({ id }) => useTelosWorkControls(id, 0), {
    initialProps: { id: 'coordinator' },
  });
  rerender({ id: 'elsewhere' });
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(() => release([receipt]));
  expect(result.current.controls).toEqual([]);
});
it('clears active-operation UI ownership on item change and ignores the old mutation response while retaining its retry envelope', async () => {
  let release!: (value: typeof receipt) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'control').mockImplementation(async (command) =>
    command.operation === 'request'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : [],
  );
  const { result, rerender } = renderHook(({ id }) => useTelosWorkControls(id, 0), {
    initialProps: { id: 'coordinator' },
  });
  await waitFor(() => expect(result.current.current).toBe(true));
  await act(async () => {
    void result.current.send(request);
  });
  expect(result.current.busy).toBe(true);
  rerender({ id: 'elsewhere' });
  await waitFor(() => expect(result.current.current).toBe(true));
  expect(result.current.busy).toBe(false);
  await act(async () => release(receipt));
  expect(result.current.controls).toEqual([]);
  expect(result.current.pending).toBeNull();
  expect(sessionStorage.getItem('telos.control.pending.coordinator')).toContain('requestId');
});
