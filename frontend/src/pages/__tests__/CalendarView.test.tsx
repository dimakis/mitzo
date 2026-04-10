// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CalendarView } from '../CalendarView';

const MOCK_CALENDAR = {
  startDate: '2026-04-10',
  endDate: '2026-04-16',
  events: [
    {
      id: 'evt-1',
      type: 'meeting',
      title: 'Standup',
      start: '2026-04-10T10:00:00-04:00',
      end: '2026-04-10T10:30:00-04:00',
      allDay: false,
      attendees: ['alice@example.com'],
      attendeeCount: 2,
    },
    {
      id: 'milestone-3.4-cf',
      type: 'milestone',
      title: '3.4 Code Freeze',
      start: '2026-04-10',
      end: '2026-04-10',
      allDay: true,
      version: '3.4',
      milestone: 'cf',
      label: 'Code Freeze',
      daysAway: 0,
      ourFeatures: 24,
      totalFeatures: 66,
    },
  ],
  sprints: [
    {
      id: 'sprint-8',
      type: 'sprint',
      title: 'Sprint 2026-08',
      start: '2026-04-14',
      end: '2026-04-27',
    },
  ],
};

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CALENDAR),
    }),
  );
});

afterEach(() => {
  document.body.removeChild(container);
  vi.restoreAllMocks();
});

function renderCalendar() {
  const root = createRoot(container);
  act(() => {
    root.render(createElement(MemoryRouter, null, createElement(CalendarView)));
  });
  return root;
}

describe('CalendarView', () => {
  it('renders calendar header with navigation', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const header = container.querySelector('.cal-header');
    expect(header).not.toBeNull();

    const prevBtn = container.querySelector('.cal-nav-prev');
    const nextBtn = container.querySelector('.cal-nav-next');
    expect(prevBtn).not.toBeNull();
    expect(nextBtn).not.toBeNull();
  });

  it('renders meeting events', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const cards = container.querySelectorAll('.cal-event-meeting');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0].textContent).toContain('Standup');
  });

  it('renders milestone events', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const milestones = container.querySelectorAll('.cal-event-milestone');
    expect(milestones.length).toBeGreaterThanOrEqual(1);
    expect(milestones[0].textContent).toContain('3.4 Code Freeze');
  });

  it('renders sprint bar', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const sprint = container.querySelector('.cal-sprint');
    expect(sprint).not.toBeNull();
    expect(sprint!.textContent).toContain('Sprint 2026-08');
  });

  it('shows loading state initially', () => {
    renderCalendar();

    const loading = container.querySelector('.cal-loading');
    expect(loading).not.toBeNull();
  });

  it('navigates date forward on next click', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const nextBtn = container.querySelector('.cal-nav-next') as HTMLButtonElement;
    expect(nextBtn).not.toBeNull();

    act(() => {
      nextBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have fetched again with a later date
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('renders back button for navigation', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const back = container.querySelector('.cal-back');
    expect(back).not.toBeNull();
  });

  it('switches to day view on Day toggle click', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Week button should be active initially
    const weekBtn = container.querySelector('.cal-view-btn--active');
    expect(weekBtn).not.toBeNull();
    expect(weekBtn!.textContent).toBe('Week');

    // Click Day button
    const dayBtn = Array.from(container.querySelectorAll('.cal-view-btn')).find(
      (b) => b.textContent === 'Day',
    ) as HTMLButtonElement;
    expect(dayBtn).not.toBeNull();

    act(() => {
      dayBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Day button should now be active
    const activeBtn = container.querySelector('.cal-view-btn--active');
    expect(activeBtn!.textContent).toBe('Day');

    // Should refetch with days=1
    const calls = vi.mocked(fetch).mock.calls.map((c) => c[0]);
    expect(calls.some((url) => (url as string).includes('days=1'))).toBe(true);
  });

  it('navigates to today on title click', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Navigate forward first
    const nextBtn = container.querySelector('.cal-nav-next') as HTMLButtonElement;
    act(() => {
      nextBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Click the title (today button)
    const titleBtn = container.querySelector('.cal-header-title') as HTMLButtonElement;
    act(() => {
      titleBtn.click();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Should have fetched 3 times: initial, next, today
    expect(fetch).toHaveBeenCalledTimes(3);
    // The last call should include today's date
    const today = new Date().toISOString().slice(0, 10);
    const lastCall = vi.mocked(fetch).mock.calls[2][0] as string;
    expect(lastCall).toContain(`date=${today}`);
  });

  it('expands meeting card on click to show detail', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // No detail shown initially
    expect(container.querySelector('.cal-event-detail')).toBeNull();

    // Click the meeting card
    const meetingCard = container.querySelector('.cal-event-meeting') as HTMLDivElement;
    act(() => {
      meetingCard.click();
    });

    // Detail section should now be visible
    const detail = container.querySelector('.cal-event-detail');
    expect(detail).not.toBeNull();
    // Should show attendee name
    const attendee = container.querySelector('.cal-attendee');
    expect(attendee).not.toBeNull();
    expect(attendee!.textContent).toBe('alice');
  });

  it('expands milestone card on click to show features', async () => {
    renderCalendar();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Click the milestone card
    const milestoneCard = container.querySelector('.cal-event-milestone') as HTMLDivElement;
    act(() => {
      milestoneCard.click();
    });

    // Detail section should show feature counts
    const detail = milestoneCard.querySelector('.cal-event-detail');
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('24 of our features');
    expect(detail!.textContent).toContain('66 total');
  });
});
