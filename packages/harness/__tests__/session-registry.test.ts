import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import {
  DETACHED_TTL_MS,
  CLOSEOUT_LEAD_MS,
  CLOSEOUT_TIMEOUT_MS,
  SUSPEND_GRACE_MS,
  SUSPEND_BUFFER_MAX,
} from '../src/constants.js';
import type { SessionTransport } from '../src/session-transport.js';

function fakeTransport(): SessionTransport {
  return { send: vi.fn(), isOpen: () => true };
}

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
      const transport = fakeTransport();
      const abort = new AbortController();
      registry.register('client-1', {
        transport,
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.get('client-1')).toBeDefined();
      expect(registry.get('client-1')!.transport).toBe(transport);
    });

    it('marks session as attached on registration', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.isAttached('client-1')).toBe(true);
    });

    it('isActive returns true for registered session', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.isActive('client-1')).toBe(true);
    });

    it('isActive returns false for unknown clientId', () => {
      expect(registry.isActive('nonexistent')).toBe(false);
    });

    it('initializes worktreePaths as empty Map', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const session = registry.get('client-1')!;
      expect(session.worktreePaths).toBeInstanceOf(Map);
      expect(session.worktreePaths.size).toBe(0);
    });

    it('worktreePaths stores path and wtId', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const session = registry.get('client-1')!;
      session.worktreePaths.set('team_home', {
        path: '/tmp/team_home-sessions/session-wt-abc',
        wtId: 'wt-abc',
      });
      const entry = session.worktreePaths.get('team_home')!;
      expect(entry.path).toBe('/tmp/team_home-sessions/session-wt-abc');
      expect(entry.wtId).toBe('wt-abc');
    });
  });

  describe('detach', () => {
    it('detaches a session without aborting it', () => {
      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
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
      registry.register('client-1', {
        transport: fakeTransport(),
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
    it('reattaches a new transport to a detached session', () => {
      const oldTransport = fakeTransport();
      const newTransport = fakeTransport();

      registry.register('client-1', {
        transport: oldTransport,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-session-abc',
      });

      registry.detach('client-1');
      const reattached = registry.reattach('client-1', newTransport);

      expect(reattached).toBe(true);
      expect(registry.isAttached('client-1')).toBe(true);
      expect(registry.get('client-1')!.transport).toBe(newTransport);
    });

    it('returns false for unknown clientId', () => {
      expect(registry.reattach('nonexistent', fakeTransport())).toBe(false);
    });

    it('works on already-attached session (transport swap)', () => {
      const t1 = fakeTransport();
      const t2 = fakeTransport();

      registry.register('client-1', {
        transport: t1,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const reattached = registry.reattach('client-1', t2);
      expect(reattached).toBe(true);
      expect(registry.get('client-1')!.transport).toBe(t2);
    });

    it('cancels the detach timeout when reattaching', () => {
      vi.useFakeTimers();

      const abort = new AbortController();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Reattach before timeout fires
      registry.reattach('client-1', fakeTransport());

      // Advance past the TTL — session should still be alive
      vi.advanceTimersByTime(DETACHED_TTL_MS + 1000);

      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('rekey', () => {
    it('moves session from old to new key', () => {
      const transport = fakeTransport();
      registry.register('old-id', {
        transport,
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const result = registry.rekey('old-id', 'new-id');
      expect(result).toBe(true);
      expect(registry.get('old-id')).toBeUndefined();
      expect(registry.get('new-id')!.transport).toBe(transport);
    });

    it('preserves attached status', () => {
      registry.register('old-id', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.rekey('old-id', 'new-id');
      expect(registry.isAttached('new-id')).toBe(true);
      expect(registry.isAttached('old-id')).toBe(false);
    });

    it('returns false for unknown old key', () => {
      expect(registry.rekey('nonexistent', 'new-id')).toBe(false);
    });
  });

  describe('findBySessionId', () => {
    it('finds a session by its SDK session ID', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
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
      const abort = new AbortController();

      registry.register('client-1', {
        transport: fakeTransport(),
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
      const abort = new AbortController();

      registry.register('client-1', {
        transport: fakeTransport(),
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

      const abort = new AbortController();

      registry.register('client-1', {
        transport: fakeTransport(),
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
      registry.register('client-1', {
        transport: fakeTransport(),
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
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.setMode('client-1', 'auto');
      expect(registry.get('client-1')!.mode).toBe('auto');
    });
  });

  describe('observers', () => {
    it('initializes observers as empty Set', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.get('client-1')!.observers).toBeInstanceOf(Set);
      expect(registry.get('client-1')!.observers.size).toBe(0);
    });

    it('addObserver adds transport to session found by sessionId', () => {
      const observer = fakeTransport();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-abc',
      });

      const result = registry.addObserver('sdk-abc', observer);
      expect(result).toBe('client-1');
      expect(registry.get('client-1')!.observers.has(observer)).toBe(true);
    });

    it('addObserver returns null for unknown sessionId', () => {
      expect(registry.addObserver('nonexistent', fakeTransport())).toBeNull();
    });

    it('removeObserver removes transport from all sessions', () => {
      const observer = fakeTransport();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-abc',
      });
      registry.addObserver('sdk-abc', observer);

      registry.removeObserver(observer);
      expect(registry.get('client-1')!.observers.has(observer)).toBe(false);
    });

    it('abort clears observers', () => {
      const observer = fakeTransport();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-abc',
      });
      registry.addObserver('sdk-abc', observer);

      registry.abort('client-1');
      expect(registry.get('client-1')).toBeUndefined();
    });

    it('remove clears observers', () => {
      const observer = fakeTransport();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-abc',
      });
      registry.addObserver('sdk-abc', observer);

      registry.remove('client-1');
      expect(registry.get('client-1')).toBeUndefined();
    });
  });

  describe('getActiveSessions', () => {
    it('returns empty array when no sessions exist', () => {
      expect(registry.getActiveSessions()).toEqual([]);
    });

    it('returns serializable snapshot of all active sessions', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-abc',
        cwd: '/tmp/repo',
      });

      const active = registry.getActiveSessions();
      expect(active).toHaveLength(1);
      expect(active[0]).toEqual({
        clientId: 'client-1',
        sessionId: 'sdk-abc',
        mode: 'agent',
        cwd: '/tmp/repo',
        attached: true,
        cumulativeSessionTokens: 0,
        cumulativeCostUsd: 0,
        hasSnapshot: false,
        taskContext: null,
        observerCount: 0,
      });
    });

    it('reflects detached state', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'auto',
        sessionAllowList: new Set(),
        sessionId: 'sdk-xyz',
      });

      registry.detach('client-1');
      const active = registry.getActiveSessions();
      expect(active[0].attached).toBe(false);
    });

    it('includes token and cost data', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const session = registry.get('client-1')!;
      session.cumulativeSessionTokens = 5000;
      session.cumulativeCostUsd = 0.15;

      const active = registry.getActiveSessions();
      expect(active[0].cumulativeSessionTokens).toBe(5000);
      expect(active[0].cumulativeCostUsd).toBe(0.15);
    });

    it('includes observer count', () => {
      const observer = fakeTransport();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-obs',
      });

      registry.addObserver('sdk-obs', observer);
      const active = registry.getActiveSessions();
      expect(active[0].observerCount).toBe(1);
    });

    it('reports hasSnapshot when snapshot exists', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const session = registry.get('client-1')!;
      session.currentSnapshot = { messageId: 'msg-1', blocks: [] };

      const active = registry.getActiveSessions();
      expect(active[0].hasSnapshot).toBe(true);
    });

    it('returns multiple sessions', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
        sessionId: 'sdk-1',
      });
      registry.register('client-2', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'ask',
        sessionAllowList: new Set(),
        sessionId: 'sdk-2',
      });

      const active = registry.getActiveSessions();
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.sessionId)).toContain('sdk-1');
      expect(active.map((s) => s.sessionId)).toContain('sdk-2');
    });
  });

  describe('closeout', () => {
    it('calls onCloseout handler before TTL expiry', () => {
      vi.useFakeTimers();
      const onCloseout = vi.fn();
      registry.setCloseoutHandler(onCloseout);

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to just before closeout fires (TTL - LEAD)
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS - 1000);
      expect(onCloseout).not.toHaveBeenCalled();

      // Advance past closeout trigger
      vi.advanceTimersByTime(2000);
      expect(onCloseout).toHaveBeenCalledWith('client-1');
      expect(registry.isClosingOut('client-1')).toBe(true);

      vi.useRealTimers();
    });

    it('aborts session after CLOSEOUT_TIMEOUT_MS if closeout completes or times out', () => {
      vi.useFakeTimers();
      const onCloseout = vi.fn();
      registry.setCloseoutHandler(onCloseout);

      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to closeout
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS + 100);
      expect(registry.isClosingOut('client-1')).toBe(true);

      // Advance through closeout timeout
      vi.advanceTimersByTime(CLOSEOUT_TIMEOUT_MS + 100);
      expect(registry.isActive('client-1')).toBe(false);
      expect(abort.signal.aborted).toBe(true);

      vi.useRealTimers();
    });

    it('cancels closeout on reattach', () => {
      vi.useFakeTimers();
      const onCloseout = vi.fn();
      registry.setCloseoutHandler(onCloseout);

      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to closeout
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS + 100);
      expect(registry.isClosingOut('client-1')).toBe(true);

      // Reattach during closeout
      registry.reattach('client-1', fakeTransport());
      expect(registry.isClosingOut('client-1')).toBe(false);

      // Advance well past timeout — session should still be alive
      vi.advanceTimersByTime(CLOSEOUT_TIMEOUT_MS + DETACHED_TTL_MS);
      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);

      vi.useRealTimers();
    });

    it('isClosingOut is true when abort signal fires during closeout', () => {
      vi.useFakeTimers();
      const onCloseout = vi.fn();
      registry.setCloseoutHandler(onCloseout);

      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to closeout
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS + 100);
      expect(registry.isClosingOut('client-1')).toBe(true);

      // Listen for the abort signal and capture closingOut state at that moment
      let closingOutDuringAbort: boolean | undefined;
      abort.signal.addEventListener('abort', () => {
        closingOutDuringAbort = registry.isClosingOut('client-1');
      });

      // Advance through closeout timeout — triggers abort()
      vi.advanceTimersByTime(CLOSEOUT_TIMEOUT_MS + 100);
      expect(abort.signal.aborted).toBe(true);
      // The listener must see isClosingOut=true so it can distinguish abandoned vs closed
      expect(closingOutDuringAbort).toBe(true);

      vi.useRealTimers();
    });

    it('reports isClosingOut=true during direct abort() mid-closeout', () => {
      vi.useFakeTimers();

      const abort = new AbortController();
      let closingOutDuringAbort = false;
      abort.signal.addEventListener('abort', () => {
        closingOutDuringAbort = registry.isClosingOut('client-1');
      });

      registry.setCloseoutHandler(() => {});
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to closeout phase
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS + 100);
      expect(registry.isClosingOut('client-1')).toBe(true);

      // Direct abort (e.g., user stops session mid-closeout)
      registry.abort('client-1');
      expect(abort.signal.aborted).toBe(true);
      expect(closingOutDuringAbort).toBe(true);
      expect(registry.isActive('client-1')).toBe(false);
      expect(registry.isClosingOut('client-1')).toBe(false);

      vi.useRealTimers();
    });

    it('cleans up closingOut when remove() is called during closeout', () => {
      vi.useFakeTimers();

      registry.setCloseoutHandler(() => {});
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance to closeout phase
      vi.advanceTimersByTime(DETACHED_TTL_MS - CLOSEOUT_LEAD_MS + 100);
      expect(registry.isClosingOut('client-1')).toBe(true);

      // Natural completion during closeout
      registry.remove('client-1');
      expect(registry.isClosingOut('client-1')).toBe(false);
      expect(registry.isActive('client-1')).toBe(false);

      vi.useRealTimers();
    });

    it('falls back to direct abort when no closeout handler is set', () => {
      vi.useFakeTimers();

      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');

      // Advance past full TTL
      vi.advanceTimersByTime(DETACHED_TTL_MS + 100);
      expect(registry.isActive('client-1')).toBe(false);
      expect(abort.signal.aborted).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('dispose', () => {
    it('clears all detach timers and aborts all sessions', () => {
      const abort1 = new AbortController();
      const abort2 = new AbortController();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort1,
        mode: 'agent',
        sessionAllowList: new Set(),
      });
      registry.register('client-2', {
        transport: fakeTransport(),
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

  describe('suspend', () => {
    it('marks session as suspended', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 42);
      expect(registry.isSuspended('client-1')).toBe(true);
    });

    it('starts grace timer that transitions to detach on expiry', () => {
      vi.useFakeTimers();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);

      // Still suspended before grace period
      vi.advanceTimersByTime(SUSPEND_GRACE_MS - 1000);
      expect(registry.isSuspended('client-1')).toBe(true);

      // Grace expired — transitions to detach
      vi.advanceTimersByTime(2000);
      expect(registry.isSuspended('client-1')).toBe(false);
      expect(registry.isAttached('client-1')).toBe(false);
      expect(registry.isActive('client-1')).toBe(true); // detached, not aborted

      vi.useRealTimers();
    });

    it('clears detach timer when suspending (suspend takes precedence)', () => {
      vi.useFakeTimers();

      const abort = new AbortController();
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: abort,
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.detach('client-1');
      registry.suspend('client-1', 0);

      // Advance past the full detach TTL — session should still be alive
      // because suspend cleared the detach timer and manages its own grace
      vi.advanceTimersByTime(SUSPEND_GRACE_MS + 1000);
      // Grace expired → detach fires, but session is still active (just detached)
      expect(registry.isActive('client-1')).toBe(true);
      expect(abort.signal.aborted).toBe(false);

      vi.useRealTimers();
    });

    it('resume returns buffered events and clears suspend state', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.bufferEvent('client-1', { type: 'block_delta', delta: 'hello' });
      registry.bufferEvent('client-1', { type: 'block_end' });

      const buffer = registry.resume('client-1');
      expect(buffer).toHaveLength(2);
      expect(buffer[0]).toEqual({ type: 'block_delta', delta: 'hello' });
      expect(buffer[1]).toEqual({ type: 'block_end' });
      expect(registry.isSuspended('client-1')).toBe(false);
    });

    it('resume clears grace timer', () => {
      vi.useFakeTimers();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.resume('client-1');

      // Advance past grace — should not transition to detach
      vi.advanceTimersByTime(SUSPEND_GRACE_MS + 1000);
      expect(registry.isAttached('client-1')).toBe(true);

      vi.useRealTimers();
    });

    it('resume returns empty array when no events buffered', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      const buffer = registry.resume('client-1');
      expect(buffer).toEqual([]);
    });

    it('resume returns empty array for non-suspended session', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      const buffer = registry.resume('client-1');
      expect(buffer).toEqual([]);
    });

    it('bufferEvent returns false when buffer is full', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);

      // Fill buffer to capacity
      for (let i = 0; i < SUSPEND_BUFFER_MAX; i++) {
        expect(registry.bufferEvent('client-1', { type: 'event', i })).toBe(true);
      }

      // One more should fail
      expect(registry.bufferEvent('client-1', { type: 'overflow' })).toBe(false);

      // Buffer contains exactly SUSPEND_BUFFER_MAX items
      const buffer = registry.resume('client-1');
      expect(buffer).toHaveLength(SUSPEND_BUFFER_MAX);
    });

    it('bufferEvent returns false for non-suspended session', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      expect(registry.bufferEvent('client-1', { type: 'event' })).toBe(false);
    });

    it('reattach clears suspend state', () => {
      vi.useFakeTimers();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.bufferEvent('client-1', { type: 'event' });

      registry.reattach('client-1', fakeTransport());
      expect(registry.isSuspended('client-1')).toBe(false);

      // Grace timer should be cancelled
      vi.advanceTimersByTime(SUSPEND_GRACE_MS + 1000);
      expect(registry.isAttached('client-1')).toBe(true);

      vi.useRealTimers();
    });

    it('detach skips if already suspended', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.detach('client-1');

      // Should still be suspended, not transitioned to detach
      expect(registry.isSuspended('client-1')).toBe(true);
    });

    it('abort cleans up suspend state', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.bufferEvent('client-1', { type: 'event' });

      registry.abort('client-1');
      expect(registry.isSuspended('client-1')).toBe(false);
    });

    it('remove cleans up suspend state', () => {
      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.remove('client-1');
      expect(registry.isSuspended('client-1')).toBe(false);
    });

    it('dispose cleans up suspend state', () => {
      vi.useFakeTimers();

      registry.register('client-1', {
        transport: fakeTransport(),
        abortController: new AbortController(),
        mode: 'agent',
        sessionAllowList: new Set(),
      });

      registry.suspend('client-1', 0);
      registry.dispose();

      // Grace timer should not fire after dispose
      vi.advanceTimersByTime(SUSPEND_GRACE_MS + 1000);
      expect(registry.isSuspended('client-1')).toBe(false);

      vi.useRealTimers();
    });

    it('isSuspended returns false for unknown clientId', () => {
      expect(registry.isSuspended('nonexistent')).toBe(false);
    });
  });
});
