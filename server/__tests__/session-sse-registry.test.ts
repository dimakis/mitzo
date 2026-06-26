import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionSseRegistry } from '../session-sse-registry.js';

function mockResponse(writableEnded = false) {
  return {
    write: vi.fn(),
    end: vi.fn(),
    writableEnded,
  } as never;
}

describe('SessionSseRegistry', () => {
  let registry: SessionSseRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new SessionSseRegistry();
  });

  afterEach(() => {
    registry.destroy();
    vi.useRealTimers();
  });

  describe('removeIfCurrent', () => {
    it('removes and returns true when res matches current stream', () => {
      const res = mockResponse();
      registry.add('conn-1', res);

      expect(registry.removeIfCurrent('conn-1', res)).toBe(true);
      expect(registry.isOpen('conn-1')).toBe(false);
    });

    it('returns false when res does not match current stream (replaced by reconnect)', () => {
      const oldRes = mockResponse();
      const newRes = mockResponse();
      registry.add('conn-1', oldRes);
      registry.add('conn-1', newRes); // reconnect replaces old stream

      // Old close handler fires — should NOT remove the new stream
      expect(registry.removeIfCurrent('conn-1', oldRes)).toBe(false);
      expect(registry.isOpen('conn-1')).toBe(true);
    });

    it('returns false for unknown connectionId', () => {
      const res = mockResponse();
      expect(registry.removeIfCurrent('conn-unknown', res)).toBe(false);
    });
  });
});
