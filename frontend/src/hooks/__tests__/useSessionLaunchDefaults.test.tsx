// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionLaunchDefaults } from '../useSessionLaunchDefaults';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('retains the saved revision on conflict and exposes an explicit refresh', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ revision: 3, configuration: null }));
  const { result } = renderHook(() => useSessionLaunchDefaults());
  await waitFor(() => expect(result.current.revision).toBe(3));
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ error: 'Defaults changed. Refresh.' }, { status: 409 }),
  );
  await act(async () => {
    expect(await result.current.save(null)).toBe(false);
  });
  expect(result.current.revision).toBe(3);
  expect(result.current.error).toBe('Defaults changed. Refresh.');
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ revision: 4, configuration: null }));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.revision).toBe(4));
});

it('ignores an old draft save completion after a new draft has loaded its defaults', async () => {
  let finishSave!: (value: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'PUT'
      ? new Promise<Response>((resolve) => {
          finishSave = resolve;
        })
      : Response.json({ revision: 3, configuration: null }),
  );
  const { result, rerender } = renderHook(({ scope }) => useSessionLaunchDefaults(true, scope), {
    initialProps: { scope: 'draft-A' },
  });
  await waitFor(() => expect(result.current.revision).toBe(3));
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.save(null);
  });
  rerender({ scope: 'draft-B' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    finishSave(Response.json({ revision: 4, configuration: null }));
    await saving;
  });
  expect(result.current.revision).toBe(3);
  expect(result.current.saving).toBe(false);
  expect(result.current.error).toBe('');
});
