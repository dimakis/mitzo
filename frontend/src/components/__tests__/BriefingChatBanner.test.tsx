// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BriefingChatBanner } from '../BriefingChatBanner';
const state = vi.hoisted(() => ({
  pending: vi.fn(),
  source: 'Saved morning briefing: 2026-10-09\nRevision: original\nAll original content',
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (s: unknown) => unknown) =>
    select({
      setPendingSession: state.pending,
      pendingSession: null,
      messages: { messages: [{ contextBlocks: [state.source] }] },
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
      <BriefingChatBanner name="Jeeves" source={{ date: '2026-10-09', revision: 'original' }} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change account or model' }));
  fireEvent.click(screen.getByRole('button', { name: 'Use other account' }));
  await waitFor(() => expect(state.pending).toHaveBeenCalled());
  expect(state.pending.mock.calls[0][0].contextBlocks).toEqual([state.source]);
  expect(state.pending.mock.calls[0][0].accountSelection.accountId).toBe('other');
});
