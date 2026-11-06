// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionActivity } from '@mitzo/protocol';
import { SessionActivityStatus } from '../SessionActivityStatus';

const activity: SessionActivity = {
  sessionId: 'one',
  clientId: 'client',
  title: 'One',
  state: 'working',
  flags: [],
  lastEventAt: 110_000,
  turnStartedAt: 60_000,
  lastMessageAt: 90_000,
  phase: 'reading',
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('uses the turn clock for elapsed time and ticks without incoming events', () => {
  vi.useFakeTimers();
  vi.setSystemTime(120_000);
  render(<SessionActivityStatus activity={activity} modifiedAt={110_000} />);
  expect(screen.getByText('Reading files')).toBeTruthy();
  expect(screen.getByText('elapsed 1m 00s')).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText('elapsed 1m 01s')).toBeTruthy();
});

it('keeps unknown timing unknown and labels saved modification separately from messages', () => {
  const view = render(
    <SessionActivityStatus
      activity={{ ...activity, turnStartedAt: undefined }}
      modifiedAt={110_000}
    />,
  );
  expect(screen.queryByText(/elapsed/)).toBeNull();
  view.rerender(<SessionActivityStatus modifiedAt={110_000} />);
  expect(screen.getByText(/Updated/)).toBeTruthy();
  expect(screen.queryByText(/Last message/)).toBeNull();
});

it('stops claiming live progress when disconnected and uses last seen time', () => {
  render(<SessionActivityStatus activity={activity} modifiedAt={110_000} connected={false} />);
  expect(screen.getByText('Reconnecting')).toBeTruthy();
  expect(screen.getByText(/last seen/)).toBeTruthy();
  expect(document.querySelector('.session-activity-bars')).toBeNull();
});

it('shows explicit approval and completion times with a real progress count', () => {
  vi.useFakeTimers();
  vi.setSystemTime(120_000);
  const view = render(
    <SessionActivityStatus
      activity={{
        ...activity,
        state: 'waiting',
        waitReason: 'permission',
        stateChangedAt: 115_000,
      }}
      modifiedAt={110_000}
    />,
  );
  expect(screen.getByText('Permission needed')).toBeTruthy();
  expect(screen.getByText('waiting 5s')).toBeTruthy();
  view.rerender(
    <SessionActivityStatus
      activity={{
        ...activity,
        state: 'done',
        completedAt: 119_000,
        progress: { done: 5, total: 5 },
      }}
      modifiedAt={110_000}
    />,
  );
  expect(screen.getByText('Finished')).toBeTruthy();
  expect(screen.getByText('finished just now')).toBeTruthy();
  expect(screen.getByText('5/5 tasks')).toBeTruthy();
});
