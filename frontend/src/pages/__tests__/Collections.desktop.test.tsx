// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InboxView } from '../InboxView';
import { CalendarView } from '../CalendarView';
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  pending: vi.fn(),
  load: vi.fn(),
  calendar: vi.fn(),
}));
const proposals = [
  {
    filename: 'one.md',
    agent: 'planner',
    title: 'First proposal',
    tags: [],
    timestamp: '',
    preview: 'Preview one',
  },
  {
    filename: 'two.md',
    agent: 'reviewer',
    title: 'Second proposal',
    tags: [],
    timestamp: '',
    preview: 'Preview two',
  },
];
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (selector: (s: object) => unknown) =>
    selector({
      inbox: { items: proposals },
      loadInbox: mocks.load,
      setPendingSession: mocks.pending,
    }),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: mocks.fetch }));
vi.mock('../../hooks/useCalendarData', () => ({ useCalendarData: mocks.calendar }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => ({
      content: url.includes('one.md') ? 'Full first proposal' : 'Full second proposal',
    }),
  }));
  mocks.calendar.mockReturnValue({
    loading: false,
    events: [
      {
        id: 'meeting',
        type: 'meeting',
        title: 'Design review',
        start: '2026-09-08T10:00:00Z',
        end: '2026-09-08T11:00:00Z',
        location: 'Studio',
        hangoutLink: 'https://meet.example.com/review',
      },
    ],
    sprints: [],
  });
});
afterEach(cleanup);
describe('desktop collections', () => {
  it.each([true, false])(
    'keeps All reachable after removing a filtered agent’s final proposal (desktop=%s)',
    async (desktop) => {
      render(
        <MemoryRouter>
          <InboxView desktop={desktop} />
        </MemoryRouter>,
      );
      await screen.findByRole('button', { name: 'First proposal' });
      fireEvent.click(screen.getByRole('button', { name: /planner/ }));
      fireEvent.click(screen.getByRole('button', { name: 'First proposal' }));
      await screen.findByText('Full first proposal');
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive' })));
      const all = await screen.findByRole('button', { name: 'All' });
      fireEvent.click(all);
      expect(await screen.findByRole('button', { name: 'Second proposal' })).toBeVisible();
      expect(all).toBeVisible();
    },
  );
  it.each(['search', 'agent filter'])(
    'clears the selected inspector when %s hides its row',
    async (filter) => {
      render(
        <MemoryRouter>
          <InboxView desktop />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
      await screen.findByText('Full first proposal');
      if (filter === 'search') {
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search proposals' }), {
          target: { value: 'Second' },
        });
      } else {
        fireEvent.click(screen.getByRole('button', { name: /reviewer/ }));
      }
      expect(screen.queryByRole('button', { name: 'First proposal' })).toBeNull();
      expect(screen.getByText('Select a proposal')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    },
  );
  it('retains disabled pending removal context even if search hides its row', async () => {
    render(
      <MemoryRouter>
        <InboxView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
    await screen.findByText('Full first proposal');
    let finish!: (response: { ok: boolean }) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search proposals' }), {
      target: { value: 'Second' },
    });
    expect(screen.getByText('Full first proposal')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    await act(async () => finish({ ok: false }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Archive failed');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByText('Select a proposal')).toBeVisible();
  });
  it('opens full proposals beside the list and reviews only the selected content', async () => {
    render(
      <MemoryRouter>
        <InboxView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
    const detail = screen.getByRole('region', { name: 'Proposal details' });
    expect(await within(detail).findByText('Full first proposal')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Second proposal' }));
    expect(await within(detail).findByText('Full second proposal')).toBeTruthy();
    expect(within(detail).queryByText('Full first proposal')).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: 'Review in session' }));
    expect(mocks.pending).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('Full second proposal') }),
    );
  });
  it.each([true, false])('opens notification-linked Inbox detail (desktop=%s)', async (desktop) => {
    render(
      <MemoryRouter initialEntries={['/inbox?item=two.md']}>
        <InboxView desktop={desktop} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Full second proposal')).toBeVisible();
    expect(screen.queryByText('Full first proposal')).toBeNull();
  });
  it('labels the archive action honestly and reports a failed mutation', async () => {
    render(
      <MemoryRouter>
        <InboxView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
    const detail = screen.getByRole('region', { name: 'Proposal details' });
    await within(detail).findByText('Full first proposal');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    fireEvent.click(within(detail).getByRole('button', { name: 'Archive' }));
    expect(mocks.fetch).toHaveBeenCalledWith('/api/inbox/one.md/approve', { method: 'POST' });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Archive failed/);
    expect(await screen.findByRole('button', { name: 'First proposal' })).toBeTruthy();
  });
  it('shows a retryable proposal read error instead of reviewing a truncated preview', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));
    render(
      <MemoryRouter>
        <InboxView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'First proposal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load/);
    expect(screen.queryByRole('button', { name: 'Review in session' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Full first proposal')).toBeTruthy();
  });
  it('moves expanded mobile events into the desktop inspector after a layout change', () => {
    const { rerender } = render(
      <MemoryRouter>
        <CalendarView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('Design review'));
    expect(screen.getByText('Studio')).toBeTruthy();
    rerender(
      <MemoryRouter>
        <CalendarView desktop />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Studio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Design review' }));
    expect(screen.getAllByText('Studio')).toHaveLength(1);
    expect(
      within(screen.getByRole('region', { name: 'Event details' })).getByText('Studio'),
    ).toBeTruthy();
  });
  it('uses one desktop heading and opens a dismissible inspector only on selection', () => {
    const { container } = render(
      <MemoryRouter>
        <CalendarView desktop />
      </MemoryRouter>,
    );
    expect(container.querySelector('.mitzo-logo')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Event details' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Today$/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Design review' }));
    const detail = screen.getByRole('region', { name: 'Event details' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Close event details' }));
    expect(screen.queryByRole('region', { name: 'Event details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Design review' })).toHaveFocus();
  });
  it('shows only populated dates in the desktop release agenda', () => {
    render(
      <MemoryRouter>
        <CalendarView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }));
    expect(screen.queryByText('No events')).toBeNull();
    expect(screen.getByText('No releases in this period')).toBeVisible();
  });
  it('keeps calendar controls and meeting actions beside the agenda', () => {
    render(
      <MemoryRouter>
        <CalendarView desktop />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Design review' }));
    const detail = screen.getByRole('region', { name: 'Event details' });
    expect(within(detail).getByText('Studio')).toBeTruthy();
    expect(within(detail).getByRole('link', { name: 'Join video call' }).getAttribute('href')).toBe(
      'https://meet.example.com/review',
    );
    fireEvent.click(within(detail).getByRole('button', { name: 'Prep for this meeting' }));
    expect(mocks.pending).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'mitzo-calendar' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }));
    expect(screen.queryByRole('region', { name: 'Event details' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Week' })).toBeDisabled();
  });
});
