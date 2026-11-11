import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('BASE_URL', 'https://mitzo.example');
  vi.stubEnv('NTFY_TOPIC', 'test-topic');
  vi.stubEnv('PUSHOVER_API_TOKEN', 'synthetic-token');
  vi.stubEnv('PUSHOVER_USER_KEY', 'synthetic-user');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['ntfy', 'pushover'] as const)(
  'reports actual %s delivery and never claims HTTP failure as success',
  async (channel) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new Error('Synthetic network failure'))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const sender =
      channel === 'ntfy' ? await import('../src/notify.js') : await import('../src/pushover.js');
    expect(
      await sender.sendPermissionNotification('Review', 'Open Mitzo', 'permission', 'session'),
    ).toBe(false);
    expect(
      await sender.sendPermissionNotification('Review', 'Open Mitzo', 'permission', 'session'),
    ).toBe(false);
    expect(
      await sender.sendPermissionNotification('Review', 'Open Mitzo', 'permission', 'session'),
    ).toBe(true);
  },
);

it('keeps redacted legacy alerts review-only', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const { sendPermissionNotification } = await import('../src/notify.js');
  await sendPermissionNotification('Review', 'Open Mitzo', 'permission', 'session', {
    reviewOnly: true,
  });
  const { headers } = fetch.mock.calls[0][1];
  expect(headers.Actions).toBe('view, Open Mitzo, https://mitzo.example/chat/session');
});
