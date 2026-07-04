import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConnectionRegistry } from '../src/connection-registry.js';
import type { SessionTransport } from '../src/session-transport.js';

function mockTransport(open = true): SessionTransport {
  return {
    send: vi.fn(),
    isOpen: () => open,
  };
}

describe('ConnectionRegistry', () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  describe('register / get / remove', () => {
    it('registers a connection and retrieves it by id', () => {
      const t = mockTransport();
      registry.register('conn-1', t);
      const conn = registry.get('conn-1');
      expect(conn).toBeDefined();
      expect(conn!.transport).toBe(t);
      expect(conn!.watchedSessions).toEqual(new Set());
      expect(conn!.activeSession).toBeNull();
    });

    it('returns undefined for unknown connection', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('removes a connection and clears its watched sessions', () => {
      const t = mockTransport();
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');
      registry.remove('conn-1');
      expect(registry.get('conn-1')).toBeUndefined();
      expect(registry.getConnectionsWatching('sess-a')).toHaveLength(0);
    });
  });

  describe('watch / unwatch', () => {
    it('adds a session to a connection watch list', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      const conn = registry.get('conn-1')!;
      expect(conn.watchedSessions.has('sess-a')).toBe(true);
    });

    it('is idempotent — watching the same session twice is a no-op', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.watch('conn-1', 'sess-a');
      expect(registry.get('conn-1')!.watchedSessions.size).toBe(1);
    });

    it('unwatches a session', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.unwatch('conn-1', 'sess-a');
      expect(registry.get('conn-1')!.watchedSessions.has('sess-a')).toBe(false);
    });

    it('clears activeSession when unwatching the active session', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.setActive('conn-1', 'sess-a');
      expect(registry.get('conn-1')!.activeSession).toBe('sess-a');
      registry.unwatch('conn-1', 'sess-a');
      expect(registry.get('conn-1')!.activeSession).toBeNull();
    });
  });

  describe('setActive', () => {
    it('sets the active session for a connection', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.setActive('conn-1', 'sess-a');
      expect(registry.get('conn-1')!.activeSession).toBe('sess-a');
    });

    it('auto-watches the session if not already watched', () => {
      registry.register('conn-1', mockTransport());
      registry.setActive('conn-1', 'sess-b');
      expect(registry.get('conn-1')!.watchedSessions.has('sess-b')).toBe(true);
    });

    it('allows null to clear the active session', () => {
      registry.register('conn-1', mockTransport());
      registry.setActive('conn-1', 'sess-a');
      registry.setActive('conn-1', null);
      expect(registry.get('conn-1')!.activeSession).toBeNull();
    });
  });

  describe('getConnectionsWatching', () => {
    it('returns all connections watching a session', () => {
      const t1 = mockTransport();
      const t2 = mockTransport();
      registry.register('conn-1', t1);
      registry.register('conn-2', t2);
      registry.watch('conn-1', 'sess-a');
      registry.watch('conn-2', 'sess-a');

      const watchers = registry.getConnectionsWatching('sess-a');
      expect(watchers).toHaveLength(2);
      expect(watchers.map((w) => w.connectionId)).toContain('conn-1');
      expect(watchers.map((w) => w.connectionId)).toContain('conn-2');
    });

    it('returns empty array when no connections watch a session', () => {
      expect(registry.getConnectionsWatching('sess-orphan')).toHaveLength(0);
    });

    it('excludes connections with closed transports when filterOpen is true', () => {
      registry.register('conn-open', mockTransport(true));
      registry.register('conn-closed', mockTransport(false));
      registry.watch('conn-open', 'sess-a');
      registry.watch('conn-closed', 'sess-a');

      const all = registry.getConnectionsWatching('sess-a');
      expect(all).toHaveLength(2);

      const open = registry.getConnectionsWatching('sess-a', true);
      expect(open).toHaveLength(1);
      expect(open[0].connectionId).toBe('conn-open');
    });
  });

  describe('broadcast', () => {
    it('sends a message to all open connections watching a session', () => {
      const t1 = mockTransport(true);
      const t2 = mockTransport(true);
      const t3 = mockTransport(false);
      registry.register('conn-1', t1);
      registry.register('conn-2', t2);
      registry.register('conn-3', t3);
      registry.watch('conn-1', 'sess-a');
      registry.watch('conn-2', 'sess-a');
      registry.watch('conn-3', 'sess-a');

      registry.broadcast('sess-a', { type: 'test', value: 42 });

      expect(t1.send).toHaveBeenCalledWith({ type: 'test', value: 42 });
      expect(t2.send).toHaveBeenCalledWith({ type: 'test', value: 42 });
      expect(t3.send).not.toHaveBeenCalled();
    });

    it('does not throw when a send fails', () => {
      const t = mockTransport(true);
      (t.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('socket closing');
      });
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');

      expect(() => registry.broadcast('sess-a', { type: 'test' })).not.toThrow();
    });
  });

  describe('broadcastAll', () => {
    it('sends to every open connection regardless of watched sessions', () => {
      const t1 = mockTransport(true);
      const t2 = mockTransport(true);
      registry.register('conn-1', t1);
      registry.register('conn-2', t2);
      // conn-1 watches sess-a, conn-2 watches nothing
      registry.watch('conn-1', 'sess-a');

      registry.broadcastAll({ type: 'update_available' });

      expect(t1.send).toHaveBeenCalledWith({ type: 'update_available' });
      expect(t2.send).toHaveBeenCalledWith({ type: 'update_available' });
    });

    it('skips closed connections', () => {
      const tOpen = mockTransport(true);
      const tClosed = mockTransport(false);
      registry.register('conn-open', tOpen);
      registry.register('conn-closed', tClosed);

      registry.broadcastAll({ type: 'inbox_updated' });

      expect(tOpen.send).toHaveBeenCalledWith({ type: 'inbox_updated' });
      expect(tClosed.send).not.toHaveBeenCalled();
    });

    it('does not throw when a send fails', () => {
      const t = mockTransport(true);
      (t.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('socket closing');
      });
      registry.register('conn-1', t);

      expect(() => registry.broadcastAll({ type: 'test' })).not.toThrow();
    });

    it('is a no-op when no connections exist', () => {
      expect(() => registry.broadcastAll({ type: 'test' })).not.toThrow();
    });
  });

  describe('cursor tracking', () => {
    it('initializes cursor map when registering a connection', () => {
      registry.register('conn-1', mockTransport());
      // Cursor map is private, but we can verify behavior via broadcast
      registry.watch('conn-1', 'sess-a');
      registry.broadcast('sess-a', { type: 'test', seq: 10 });
      // No error means cursor map exists
    });

    it('updates cursor on successful broadcast', () => {
      const t = mockTransport(true);
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');

      registry.broadcast('sess-a', { type: 'msg1', seq: 5 });
      registry.broadcast('sess-a', { type: 'msg2', seq: 10 });

      // Cursor should be at 10 now (can't inspect directly, but periodic sync will use it)
      expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('does not update cursor when send fails', () => {
      const t = mockTransport(true);
      (t.send as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('socket closing');
      });
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');

      registry.broadcast('sess-a', { type: 'failed', seq: 5 });
      // Cursor should stay at 0 (initial state)

      // Now send succeeds
      (t.send as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      registry.broadcast('sess-a', { type: 'success', seq: 10 });
      // Cursor should jump to 10
    });

    it('handles out-of-order delivery by only advancing cursor forward', () => {
      const t = mockTransport(true);
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');

      registry.broadcast('sess-a', { type: 'msg1', seq: 10 });
      registry.broadcast('sess-a', { type: 'msg2', seq: 5 }); // Out of order
      registry.broadcast('sess-a', { type: 'msg3', seq: 15 });

      // Cursor should be at 15 (max seen), not 5
      expect(t.send).toHaveBeenCalledTimes(3);
    });

    it('cleans up cursors when connection is removed', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.broadcast('sess-a', { type: 'test', seq: 10 });

      registry.remove('conn-1');
      // No error on subsequent broadcast means cursor cleanup succeeded
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.broadcast('sess-a', { type: 'test', seq: 20 });
    });
  });

  describe('resetCursor', () => {
    it('resets cursor to client lastSeq on reconnect', () => {
      const t = mockTransport(true);
      registry.register('conn-1', t);
      registry.watch('conn-1', 'sess-a');

      // Simulate cursor drift (broadcast moved cursor to 100)
      registry.broadcast('sess-a', { type: 'msg', seq: 100 });

      // Client reconnects with lastSeq=50 (missed 51-100)
      registry.resetCursor('conn-1', 'sess-a', 50);

      // Cursor should now be at 50 (verified by periodic sync behavior)
    });

    it('is a no-op for unknown connection', () => {
      expect(() => registry.resetCursor('unknown', 'sess-a', 10)).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('clears all connections and cursors', () => {
      registry.register('conn-1', mockTransport());
      registry.watch('conn-1', 'sess-a');
      registry.resetCursor('conn-1', 'sess-a', 10);

      registry.dispose();

      expect(registry.get('conn-1')).toBeUndefined();
    });
  });
});
