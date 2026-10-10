// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InboxSection } from '../InboxSection';
vi.mock('../NotificationProvider', () => ({
  useNotifications: () => ({ loading: false, feed: { needsYou: 2 }, refresh: vi.fn() }),
}));
const legacy = vi.hoisted(() => ({
  inbox: { items: [] },
  loadInbox: async () => {},
  setPendingSession: vi.fn(),
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (s: object) => unknown) => select(legacy),
}));
afterEach(cleanup);
it('Today links to actionable Inbox requests rather than a raw proposal backlog', () => {
  render(
    <MemoryRouter>
      <InboxSection />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: /2 requests need you/ })).toHaveAttribute(
    'href',
    '/inbox',
  );
  expect(screen.queryByText('No pending proposals')).not.toBeInTheDocument();
});
