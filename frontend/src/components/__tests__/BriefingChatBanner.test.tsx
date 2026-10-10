// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BriefingChatBanner } from '../BriefingChatBanner';
const state = vi.hoisted(() => ({
  pending: vi.fn(),
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
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(async () => new Response('[]')) }));
vi.mock('../BriefingMinionPicker', () => ({
  BriefingMinionPicker: ({ onUse }: { onUse: (s: unknown) => Promise<void> }) => (
    <button onClick={() => void onUse({ accountId: 'other', model: 'other-model' })}>
      Use other account
    </button>
  ),
}));
afterEach(() => {
  cleanup();
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
