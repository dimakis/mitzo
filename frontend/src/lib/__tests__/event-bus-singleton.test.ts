// @vitest-environment jsdom
// Tests for the global SSE EventBus singleton's visibilitychange recovery.

import { describe, it, expect, vi } from 'vitest';

// Mock EventSource (jsdom doesn't provide it)
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = MockEventSource.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

// Must be set before module loads — static imports are hoisted above beforeAll
global.EventSource = MockEventSource as unknown as typeof EventSource;

// Dynamic import so the module-level side effects run after EventSource is defined
const { eventBus } = await import('../event-bus-singleton');

describe('event-bus-singleton visibilitychange recovery', () => {
  it('calls ensureConnected when page becomes visible', () => {
    const ensureConnectedSpy = vi.spyOn(eventBus, 'ensureConnected');

    // Simulate page becoming visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });

    document.dispatchEvent(new Event('visibilitychange'));

    expect(ensureConnectedSpy).toHaveBeenCalled();
    ensureConnectedSpy.mockRestore();
  });

  it('does not call ensureConnected when page becomes hidden', () => {
    const ensureConnectedSpy = vi.spyOn(eventBus, 'ensureConnected');

    // Simulate page becoming hidden
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });

    document.dispatchEvent(new Event('visibilitychange'));

    expect(ensureConnectedSpy).not.toHaveBeenCalled();
    ensureConnectedSpy.mockRestore();
  });
});
