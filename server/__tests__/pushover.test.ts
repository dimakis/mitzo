import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set env before importing module
const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.PUSHOVER_USER_KEY = 'test-user-key';
  process.env.PUSHOVER_API_TOKEN = 'test-api-token';
  process.env.BASE_URL = 'http://localhost:3100';
  mockFetch.mockResolvedValue({ ok: true });
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.clearAllMocks();
});

const { isConfigured, sendPushoverNotification } = await import('../pushover.js');

describe('isConfigured', () => {
  it('returns true when both keys are set', () => {
    expect(isConfigured()).toBe(true);
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

  it('does nothing when not configured', async () => {
    delete process.env.PUSHOVER_USER_KEY;
    await sendPushoverNotification('Title', 'Message');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
