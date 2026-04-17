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
});
