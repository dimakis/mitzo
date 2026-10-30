// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useExplicitLocalChat } from '../useExplicitLocalChat';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(['headers', 'body'])(
  'bounds a stalled metadata %s read and fences its late result after retry',
  async (stage) => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    let signal!: AbortSignal;
    let metadataReads = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/meta')) return Response.json(localInventoryFixture());
      metadataReads++;
      if (metadataReads > 1)
        return Response.json({ sessionId: 'chat', repositoryWorkspaceId: 'new-workspace' });
      signal = init!.signal!;
      const pending = new Promise<unknown>((resolve) => {
        resolveOld = resolve;
      });
      return stage === 'headers'
        ? (pending as Promise<Response>)
        : ({ ok: true, json: () => pending } as Response);
    });
    const { result } = renderHook(() => useExplicitLocalChat('draft', null, 'chat', true));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.metadataUnavailable).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.metadataUnavailable).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(result.current.commandAvailable).toBe(false);
    await act(async () => result.current.refresh());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.metadataUnavailable).toBe(false);
    expect(result.current.metadataPending).toBe(false);
    expect(result.current.repositoryWorkspaceId).toBe('new-workspace');
    await act(async () =>
      resolveOld(
        stage === 'headers'
          ? Response.json({ sessionId: 'chat', repositoryWorkspaceId: 'old-workspace' })
          : { sessionId: 'chat', repositoryWorkspaceId: 'old-workspace' },
      ),
    );
    expect(result.current.repositoryWorkspaceId).toBe('new-workspace');
  },
);

it('bounds stalled execution choices and allows an explicit retry without sending work', async () => {
  vi.useFakeTimers();
  let calls = 0;
  vi.mocked(apiFetch).mockImplementation(async () => {
    if (++calls === 1) return new Promise<Response>(() => {});
    return Response.json(localInventoryFixture());
  });
  const { result } = renderHook(() => useExplicitLocalChat('draft', null, null, true));
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(result.current.error).toContain('unavailable');
  await act(async () => result.current.refresh());
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(result.current.inventory).not.toBeNull();
  expect(calls).toBe(2);
});
