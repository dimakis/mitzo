import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
let sender: typeof import('../notify.js');

const mockFetch = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('NTFY_TOPIC', 'synthetic-topic');
  vi.stubEnv('BASE_URL', 'https://mitzo.example');
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
  sender = await import('../notify.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('sendTurnCompleteNotification', () => {
  it('accepts sessionId and snippet parameters', async () => {
    await sender.sendTurnCompleteNotification('sess-123', 'Summary text');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Actions).toContain('/chat/sess-123');
    expect(opts.body).toBe('Summary text');
  });

  it('uses session title in notification title when provided', async () => {
    await sender.sendTurnCompleteNotification('sess-123', 'Summary', 'Debug Auth Flow');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Title).toBe('Mitzo: Debug Auth Flow');
  });

  it('falls back to Mitzo when no session title', async () => {
    await sender.sendTurnCompleteNotification('sess-123', 'Summary');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Title).toBe('Mitzo');
  });

  it('works without arguments (backward compatible)', async () => {
    await expect(sender.sendTurnCompleteNotification()).resolves.toBeUndefined();
  });
});

describe('sendPermissionNotification', () => {
  it('accepts optional sessionId for deep linking', async () => {
    mockFetch.mockClear();
    await expect(
      sender.sendPermissionNotification('Bash', 'ls -la', 'perm-1', 'sess-456'),
    ).resolves.toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Actions).toContain('/chat/sess-456');
  });

  it('works without sessionId (backward compatible)', async () => {
    await expect(sender.sendPermissionNotification('Bash', 'ls', 'perm-1')).resolves.toBe(true);
    expect(mockFetch.mock.calls[0][1].headers.Actions).toContain(
      'view, Open Mitzo, https://mitzo.example',
    );
  });

  it('reports no delivery when notification configuration is absent', async () => {
    vi.stubEnv('NTFY_TOPIC', '');
    vi.resetModules();
    const unconfigured = await import('../notify.js');
    await expect(unconfigured.sendPermissionNotification('Bash', 'ls', 'perm-1')).resolves.toBe(
      false,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
