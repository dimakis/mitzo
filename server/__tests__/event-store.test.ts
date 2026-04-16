import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../event-store.js';
import type { StoredEvent } from '../event-store.js';

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('constructor', () => {
    it('creates tables on initialization', () => {
      // If we got here without throwing, tables were created.
      // Verify by appending an event (requires both tables implicitly).
      const seq = store.append('sess-1', 'message_start', { messageId: 'm1' });
      expect(seq).toBe(1);
    });
  });

  describe('append', () => {
    it('returns incrementing sequence numbers', () => {
      const seq1 = store.append('sess-1', 'message_start', { messageId: 'm1' });
      const seq2 = store.append('sess-1', 'block_delta', { delta: 'hello' });
      const seq3 = store.append('sess-1', 'message_end', { messageId: 'm1' });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it('sequence numbers are global across sessions', () => {
      const seq1 = store.append('sess-1', 'message_start', { messageId: 'm1' });
      const seq2 = store.append('sess-2', 'message_start', { messageId: 'm2' });

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
    });

    it('stores correct session_id, type, and payload', () => {
      store.append('sess-1', 'block_delta', { delta: 'hello world' });
      const events = store.getSessionEvents('sess-1');

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe('sess-1');
      expect(events[0].type).toBe('block_delta');
      expect(events[0].payload).toEqual({ delta: 'hello world' });
    });
  });

  describe('getEventsAfter', () => {
    it('returns all events for a session when afterSeq is 0', () => {
      store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-1', 'block_delta', { delta: 'a' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getEventsAfter('sess-1', 0);
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('message_start');
      expect(events[2].type).toBe('message_end');
    });

    it('returns only events after the given seq', () => {
      const seq1 = store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-1', 'block_delta', { delta: 'a' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getEventsAfter('sess-1', seq1);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('block_delta');
    });

    it('does not return events from other sessions', () => {
      store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-2', 'message_start', { messageId: 'm2' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getEventsAfter('sess-1', 0);
      expect(events).toHaveLength(2);
      expect(events.every((e: StoredEvent) => e.sessionId === 'sess-1')).toBe(true);
    });

    it('respects limit parameter', () => {
      store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-1', 'block_delta', { delta: 'a' });
      store.append('sess-1', 'block_delta', { delta: 'b' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getEventsAfter('sess-1', 0, 2);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('block_delta');
    });

    it('returns events ordered by seq', () => {
      store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-2', 'block_delta', { delta: 'x' }); // different session
      store.append('sess-1', 'block_delta', { delta: 'a' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getEventsAfter('sess-1', 0);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
      }
    });
  });

  describe('getSessionEvents', () => {
    it('returns all events for a session', () => {
      store.append('sess-1', 'message_start', { messageId: 'm1' });
      store.append('sess-1', 'message_end', { messageId: 'm1' });

      const events = store.getSessionEvents('sess-1');
      expect(events).toHaveLength(2);
    });

    it('returns empty array for unknown session', () => {
      const events = store.getSessionEvents('nonexistent');
      expect(events).toEqual([]);
    });
  });

  describe('upsertSession', () => {
    it('creates a new session row', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test session' });
      const session = store.getSession('sess-1');

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('sess-1');
      expect(session!.summary).toBe('Test session');
      expect(session!.isActive).toBe(true);
    });

    it('updates existing session (idempotent)', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'First' });
      store.upsertSession({ sessionId: 'sess-1', summary: 'Updated' });

      const session = store.getSession('sess-1');
      expect(session!.summary).toBe('Updated');
    });

    it('persists and retrieves goalId', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.upsertSession({ sessionId: 'sess-1', goalId: 'goal-abc-123' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.goalId).toBe('goal-abc-123');
    });

    it('preserves fields not included in partial update', () => {
      store.upsertSession({
        sessionId: 'sess-1',
        summary: 'Test',
        branch: 'main',
        mode: 'agent',
      });
      store.upsertSession({ sessionId: 'sess-1', summary: 'Updated' });

      const session = store.getSession('sess-1');
      expect(session!.summary).toBe('Updated');
      expect(session!.branch).toBe('main');
      expect(session!.mode).toBe('agent');
    });

    it('persists and retrieves wtId', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test', wtId: 'wt-abc123' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.wtId).toBe('wt-abc123');
    });

    it('updates wtId on existing session', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      expect(store.getSession('sess-1')!.wtId).toBeNull();

      store.upsertSession({ sessionId: 'sess-1', wtId: 'wt-xyz789' });
      expect(store.getSession('sess-1')!.wtId).toBe('wt-xyz789');
    });

    it('persists branch and wtId together on insert', () => {
      store.upsertSession({
        sessionId: 'sess-1',
        branch: 'feat/my-feature',
        wtId: 'wt-session-123',
        mode: 'agent',
      });

      const session = store.getSession('sess-1');
      expect(session!.branch).toBe('feat/my-feature');
      expect(session!.wtId).toBe('wt-session-123');
      expect(session!.mode).toBe('agent');
    });

    it('persists and retrieves cwd', () => {
      store.upsertSession({
        sessionId: 'sess-1',
        cwd: '/Users/dev/repo/.claude/worktrees/2026-04-16-abc123',
        mode: 'agent',
      });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.cwd).toBe('/Users/dev/repo/.claude/worktrees/2026-04-16-abc123');
    });

    it('resume CWD lookup: getSession returns original cwd for worktree sessions', () => {
      // Simulates the pattern used in startChat for resume: store the
      // worktree CWD at session creation, retrieve it when resuming.
      const worktreeCwd = '/Users/dev/repo/.claude/worktrees/2026-04-16-abc123';
      store.upsertSession({
        sessionId: 'sess-resume',
        cwd: worktreeCwd,
        branch: 'session/2026-04-16-abc123',
        wtId: '2026-04-16-abc123',
        mode: 'agent',
      });

      // Later: resume looks up the session to get the original CWD
      const meta = store.getSession('sess-resume');
      expect(meta).not.toBeNull();
      expect(meta!.cwd).toBe(worktreeCwd);
      expect(meta!.wtId).toBe('2026-04-16-abc123');
    });

    it('returns null cwd when session was created without one', () => {
      store.upsertSession({ sessionId: 'sess-no-cwd', summary: 'No CWD' });

      const session = store.getSession('sess-no-cwd');
      expect(session).not.toBeNull();
      expect(session!.cwd).toBeNull();
    });
  });

  describe('getSession', () => {
    it('returns null for unknown session', () => {
      const session = store.getSession('nonexistent');
      expect(session).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('returns sessions ordered by updated_at desc', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'First' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Second' });
      // Update sess-1 to make it most recent
      store.upsertSession({ sessionId: 'sess-1', summary: 'First updated' });

      const sessions = store.listSessions();
      expect(sessions[0].sessionId).toBe('sess-1');
      expect(sessions[1].sessionId).toBe('sess-2');
    });

    it('respects limit parameter', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      store.upsertSession({ sessionId: 'sess-2' });
      store.upsertSession({ sessionId: 'sess-3' });

      const sessions = store.listSessions(2);
      expect(sessions).toHaveLength(2);
    });

    it('excludes hidden sessions', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Visible' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Hidden' });
      store.hideSession('sess-2');

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-1');
    });
  });

  describe('markSessionInactive', () => {
    it('sets is_active to false', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      expect(store.getSession('sess-1')!.isActive).toBe(true);

      store.markSessionInactive('sess-1');
      expect(store.getSession('sess-1')!.isActive).toBe(false);
    });
  });

  describe('hideSession', () => {
    it('hides session from listing but events survive', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      store.append('sess-1', 'message_start', { messageId: 'm1' });

      store.hideSession('sess-1');

      // Not in listing
      expect(store.listSessions()).toHaveLength(0);
      // But events still exist
      expect(store.getSessionEvents('sess-1')).toHaveLength(1);
      // And session metadata still retrievable directly
      expect(store.getSession('sess-1')).not.toBeNull();
    });
  });

  describe('close', () => {
    it('is safe to call multiple times', () => {
      store.close();
      store.close(); // should not throw
    });
  });
});
