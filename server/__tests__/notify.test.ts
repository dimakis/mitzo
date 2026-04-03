import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isConfigured, sendTurnCompleteNotification } from '../notify.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('notify module', () => {
  it('isConfigured returns false without NTFY_TOPIC', () => {
    expect(isConfigured()).toBe(false);
  });
});

describe('sendTurnCompleteNotification', () => {
  it('is exported as a function', () => {
    expect(typeof sendTurnCompleteNotification).toBe('function');
  });

  it('does not throw when ntfy is not configured', async () => {
    await expect(sendTurnCompleteNotification()).resolves.toBeUndefined();
  });
});
