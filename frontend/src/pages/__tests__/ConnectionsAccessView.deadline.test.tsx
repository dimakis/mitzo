// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionsAccessView } from '../ConnectionsAccessView';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function overview() {
  return render(
    <MemoryRouter>
      <ConnectionsAccessView />
    </MemoryRouter>,
  );
}
it('stops a hung inventory transport after 15 seconds and recovers through retry', async () => {
  vi.mocked(apiFetch)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ generatedAt: 1, sources: [], resources: [] })),
    );
  overview();
  const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14_999);
  });
  expect(screen.getByText('Loading connections & access…')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain(
    'Connections & access could not be loaded.',
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  });
  expect(screen.getByText('No AI accounts were reported by available sources.')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it('cancels a departed overview and does not carry a false load error into re-entry', async () => {
  vi.mocked(apiFetch)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ generatedAt: 1, sources: [], resources: [] })),
    );
  const first = overview();
  const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal;
  first.unmount();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    overview();
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('No AI accounts were reported by available sources.')).toBeTruthy();
});
