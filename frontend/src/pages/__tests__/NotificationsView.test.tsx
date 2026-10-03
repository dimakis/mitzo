// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { NotificationProvider } from '../../components/NotificationProvider';
import { NotificationsView } from '../NotificationsView';
import { NOTIFICATIONS_REFRESH_EVENT } from '../../lib/notification-target';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'lost',
  AUTH_RESTORED_EVENT: 'restored',
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: { on: () => () => {}, onConnectionChange: () => () => {} },
}));
vi.mock('../../lib/notification-badge', () => ({ syncNotificationBadge: vi.fn() }));
const pending = {
  id: 'permission:p1',
  kind: 'approval',
  title: 'Run the next test?',
  body: 'Notification improvements',
  sessionId: 's1',
  permId: 'p1',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  readAt: null,
  resolution: null,
  resolvedAt: null,
  request: { permId: 'p1', toolName: 'Bash', toolInput: 'npm test', sessionId: 's1' },
};
const prefs = {
  approvals: true,
  questions: true,
  completion: 'unattended',
  updates: true,
  sensitivePreviews: false,
  quietHours: false,
  quietStart: '22:00',
  quietEnd: '08:00',
  timezone: 'UTC',
};
let resolved = false;
beforeEach(() => {
  resolved = false;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (String(url).includes('/respond')) {
      resolved = true;
      return new Response(JSON.stringify({ ok: true }));
    }
    if (options?.method === 'PUT')
      return new Response(JSON.stringify({ ...prefs, ...JSON.parse(String(options.body)) }));
    return new Response(
      JSON.stringify({
        items: [
          {
            ...pending,
            resolution: resolved ? 'allowed' : null,
            resolvedAt: resolved ? Date.now() : null,
          },
        ],
        needsYou: resolved ? 0 : 1,
        total: 1,
        preferences: prefs,
        delivery: { configured: false, registeredDevices: 0 },
      }),
    );
  });
});
afterEach(cleanup);
function show() {
  render(
    <MemoryRouter>
      <NotificationProvider>
        <NotificationsView />
      </NotificationProvider>
    </MemoryRouter>,
  );
}
describe('Notifications experience', () => {
  it('shows real request details and only one-shot approval from the notification center', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }));
    expect(await screen.findByText('npm test')).toBeVisible();
    expect(screen.queryByRole('button', { name: /always/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/notifications/permission%3Ap1/respond',
        expect.objectContaining({ body: JSON.stringify({ sessionId: 's1', decision: 'once' }) }),
      ),
    );
    expect(await screen.findByText('Decision recorded')).toBeVisible();
  });
  it('directs conversation grants to the session rather than promising one-shot access', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ ...pending, request: { ...pending.request, approvalScope: 'conversation' } }],
          needsYou: 1,
          total: 1,
          preferences: prefs,
          delivery: { configured: false, registeredDevices: 0 },
        }),
      ),
    );
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }));
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open session' })).toBeVisible();
  });
  it('does not equate marking updates read with granting approval', async () => {
    show();
    await screen.findByText('Run the next test?');
    fireEvent.click(screen.getByRole('button', { name: 'Mark updates read' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/notifications/read-updates',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Review request' })).toBeVisible();
  });
  it('saves delivery preferences and distinguishes unavailable delivery', async () => {
    show();
    await screen.findByText('Run the next test?');
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(screen.getByText('Push is not configured on this server.')).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Session approvals' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/notifications/preferences',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"approvals":false'),
        }),
      ),
    );
  });
  it('keeps native refresh blocked after authentication is lost', async () => {
    show();
    await screen.findByText('Run the next test?');
    fireEvent(window, new Event('lost'));
    const calls = vi.mocked(apiFetch).mock.calls.length;
    fireEvent(window, new Event(NOTIFICATIONS_REFRESH_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls);
    fireEvent(window, new Event('restored'));
    await screen.findByText('Run the next test?');
  });
  it('renders failure with retry instead of an empty success state', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load notifications');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
