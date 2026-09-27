// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SymposiumSavedReviewRecordPage } from '../SymposiumSavedReviewRecordPage';
import { SymposiumSavedReviewRecord } from '../SymposiumSavedReviewRecord';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const reference = { id: `review-${'a'.repeat(64)}`, hash: 'a'.repeat(64) };
const url = `/api/sessions/session/symposium/reviews/records/${reference.id}`;
it('loads the scoped immutable record through configured API base and bearer authentication', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://mitzo.example');
  localStorage.setItem('mitzo_auth_token', 'test-token');
  const record = {
    recordId: reference.id,
    contentHash: reference.hash,
    snapshot: { historySequence: 7 },
  };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => record });
  vi.stubGlobal('fetch', fetch);
  render(<SymposiumSavedReviewRecord url={url} reference={reference} />);
  expect(
    ((await screen.findByLabelText('Saved immutable review record')) as HTMLTextAreaElement).value,
  ).toBe(JSON.stringify(record, null, 2));
  expect(fetch.mock.calls[0][0]).toBe(`https://mitzo.example${url}`);
  const init = fetch.mock.calls[0][1];
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  expect(init.credentials).toBe('include');
  expect(screen.queryByRole('link')).toBeNull();
});
it.each(['denied', 'mismatched'])(
  'does not display a %s record as the selected immutable record',
  async (kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: kind !== 'denied',
        status: kind === 'denied' ? 403 : 200,
        json: async () => ({ recordId: reference.id, contentHash: 'b'.repeat(64), snapshot: {} }),
      }),
    );
    render(<SymposiumSavedReviewRecord url={url} reference={reference} />);
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Saved immutable review record')).toBeNull();
  },
);

it('reopens a copied app route after remount using authenticated configured API access', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://mitzo.example');
  localStorage.setItem('mitzo_auth_token', 'test-token');
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      recordId: reference.id,
      contentHash: reference.hash,
      snapshot: { historySequence: 7 },
    }),
  });
  vi.stubGlobal('fetch', fetch);
  const route = `/sessions/session/review-records/${reference.id}?hash=${reference.hash}`;
  const mount = () =>
    render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route
            path="/sessions/:sessionId/review-records/:recordId"
            element={<SymposiumSavedReviewRecordPage />}
          />
        </Routes>
      </MemoryRouter>,
    );
  const first = mount();
  await screen.findByLabelText('Saved immutable review record');
  first.unmount();
  mount();
  await screen.findByLabelText('Saved immutable review record');
  const recordReads = fetch.mock.calls.filter(([path]) => path === `https://mitzo.example${url}`);
  expect(recordReads).toHaveLength(2);
  expect(new Headers(recordReads[1][1].headers).get('Authorization')).toBe('Bearer test-token');
});
