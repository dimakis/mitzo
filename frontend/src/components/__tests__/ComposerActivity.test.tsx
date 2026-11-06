// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ComposerStatusProvider,
  ComposerStatusRail,
  ComposerStatusNotice,
} from '../ComposerStatus';
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({
    connected: true,
    activities: [
      {
        sessionId: 'one',
        state: 'working',
        phase: 'reading',
        turnStartedAt: 60_000,
        lastEventAt: 100_000,
      },
    ],
  }),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('adds a live label and elapsed clock within the approved single composer row', () => {
  vi.useFakeTimers();
  vi.setSystemTime(120_000);
  function Fixture({ error = false }: { error?: boolean }) {
    return (
      <ComposerStatusProvider>
        {error && <ComposerStatusNotice message="Save failed" tone="danger" />}
        <ComposerStatusRail sessionId="one" running />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  const row = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(row).getByRole('status').textContent).toBe('Reading files');
  expect(within(row).getByText('elapsed 1m 00s')).toBeTruthy();
  view.rerender(<Fixture error />);
  expect(screen.getByRole('region', { name: 'Conversation status' })).toBe(row);
  expect(within(row).getByRole('alert').textContent).toBe('Save failed');
  expect(within(row).queryByText(/elapsed/)).toBeNull();
});
