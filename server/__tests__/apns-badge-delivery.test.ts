import { afterEach, describe, expect, it, vi } from 'vitest';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>();
  return {
    ...actual,
    createRequire: (url: string) => {
      const require = actual.createRequire(url);
      return (name: string) =>
        name === '@parse/node-apn'
          ? {
              Notification: class {},
              Provider: class {
                send = send;
              },
            }
          : require(name);
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  send.mockReset();
});
describe('badge delivery acknowledgement', () => {
  it('retries a partial alert only for devices that have not accepted it', async () => {
    vi.stubEnv('APNS_KEY_PATH', '/fixture/key.p8');
    vi.stubEnv('APNS_KEY_ID', 'fixture');
    vi.stubEnv('APNS_TEAM_ID', 'fixture');
    vi.resetModules();
    const apns = await import('../apns.js');
    apns.registerToken('a');
    apns.registerToken('b');
    send
      .mockResolvedValueOnce({ sent: [{ device: 'a' }], failed: [{ device: 'b', status: '503' }] })
      .mockResolvedValueOnce({ sent: [{ device: 'b' }], failed: [] });
    const message = {
      title: 'Mitzo',
      body: 'Review',
      badge: 0,
      category: 'SESSION_UPDATE',
      data: { notificationId: 'partial' },
    };
    const first = await apns.deliverNotification(message);
    expect(first).toEqual({ status: 'failed', acceptedDevices: ['a'] });
    const second = await apns.deliverNotification({ ...message, deliveredDevices: ['a'] });
    expect(second).toEqual({ status: 'accepted', acceptedDevices: ['b'] });
    expect(send.mock.calls[1][1]).toEqual(['b']);
  });
  it.each(['accepted', 'failed', 'partial', 'throw'])(
    'reports %s transport outcomes without treating failures as synchronized',
    async (outcome) => {
      vi.stubEnv('APNS_KEY_PATH', '/fixture/key.p8');
      vi.stubEnv('APNS_KEY_ID', 'fixture');
      vi.stubEnv('APNS_TEAM_ID', 'fixture');
      vi.resetModules();
      const apns = await import('../apns.js');
      apns.registerToken('a');
      apns.registerToken('b');
      if (outcome === 'throw') send.mockRejectedValue(new Error('temporary transport failure'));
      else
        send.mockResolvedValue({
          sent: outcome === 'accepted' ? ['a', 'b'] : outcome === 'partial' ? ['a'] : [],
          failed: outcome === 'accepted' ? [] : [{ device: 'b', status: '503' }],
        });
      expect(await apns.sendBadgeUpdate(0)).toBe(outcome === 'accepted' ? 'accepted' : 'failed');
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ badge: 0 }), ['a', 'b']);
    },
  );
});
