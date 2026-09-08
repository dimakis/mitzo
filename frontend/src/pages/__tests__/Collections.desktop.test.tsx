// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(within(detail).queryByText('Studio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Week' })).toBeDisabled();
  });
});
