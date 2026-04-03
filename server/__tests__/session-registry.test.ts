import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionRegistry } from '../session-registry.js';
import { DETACHED_TTL_MS, DETACHED_BUFFER_MAX } from '../constants.js';

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('register', () => {
    it('registers a session and makes it retrievable by clientId', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      const fakeAbort = new AbortController();
      registry.register('client-1', {
        ws: fakeWs,
        abortController: fakeAbort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.get('client-1')).toBeDefined();
      expect(registry.get('client-1')!.ws).toBe(fakeWs);
    });

    it('marks session as attached on registration', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.isAttached('client-1')).toBe(true);
    });

    it('isActive returns true for registered session', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.isActive('client-1')).toBe(true);
    });

    it('isActive returns false for unknown clientId', () => {
      expect(registry.isActive('nonexistent')).toBe(false);
    });
  });

  describe('detach', () => {
    it('detaches a session without aborting it', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      const abort = new AbortController();
      registry.register('client-1', {
        ws: fakeWs,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      expect(registry.isAttached('client-1')).toBe(false);
      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);
    });

    it('stores the SDK sessionId when detaching', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-session-abc',
      });

      registry.detach('client-1');
      const session = registry.get('client-1');
      expect(session!.sessionId).toBe('sdk-session-abc');
    });

    it('is a no-op for unknown clientId', () => {
      expect(() => registry.detach('nonexistent')).not.toThrow();
    });
  });

  describe('reattach', () => {
    it('reattaches a new WebSocket to a detached session', () => {
      const oldWs = { readyState: 1, OPEN: 1 } as any;
      const newWs = { readyState: 1, OPEN: 1 } as any;

      registry.register('client-1', {
        ws: oldWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-session-abc',
      });

      registry.detach('client-1');
      const reattached = registry.reattach('client-1', newWs);

      expect(reattached).toBe(true);
      expect(registry.isAttached('client-1')).toBe(true);
      expect(registry.get('client-1')!.ws).toBe(newWs);
    });

    it('returns false for unknown clientId', () => {
      const ws = { readyState: 1, OPEN: 1 } as any;
      expect(registry.reattach('nonexistent', ws)).toBe(false);
    });

    it('works on already-attached session (WS swap)', () => {
      const ws1 = { readyState: 1, OPEN: 1 } as any;
      const ws2 = { readyState: 1, OPEN: 1 } as any;

      registry.register('client-1', {
        ws: ws1,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const reattached = registry.reattach('client-1', ws2);
      expect(reattached).toBe(true);
      expect(registry.get('client-1')!.ws).toBe(ws2);
    });

    it('cancels the detach timeout when reattaching', () => {
      vi.useFakeTimers();

      const oldWs = { readyState: 1, OPEN: 1 } as any;
      const newWs = { readyState: 1, OPEN: 1 } as any;
      const abort = new AbortController();

      registry.register('client-1', {
        ws: oldWs,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Reattach before timeout fires
      registry.reattach('client-1', newWs);

      // Advance past the TTL — session should still be alive
      vi.advanceTimersByTime(DETACHED_TTL_MS + 1000);

      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('findBySessionId', () => {
    it('finds a session by its SDK session ID', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-123',
      });

      const result = registry.findBySessionId('sdk-123');
      expect(result).not.toBeNull();
      expect(result!.clientId).toBe('client-1');
      expect(result!.session.sessionId).toBe('sdk-123');
    });

    it('returns null for unknown SDK session ID', () => {
      expect(registry.findBySessionId('nonexistent')).toBeNull();
    });
  });

  describe('abort', () => {
    it('aborts the session and removes it from the registry', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      const abort = new AbortController();

      registry.register('client-1', {
        ws: fakeWs,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.abort('client-1');

      expect(abort.signal.aborted).toBe(true);
      expect(registry.isActive('client-1')).toBe(false);
      expect(registry.get('client-1')).toBeUndefined();
    });

    it('is safe to call for unknown clientId', () => {
      expect(() => registry.abort('nonexistent')).not.toThrow();
    });
  });

  describe('remove', () => {
    it('removes session without aborting', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      const abort = new AbortController();

      registry.register('client-1', {
        ws: fakeWs,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.remove('client-1');

      expect(abort.signal.aborted).toBe(false);
      expect(registry.isActive('client-1')).toBe(false);
    });
  });

  describe('detach timeout', () => {
    it('aborts the session after DETACHED_TTL_MS if not reattached', () => {
      vi.useFakeTimers();

      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      const abort = new AbortController();

      registry.register('client-1', {
        ws: fakeWs,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Not yet expired
      vi.advanceTimersByTime(DETACHED_TTL_MS - 1000);
      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);

      // Now expired
      vi.advanceTimersByTime(2000);
      expect(registry.isActive('client-1')).toBe(false);
      expect(abort.signal.aborted).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('setSessionId', () => {
    it('sets the SDK session ID on a registered session', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.setSessionId('client-1', 'sdk-456');
      expect(registry.get('client-1')!.sessionId).toBe('sdk-456');
    });

    it('is a no-op for unknown clientId', () => {
      expect(() => registry.setSessionId('nonexistent', 'sdk-456')).not.toThrow();
    });
  });

  describe('setMode', () => {
    it('updates the mode on a registered session', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.setMode('client-1', 'auto');
      expect(registry.get('client-1')!.mode).toBe('auto');
    });
  });

  describe('detachedBuffer', () => {
    it('initializes with an empty detachedBuffer', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const session = registry.get('client-1');
      expect(session!.detachedBuffer).toEqual([]);
    });

    it('bufferDetached pushes messages to the buffer', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const msg1 = { type: 'block_start', blockId: 'b0' };
      const msg2 = { type: 'block_delta', blockId: 'b0', delta: 'hello' };

      registry.bufferDetached('client-1', msg1);
      registry.bufferDetached('client-1', msg2);

      const session = registry.get('client-1');
      expect(session!.detachedBuffer).toHaveLength(2);
      expect(session!.detachedBuffer[0]).toBe(msg1);
      expect(session!.detachedBuffer[1]).toBe(msg2);
    });

    it('bufferDetached respects DETACHED_BUFFER_MAX', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      for (let i = 0; i < DETACHED_BUFFER_MAX + 100; i++) {
        registry.bufferDetached('client-1', { type: 'block_delta', i });
      }

      const session = registry.get('client-1');
      expect(session!.detachedBuffer).toHaveLength(DETACHED_BUFFER_MAX);
    });

    it('bufferDetached is a no-op for unknown clientId', () => {
      expect(() => registry.bufferDetached('nonexistent', { type: 'test' })).not.toThrow();
    });

    it('drainDetachedBuffer returns buffered messages and clears the buffer', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const msg1 = { type: 'block_start' };
      const msg2 = { type: 'block_end' };
      registry.bufferDetached('client-1', msg1);
      registry.bufferDetached('client-1', msg2);

      const drained = registry.drainDetachedBuffer('client-1');
      expect(drained).toHaveLength(2);
      expect(drained[0]).toBe(msg1);
      expect(drained[1]).toBe(msg2);

      // Buffer is now empty
      const session = registry.get('client-1');
      expect(session!.detachedBuffer).toHaveLength(0);
    });

    it('drainDetachedBuffer returns empty array for unknown clientId', () => {
      expect(registry.drainDetachedBuffer('nonexistent')).toEqual([]);
    });

    it('drainDetachedBuffer returns empty array when nothing was buffered', () => {
      const fakeWs = { readyState: 1, OPEN: 1 } as any;
      registry.register('client-1', {
        ws: fakeWs,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.drainDetachedBuffer('client-1')).toEqual([]);
    });
  });

  describe('dispose', () => {
    it('clears all detach timers and aborts all sessions', () => {
      const abort1 = new AbortController();
      const abort2 = new AbortController();

      registry.register('client-1', {
        ws: { readyState: 1, OPEN: 1 } as any,
        abortController: abort1,
        mode: 'agent',
        sessionAllowList: new Set(),
      });
      registry.register('client-2', {
        ws: { readyState: 1, OPEN: 1 } as any,
        abortController: abort2,
        mode: 'ask',
        sessionAllowList: new Set(),
      });

      registry.dispose();

      expect(abort1.signal.aborted).toBe(true);
      expect(abort2.signal.aborted).toBe(true);
      expect(registry.isActive('client-1')).toBe(false);
      expect(registry.isActive('client-2')).toBe(false);
    });
  });
});
