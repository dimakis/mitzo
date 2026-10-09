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
function show(path = '/notifications') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NotificationProvider>
        <NotificationsView />
      </NotificationProvider>
    </MemoryRouter>,
  );
}
describe('Notifications experience', () => {
  it.each([
    { toolName: 'Bash', toolInput: 'npm test' },
    {
      toolName: 'RequestWebAccess',
      approvalScope: 'session',
      toolInput: JSON.stringify({ operation: 'fetch', url: 'https://example.com' }),
    },
    {
      toolName: 'AskUserQuestion',
      questions: [{ id: 'q1', question: 'Choose?', options: [{ label: 'Yes' }] }],
    },
  ])('omits the session search action for ineligible $toolName requests', async (request) => {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, options) => {
      const response = await original(url, options);
      if (options?.method) return response;
      const data = await response.json();
      data.items[0].request = { ...pending.request, ...request };
      return new Response(JSON.stringify(data));
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }));
    await screen.findByRole('button', { name: 'Deny' });
    expect(screen.queryByText('Allow searches for this session')).not.toBeInTheDocument();
  });
  it('offers an explicit session search grant in notification details', async () => {
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, options) => {
      const response = await original(url, options);
      if (options?.method) return response;
      const data = await response.json();
      data.items[0].request = {
        ...pending.request,
        toolName: 'RequestWebAccess',
        approvalScope: 'session',
        toolInput: JSON.stringify({ operation: 'search', query: 'Pricing' }),
      };
      return new Response(JSON.stringify(data));
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Review request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow searches for this session' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/notifications/permission%3Ap1/respond',
        expect.objectContaining({ body: JSON.stringify({ sessionId: 's1', decision: 'always' }) }),
      ),
    );
  });
  it.each([true, false])(
    'marks a directly linked update read after loading (in current page: %s)',
    async (inPage) => {
      let read = false;
      const update = {
        ...pending,
        id: 'turn:s1:99',
        kind: 'session',
        permId: undefined,
        request: undefined,
      };
      vi.mocked(apiFetch).mockImplementation(async (url, options) => {
        if (String(url).endsWith('/read') && options?.method === 'POST') {
          read = true;
          return new Response(JSON.stringify({ ok: true }));
        }
        const item = { ...update, readAt: read ? Date.now() : null };
        return new Response(
          JSON.stringify(
            String(url).includes('?')
              ? {
                  items: inPage ? [item] : [],
                  needsYou: 0,
                  total: inPage ? 1 : 0,
                  preferences: prefs,
                  delivery: { configured: false, registeredDevices: 0 },
                }
              : item,
          ),
        );
      });
      show('/notifications?item=turn:s1:99');
      await waitFor(() =>
        expect(apiFetch).toHaveBeenCalledWith(
          '/api/notifications/turn%3As1%3A99/read',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      expect(
        vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/read')),
      ).toHaveLength(1);
      expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/respond'))).toBe(
        false,
      );
    },
  );
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
  it('refreshes an older linked request after a decision outside the current page', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/respond')) {
        resolved = true;
        return new Response(JSON.stringify({ ok: true }));
      }
      if (String(url).includes('?'))
        return new Response(
          JSON.stringify({
            items: [],
            needsYou: resolved ? 0 : 1,
            total: 0,
            preferences: prefs,
            delivery: { configured: false, registeredDevices: 0 },
          }),
        );
      return new Response(
        JSON.stringify({
          ...pending,
          resolution: resolved ? 'allowed' : null,
          resolvedAt: resolved ? Date.now() : null,
        }),
      );
    });
    show('/notifications?item=permission:p1');
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
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

it('archives finished items and restores from Archived, preserving pending requests', async () => {
  let archived = false;
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    const path = String(url);
    if (options?.method) {
      if (path.endsWith('/archive') || path.endsWith('/archive-resolved')) archived = true;
      if (path.endsWith('/restore')) archived = false;
      return new Response(JSON.stringify({ ok: true }));
    }
    const archiveFeed = path.includes('filter=archived');
    const finished = {
      ...pending,
      id: 'done',
      permId: undefined,
      request: undefined,
      kind: 'session',
      title: 'Completed work',
      readAt: 1,
      archivedAt: archived ? 1 : null,
    };
    const items = archiveFeed
      ? archived
        ? [finished]
        : []
      : [pending, ...(!archived ? [finished] : [])];
    return new Response(
      JSON.stringify({
        items,
        needsYou: 1,
        total: items.length,
        preferences: prefs,
        delivery: { configured: false, registeredDevices: 0 },
      }),
    );
  });
  show();
  await screen.findByText('Completed work');
  expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(screen.queryByText('Completed work')).toBeNull());
  expect(screen.getByRole('button', { name: 'Review request' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(screen.queryByText('Completed work')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  await screen.findByText('Completed work');
  fireEvent.click(screen.getByRole('button', { name: 'Archive resolved' }));
  await waitFor(() => expect(screen.queryByText('Completed work')).toBeNull());
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/notifications/archive-resolved',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/respond'))).toBe(
    false,
  );
});

it('returns to the previous page after archiving the last item on a page', async () => {
  let archived = false;
  const update = { ...pending, kind: 'session', permId: undefined, request: undefined, readAt: 1 };
  vi.mocked(apiFetch).mockImplementation(async (url, options) => {
    if (options?.method) {
      archived = true;
      return new Response(JSON.stringify({ ok: true }));
    }
    const offset = Number(new URL(String(url), 'http://test').searchParams.get('offset'));
    return new Response(
      JSON.stringify({
        items:
          offset === 50
            ? archived
              ? []
              : [{ ...update, id: 'last', title: 'Last item' }]
            : Array.from({ length: 50 }, (_, i) => ({
                ...update,
                id: `u${i}`,
                title: `Update ${i}`,
              })),
        needsYou: 0,
        total: archived ? 50 : 51,
        preferences: prefs,
        delivery: { configured: false, registeredDevices: 0 },
      }),
    );
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
  await screen.findByText('Last item');
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await screen.findByText('Update 0');
  expect(screen.queryByText('Last item')).toBeNull();
});
