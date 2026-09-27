import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import type { ReactNode } from 'react';
const render = (node: ReactNode) =>
  baseRender(<MitzoStoreProvider value={createTestStore()}>{node}</MitzoStoreProvider>);
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render as baseRender, screen } from '@testing-library/react';
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

it('opens the bookmarked session explicitly and answers its normal approval without a model send', async () => {
  const { createMitzoStore } = await import('@mitzo/client');
  let socket!: import('@mitzo/client').WebSocketLike;
  const sent: Record<string, unknown>[] = [];
  const store = createMitzoStore({
    transport: { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) },
    wsConfig: {
      buildUrl: () => 'ws://localhost/ws',
      createWebSocket: () => {
        socket = {
          readyState: 1,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: (value) => sent.push(JSON.parse(String(value))),
          close: vi.fn(),
        };
        return socket;
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (path) => ({
      ok: true,
      json: async () =>
        String(path).endsWith('/publication')
          ? { available: true, credentials: [] }
          : { recordId: reference.id, contentHash: reference.hash, snapshot: {} },
    })),
  );
  const { fireEvent } = await import('@testing-library/react');
  baseRender(
    <MitzoStoreProvider value={store}>
      <MemoryRouter
        initialEntries={[`/sessions/session/review-records/${reference.id}?hash=${reference.hash}`]}
      >
        <Routes>
          <Route
            path="/sessions/:sessionId/review-records/:recordId"
            element={<SymposiumSavedReviewRecordPage />}
          />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open session for approval' }));
  await screen.findByText('Connect this tab before opening the approval session.');
  expect(sent.some((value) => value.type === 'switch_session')).toBe(false);
  socket.onopen?.({});
  socket.onmessage?.({
    data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'bookmark-tab' }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open session for approval' }));
  await screen.findByLabelText('Publish reviewed artifact');
  expect(sent.filter((value) => value.type === 'switch_session')).toEqual([
    { type: 'switch_session', sessionId: 'session' },
  ]);
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'permission_request',
      sessionId: 'session',
      permId: 'publish',
      toolName: 'ExecuteProviderCapability',
      toolInput: '{}',
      title: 'Approve bookmarked publication',
      approvalScope: 'conversation',
    }),
  });
  await screen.findByText('Approve bookmarked publication');
  fireEvent.click(screen.getByRole('button', { name: 'Grant to conversation' }));
  expect(
    sent.some(
      (value) =>
        value.type === 'permission_response' &&
        value.permId === 'publish' &&
        value.decision === 'once',
    ),
  ).toBe(true);
  expect(sent.some((value) => ['send', 'interrupt'].includes(String(value.type)))).toBe(false);
  expect(screen.getByRole('heading', { name: 'Saved review record' })).toBeTruthy();
  store.getState().invalidateAuthentication();
});
