// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-fetch';
import { briefingCommandHandoff, registerBriefing } from '../../lib/briefing-registration';
import { BriefingChatBanner } from '../BriefingChatBanner';
const state = vi.hoisted(() => ({
  pending: vi.fn(),
  selection: { accountId: 'other', model: 'other-model' },
  source: {
    kind: 'briefing',
    date: '2026-10-09',
    revision: 'a'.repeat(64),
    content: 'All original content',
  },
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (s: unknown) => unknown) =>
    select({
      setPendingSession: state.pending,
      pendingSession: null,
      messages: { messages: [{ sourceSnapshots: [state.source] }] },
    }),
}));
vi.mock('../../lib/api-fetch', () => ({
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
  apiFetch: vi.fn(),
}));
vi.mock('../BriefingMinionPicker', () => ({
  BriefingMinionPicker: function Picker({ onUse }: { onUse: (s: unknown) => Promise<void> }) {
    const [error, setError] = useState('');
    return (
      <>
        <button
          onClick={() => void onUse(state.selection).catch((cause) => setError(cause.message))}
        >
          Use other account
        </button>
        {error && <p role="alert">{error}</p>}
      </>
    );
  },
}));
function Location() {
  return <p data-testid="location">{useLocation().pathname}</p>;
}
function show(source: { date: string; revision: string } = state.source) {
  render(
    <MemoryRouter initialEntries={['/chat/current']}>
      <BriefingChatBanner name="Jeeves" source={source} />
      <Location />
    </MemoryRouter>,
  );
}
async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Change account or model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use other account' }));
}
beforeEach(() => {
  state.selection = { accountId: 'other', model: 'other-model' };
  vi.mocked(apiFetch).mockImplementation(
    async (url, init) =>
      new Response(JSON.stringify(String(url).includes('/meta') ? { isHidden: false } : []), {
        status: init?.method === 'POST' ? 503 : 200,
      }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});
it('changes account in a popup while carrying the original captured context into a separate chat', async () => {
  render(
    <MemoryRouter>
      <BriefingChatBanner
        name="Jeeves"
        source={{ date: state.source.date, revision: state.source.revision }}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change account or model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use other account' }));
  await waitFor(() => expect(state.pending).toHaveBeenCalled());
  expect(state.pending.mock.calls[0][0].sourceSnapshots).toEqual([state.source]);
  expect(state.pending.mock.calls[0][0].contextBlocks).toBeUndefined();
  expect(state.pending.mock.calls[0][0].accountSelection.accountId).toBe('other');
});

it('retains a known source with retry and blocks changing account while identity cannot be confirmed', () => {
  const retry = vi.fn();
  const { rerender } = render(
    <MemoryRouter>
      <BriefingChatBanner
        name="Jeeves"
        source={state.source}
        lookupError="Briefing link unavailable"
        retryLookup={retry}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Read briefing' })).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Change account or model' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry briefing lookup' }));
  expect(retry).toHaveBeenCalledOnce();
  rerender(
    <MemoryRouter>
      <BriefingChatBanner
        name="Jeeves"
        source={state.source}
        lookupError="Briefing link unavailable"
        retryLookup={retry}
        lookupLoading
      />
    </MemoryRouter>,
  );
  expect(
    (screen.getByRole('button', { name: 'Retry briefing lookup' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('projects a saved binding onto source identity before staging and registering the changed account', async () => {
  const saved = {
    ...state.source,
    sessionId: 'saved',
    accountId: 'old',
    model: 'old-model',
    createdAt: '2026-10-09T07:00:00Z',
  };
  show(saved);
  await choose();
  await waitFor(() => expect(state.pending).toHaveBeenCalledOnce());
  const launch = state.pending.mock.calls[0][0];
  expect(launch.briefing).toEqual({ date: state.source.date, revision: state.source.revision });
  await registerBriefing({
    ...launch.briefing,
    sessionId: 'changed',
    accountId: launch.accountSelection.accountId,
    model: launch.accountSelection.model,
  });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/home/briefing-chats',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        date: state.source.date,
        revision: state.source.revision,
        sessionId: 'changed',
        accountId: 'other',
        model: 'other-model',
      }),
    }),
  );
});
it.each(['same', 'other'] as const)(
  'reuses an assigned %s selection even when its server registration failed',
  async (selection) => {
    state.selection =
      selection === 'same'
        ? { accountId: 'work', model: 'luna' }
        : { accountId: 'other', model: 'other-model' };
    await registerBriefing({
      sessionId: 'retained',
      date: state.source.date,
      revision: state.source.revision,
      ...state.selection,
    });
    show();
    await choose();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/chat/retained'));
    expect(state.pending).not.toHaveBeenCalled();
  },
);
it('blocks staging another launch while the matching command awaits assignment', async () => {
  expect(
    briefingCommandHandoff.prepare({
      sessionId: null,
      clientMsgId: 'awaiting',
      accountId: 'other',
      model: 'other-model',
      sourceSnapshots: [state.source],
    }),
  ).toBe(true);
  show();
  await choose();
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('awaiting assignment'),
  );
  expect(state.pending).not.toHaveBeenCalled();
  expect(screen.getByTestId('location').textContent).toBe('/chat/current');
});
it.each(['hidden', 'unavailable', 'missing', 'malformed'] as const)(
  'checks authoritative %s visibility before replacing a failed local registration',
  async (visibility) => {
    await registerBriefing({
      sessionId: 'retained',
      date: state.source.date,
      revision: state.source.revision,
      ...state.selection,
    });
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/meta')) {
        if (visibility === 'unavailable' || visibility === 'missing')
          return new Response('', { status: visibility === 'missing' ? 404 : 503 });
        return new Response(JSON.stringify(visibility === 'malformed' ? {} : { isHidden: true }));
      }
      return new Response('[]');
    });
    show();
    await choose();
    if (visibility === 'hidden') {
      await waitFor(() => expect(state.pending).toHaveBeenCalledOnce());
      expect(Object.entries(localStorage).some(([key]) => key.endsWith(':retained'))).toBe(false);
      expect(screen.getByTestId('location').textContent).toBe('/chat');
    } else {
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(
          'Could not confirm this conversation',
        ),
      );
      expect(state.pending).not.toHaveBeenCalled();
      expect(Object.entries(localStorage).some(([key]) => key.endsWith(':retained'))).toBe(true);
    }
  },
);
