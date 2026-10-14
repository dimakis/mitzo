// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  OrdinaryCollaborationEntry,
  OrdinaryCollaborationHost,
} from '../OrdinaryCollaborationEntry';
const reads = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useOutputContributors', () => ({
  useOutputContributors: (id: string | null, enabled: boolean) => {
    reads(id, enabled);
    return enabled
      ? { sessionId: id, candidates: [{ content: 'Exact draft' }], outputs: [], loading: false }
      : null;
  },
}));
vi.mock('../OutputContributorPanel', () => ({
  OutputContributorPanel: ({ sessionId }: { sessionId: string }) => (
    <section aria-label="Selected work">{sessionId}</section>
  ),
}));
vi.mock('../HomeDialog', () => ({
  HomeDialog: ({
    title,
    onClose,
    children,
  }: {
    title: string;
    onClose(): void;
    children: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={title}>
      <button onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  reads.mockClear();
});
it('reads work only after an explicit action and stops reads when dismissed', () => {
  render(<OrdinaryCollaborationEntry sessionId="source" />);
  expect(reads).not.toHaveBeenCalledWith('source', true);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Collaborate' }));
  expect(screen.getByRole('dialog', { name: 'Collaborate on selected work' })).toBeTruthy();
  expect(reads).toHaveBeenLastCalledWith('source', true);
  expect(screen.getByRole('region', { name: 'Selected work' }).textContent).toBe('source');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(reads).toHaveBeenLastCalledWith('source', false);
});
it('preserves the requested work view across responsive children and closes on a conversation change', () => {
  const view = render(
    <OrdinaryCollaborationHost sessionId="source">
      <OrdinaryCollaborationEntry sessionId="source" />
    </OrdinaryCollaborationHost>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Collaborate' }));
  view.rerender(
    <OrdinaryCollaborationHost sessionId="source">
      <main>
        <OrdinaryCollaborationEntry sessionId="source" />
      </main>
    </OrdinaryCollaborationHost>,
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
  view.rerender(
    <OrdinaryCollaborationHost sessionId="other">
      <OrdinaryCollaborationEntry sessionId="other" />
    </OrdinaryCollaborationHost>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(reads).toHaveBeenLastCalledWith('other', false);
  view.rerender(
    <OrdinaryCollaborationHost sessionId="source">
      <OrdinaryCollaborationEntry sessionId="source" />
    </OrdinaryCollaborationHost>,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});
