// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { HomePins } from '../HomePins';
import { apiFetch } from '../../lib/api-fetch';
import type { Session } from '../../types/chat';
const data = vi.hoisted(() => ({ id: 'older' }));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({
    preferences: {
      pins: [
        { kind: 'session', id: data.id, title: 'Older pinned chat' },
        { kind: 'telos', id: 'work', title: 'Work pin' },
      ],
    },
  }),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  AUTH_RESTORED_EVENT: 'mitzo:auth-restored',
}));
const usage = {
  used: 48000,
  measuredAt: 1,
  limits: { model: 'fixture', source: 'runtime' as const, contextWindow: 200000, stale: false },
};
beforeEach(() => {
  localStorage.clear();
  data.id = 'older';
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue(Response.json({ sessionId: 'older', contextUsage: usage }));
});
afterEach(cleanup);
function show(sessions: Session[] = []) {
  return render(
    <MemoryRouter>
      <HomePins sessions={sessions} />
    </MemoryRouter>,
  );
}
it('loads actual context for a Today pin outside the recent-session page', async () => {
  show([{ id: 'recent', summary: 'Recent', lastModified: 2 }]);
  await waitFor(() =>
    expect(
      within(screen.getByRole('link', { name: /Older pinned chat/ }))
        .getByRole('meter')
        .getAttribute('aria-valuenow'),
    ).toBe('24'),
  );
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/sessions/older/context',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(within(screen.getByRole('link', { name: /Work pin/ })).queryByText(/Context/)).toBeNull();
});
it('reuses an observation already present in the loaded page', () => {
  show([{ id: 'older', summary: 'Older', lastModified: 1, contextUsage: usage }]);
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('24');
  expect(apiFetch).not.toHaveBeenCalled();
});
it('does not request context when the Appearance preference is disabled', () => {
  localStorage.setItem('mitzo-today-tokens', 'false');
  show();
  expect(apiFetch).not.toHaveBeenCalled();
  expect(screen.queryByText(/Context/)).toBeNull();
});
it.each(['http', 'network', 'missing', 'mismatch'])(
  'keeps unavailable context explicit after %s',
  async (failure) => {
    vi.mocked(apiFetch).mockImplementation(async () => {
      if (failure === 'network') throw Error('offline');
      return Response.json(
        failure === 'missing'
          ? { sessionId: 'older', contextUsage: null }
          : { sessionId: 'another', contextUsage: usage },
        { status: failure === 'http' ? 503 : 200 },
      );
    });
    show();
    await act(async () => {});
    expect(screen.getByText('Context unavailable')).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  },
);
it('aborts obsolete pin reads and ignores their late responses', async () => {
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(apiFetch)
    .mockImplementationOnce((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValue(
      Response.json({ sessionId: 'newer', contextUsage: { ...usage, used: 100000 } }),
    );
  const view = show();
  data.id = 'newer';
  view.rerender(
    <MemoryRouter>
      <HomePins sessions={[]} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('50'));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ sessionId: 'older', contextUsage: usage })));
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('50');
});
