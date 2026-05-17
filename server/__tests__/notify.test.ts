import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTurnCompleteNotification, sendPermissionNotification } from '../notify.js';

const mockFetch = vi.fn().mockResolvedValue({});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// These tests verify the interface contracts. When ntfy is not configured
// (no NTFY_TOPIC/BASE_URL), the functions are no-ops — that's also valid behavior.

describe('sendTurnCompleteNotification', () => {
  it('accepts sessionId and snippet parameters', async () => {
    await sendTurnCompleteNotification('sess-123', 'Summary text');

    if (mockFetch.mock.calls.length > 0) {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Actions).toContain('/chat/sess-123');
      expect(opts.body).toBe('Summary text');
    }
  });

  it('uses session title in notification title when provided', async () => {
    await sendTurnCompleteNotification('sess-123', 'Summary', 'Debug Auth Flow');

    if (mockFetch.mock.calls.length > 0) {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Title).toBe('Mitzo: Debug Auth Flow');
    }
  });

  it('falls back to Mitzo when no session title', async () => {
    await sendTurnCompleteNotification('sess-123', 'Summary');

    if (mockFetch.mock.calls.length > 0) {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Title).toBe('Mitzo');
    }
  });

  it('works without arguments (backward compatible)', async () => {
    await expect(sendTurnCompleteNotification()).resolves.toBeUndefined();
  });
});

describe('sendPermissionNotification', () => {
  it('accepts optional sessionId for deep linking', async () => {
    mockFetch.mockClear();
    await sendPermissionNotification('Bash', 'ls -la', 'perm-1', 'sess-456');

    if (mockFetch.mock.calls.length > 0) {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Actions).toContain('/chat/sess-456');
    }
  });

  it('works without sessionId (backward compatible)', async () => {
    await expect(sendPermissionNotification('Bash', 'ls', 'perm-1')).resolves.toBeUndefined();
  });
});
