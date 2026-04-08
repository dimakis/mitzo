import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let isConfigured: () => boolean;
let sendPushoverNotification: (...args: any[]) => Promise<void>;

beforeEach(async () => {
  vi.stubEnv('PUSHOVER_USER_KEY', 'test-user-key');
  vi.stubEnv('PUSHOVER_API_TOKEN', 'test-api-token');
  vi.stubEnv('BASE_URL', 'http://localhost:3100');
  mockFetch.mockResolvedValue({ ok: true });

  vi.resetModules();
  const mod = await import('../pushover.js');
  isConfigured = mod.isConfigured;
  sendPushoverNotification = mod.sendPushoverNotification;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('isConfigured', () => {
  it('returns true when both keys are set', () => {
    expect(isConfigured()).toBe(true);
  });

  it('returns false when keys are missing', async () => {
    vi.unstubAllEnvs();
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_API_TOKEN;
    vi.resetModules();
    const mod = await import('../pushover.js');
    expect(mod.isConfigured()).toBe(false);
  });
});

describe('sendPushoverNotification', () => {
  it('posts to Pushover API with correct payload', async () => {
    await sendPushoverNotification('Test title', 'Test message');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');

    const body = JSON.parse(opts.body);
    expect(body.token).toBe('test-api-token');
    expect(body.user).toBe('test-user-key');
    expect(body.title).toBe('Test title');
    expect(body.message).toBe('Test message');
  });

  it('includes url and url_title when provided', async () => {
    await sendPushoverNotification('Title', 'Message', 'http://example.com', 'Open');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.url).toBe('http://example.com');
    expect(body.url_title).toBe('Open');
  });

  it('does not throw if fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    await expect(sendPushoverNotification('Title', 'Message')).resolves.not.toThrow();
  });

  it('does not throw on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });
    await expect(sendPushoverNotification('Title', 'Message')).resolves.not.toThrow();
  });

  it('does nothing when not configured', async () => {
    vi.unstubAllEnvs();
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_API_TOKEN;
    vi.resetModules();
    const mod = await import('../pushover.js');
    await mod.sendPushoverNotification('Title', 'Message');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
