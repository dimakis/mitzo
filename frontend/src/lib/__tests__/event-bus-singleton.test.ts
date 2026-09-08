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
const { eventBus, ensureEventBusConnected } = await import('../event-bus-singleton');

describe('event-bus-singleton visibilitychange recovery', () => {
  it('disconnects stale EventSource credentials on auth loss', () => {
    const disconnectSpy = vi.spyOn(eventBus, 'disconnect');

    window.dispatchEvent(new Event('mitzo:auth-lost'));

    expect(disconnectSpy).toHaveBeenCalled();
    const ensureConnectedSpy = vi.spyOn(eventBus, 'ensureConnected');
    ensureEventBusConnected();
    expect(ensureConnectedSpy).not.toHaveBeenCalled();
    ensureConnectedSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it('recreates EventSource with fresh credentials after auth restoration', () => {
    const disconnectSpy = vi.spyOn(eventBus, 'disconnect');
    const connectSpy = vi.spyOn(eventBus, 'connect');

    window.dispatchEvent(new Event('mitzo:auth-restored'));

    expect(disconnectSpy).toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalled();
    disconnectSpy.mockRestore();
    connectSpy.mockRestore();
  });

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
