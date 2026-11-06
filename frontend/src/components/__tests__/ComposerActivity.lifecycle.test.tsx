// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerStatusProvider, ComposerStatusRail } from '../ComposerStatus';

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
