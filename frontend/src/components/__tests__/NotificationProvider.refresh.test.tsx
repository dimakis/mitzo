// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationProvider, useNotifications } from '../NotificationProvider';
import { apiFetch } from '../../lib/api-fetch';
import { NOTIFICATIONS_REFRESH_EVENT } from '../../lib/notification-target';
const events = vi.hoisted(() => new Map<string, (value?: unknown) => void>());
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'lost',
  AUTH_RESTORED_EVENT: 'restored',
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (name: string, callback: () => void) => {
      events.set(name, callback);
      return () => events.delete(name);
    },
    onConnectionChange: (callback: (connected: boolean) => void) => {
      events.set('connected', callback);
      return () => events.delete('connected');
    },
  },
}));
vi.mock('../../lib/notification-badge', () => ({ syncNotificationBadge: vi.fn() }));
function Consumer() {
  const notifications = useNotifications()!;
  return (
    <>
      <div>{notifications.feed?.needsYou ?? 'waiting'}</div>
      <button onClick={() => notifications.setFilter('archived')}>Archived</button>
      <button onClick={() => void notifications.refresh()}>Refresh</button>
      <button onClick={() => void notifications.mutate('/read-updates')}>Mark read</button>
    </>
  );
}
function feed(count: number) {
  return new Response(JSON.stringify({ items: [], total: 0, needsYou: count }));
}
let finish!: (response: Response) => void;
beforeEach(() => {
  vi.mocked(apiFetch)
    .mockReset()
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(feed(2));
});
afterEach(cleanup);
function show() {
  render(
    <NotificationProvider>
      <Consumer />
    </NotificationProvider>,
  );
}
describe('notification refresh request coordination', () => {
  it('shares pending reads across foreground, native refresh and SSE reconnect', async () => {
    show();
    await act(async () => {
      window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
      document.dispatchEvent(new Event('visibilitychange'));
      events.get('connected')?.(true);
    });
    expect(apiFetch).toHaveBeenCalledOnce();
    await act(async () => {
      finish(feed(1));
    });
    expect(screen.getByText('1')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledOnce();
  });
  it('follows an in-flight read with one authoritative refresh for a burst of change events', async () => {
    show();
    await act(async () => {
      events.get('notifications_changed')?.();
      events.get('notifications_changed')?.();
      events.get('notifications_changed')?.();
    });
    expect(apiFetch).toHaveBeenCalledOnce();
    await act(async () => {
      finish(feed(1));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2')).toBeTruthy();
  });
  it('keeps a mutation refresh after the older read finishes', async () => {
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/notifications/read-updates',
      expect.objectContaining({ method: 'POST' }),
    );
    await act(async () => {
      finish(feed(1));
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('does not merge reads or queued events across a filter change', async () => {
    show();
    await act(async () => {
      events.get('notifications_changed')?.();
      fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('filter=archived'));
    await act(async () => {
      finish(feed(99));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('releases a failed read so a later refresh can recover', async () => {
    vi.mocked(apiFetch)
      .mockReset()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(feed(2));
    show();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('drops queued changes after logout and does not reuse the previous login read', async () => {
    show();
    await act(async () => {
      events.get('notifications_changed')?.();
      window.dispatchEvent(new Event('lost'));
      window.dispatchEvent(new Event('restored'));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(feed(99));
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('99')).toBeNull();
  });
});
