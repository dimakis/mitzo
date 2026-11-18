// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ComposerStatusProvider,
  ComposerStatusRail,
  ComposerStatusNotice,
} from '../ComposerStatus';

const bus = vi.hoisted(() => {
  const events = new Map<string, (data: unknown) => void>();
  let connection: (connected: boolean) => void;
  return {
    connected: false,
    on: (event: string, handler: (data: unknown) => void) => {
      events.set(event, handler);
      return () => {};
    },
    onConnectionChange: (handler: (connected: boolean) => void) => {
      connection = handler;
      return () => {};
    },
    activity: (data: unknown) => events.get('session_activity')!(data),
    connection: (connected: boolean) => connection(connected),
  };
});
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: bus }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(120_000);
  window.dispatchEvent(new Event('mitzo:auth-restored'));
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('hydrates a newly mounted rail and stops live presentation when its running turn disconnects', () => {
  act(() => {
    bus.connection(true);
    bus.activity([
      {
        sessionId: 'one',
        clientId: 'client',
        title: 'Long command',
        flags: [],
        state: 'working',
        phase: 'command',
        turnStartedAt: 60_000,
        lastEventAt: 100_000,
      },
    ]);
  });
  render(
    <ComposerStatusProvider>
      <ComposerStatusRail sessionId="one" running />
    </ComposerStatusProvider>,
  );
  const row = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(row).getByRole('status').textContent).toBe('Running command');
  expect(within(row).getByText('elapsed 1m 00s')).toBeTruthy();
  expect(row.querySelector('.session-activity-bars')).toBeTruthy();
  act(() => bus.connection(false));
  expect(within(row).getByRole('status').textContent).toBe('Reconnecting');
  expect(row.querySelector('.session-activity-bars')).toBeNull();
  expect(within(row).queryByText(/elapsed/)).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Conversation status details' }));
  const dialog = screen.getByRole('dialog', { name: 'Conversation status' });
  expect(within(dialog).getByText(/last seen/)).toBeTruthy();
  expect(within(dialog).queryByText('Agent working')).toBeNull();
  act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
  expect(within(dialog).queryByText(/last seen/)).toBeNull();
});

it('describes a stopped recovery fence without claiming the chat is ready', () => {
  function Fixture({ blocked = true }) {
    return (
      <ComposerStatusProvider>
        {blocked && (
          <ComposerStatusNotice message="Original tool effects need review" tone="warning" />
        )}
        <ComposerStatusRail />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
  const dialog = screen.getByRole('dialog', { name: 'Conversation status' });
  expect(within(dialog).queryByText('Ready for your next message')).toBeNull();
  expect(within(dialog).getByText('Needs attention before continuing')).toBeTruthy();
  view.rerender(<Fixture blocked={false} />);
  expect(within(dialog).getByText('Ready for your next message')).toBeTruthy();
});

it('refreshes a completed turn from activity evidence before the message stream catches up', () => {
  const activity = {
    sessionId: 'one',
    clientId: 'client',
    title: 'Command',
    flags: [],
    state: 'working',
    phase: 'command',
    turnStartedAt: 60_000,
    lastEventAt: 100_000,
  };
  act(() => {
    bus.connection(true);
    bus.activity([activity]);
  });
  render(
    <ComposerStatusProvider>
      <ComposerStatusRail sessionId="one" running />
    </ComposerStatusProvider>,
  );
  const row = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(row).getByRole('status').textContent).toBe('Running command');
  act(() => bus.activity([{ ...activity, state: 'done', phase: undefined, completedAt: 120_000 }]));
  expect(within(row).getByRole('status').textContent).toBe('Finished');
  expect(row.querySelector('.session-activity-bars')).toBeNull();
  expect(within(row).queryByText(/elapsed/)).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Conversation status details' }));
  const dialog = screen.getByRole('dialog', { name: 'Conversation status' });
  expect(within(dialog).queryByText('Agent working')).toBeNull();
});

it('uses the selected chat status immediately without waiting for another activity event', () => {
  act(() => {
    bus.connection(true);
    bus.activity([
      {
        sessionId: 'one',
        clientId: 'first',
        title: 'Command',
        flags: [],
        state: 'working',
        phase: 'command',
        turnStartedAt: 60_000,
        lastEventAt: 100_000,
      },
      {
        sessionId: 'two',
        clientId: 'second',
        title: 'Idle chat',
        flags: [],
        state: 'idle',
        lastEventAt: 90_000,
      },
    ]);
  });
  function Fixture({ id }: { id: string }) {
    return (
      <ComposerStatusProvider>
        <ComposerStatusRail sessionId={id} running />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture id="one" />);
  const row = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(row).getByRole('status').textContent).toBe('Running command');
  view.rerender(<Fixture id="two" />);
  expect(within(row).getByRole('status').textContent).toBe('Idle');
  expect(row.querySelector('.session-activity-bars')).toBeNull();
  expect(within(row).queryByText(/elapsed/)).toBeNull();
});

it('does not reuse the previous turn completion when a new turn starts', () => {
  const finished = {
    sessionId: 'one',
    clientId: 'client',
    title: 'Previous turn',
    flags: [],
    state: 'done',
    lastEventAt: 100_000,
    completedAt: 100_000,
    turnStartedAt: 60_000,
  };
  act(() => {
    bus.connection(true);
    bus.activity([finished]);
  });
  function Fixture({ running }: { running: boolean }) {
    return (
      <ComposerStatusProvider>
        <ComposerStatusRail sessionId="one" running={running} />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture running={false} />);
  view.rerender(<Fixture running />);
  const row = screen.getByRole('region', { name: 'Conversation status' });
  expect(within(row).getByRole('status').textContent).toBe('Working');
  expect(within(row).queryByText(/elapsed/)).toBeNull();
  // An unrelated broadcast may repeat the previous turn's exact observation.
  act(() => bus.activity([{ ...finished }]));
  expect(within(row).getByRole('status').textContent).toBe('Working');
  act(() => bus.activity([{ ...finished, lastEventAt: 120_000, completedAt: 120_000 }]));
  expect(within(row).getByRole('status').textContent).toBe('Finished');
});

it('keeps fresh working activity when its start reaches the overview first', () => {
  act(() => {
    bus.connection(true);
    bus.activity([]);
  });
  function Fixture({ running }: { running: boolean }) {
    return (
      <ComposerStatusProvider>
        <ComposerStatusRail sessionId="one" running={running} />
      </ComposerStatusProvider>
    );
  }
  const view = render(<Fixture running={false} />);
  act(() =>
    bus.activity([
      {
        sessionId: 'one',
        clientId: 'client',
        title: 'New turn',
        flags: [],
        state: 'working',
        phase: 'reading',
        turnStartedAt: 120_000,
        lastEventAt: 120_000,
      },
    ]),
  );
  view.rerender(<Fixture running />);
  expect(screen.getByRole('status').textContent).toBe('Reading files');
});
