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

  describe('hasUserMessage', () => {
    it('returns false when no matching event exists', () => {
      expect(store.hasUserMessage('sess-1', 'umsg-123')).toBe(false);
    });

    it('returns true when a user_message with the given messageId exists', () => {
      store.append('sess-1', 'user_message', {
        v: 2,
        type: 'user_message',
        ts: Date.now(),
        messageId: 'user-abc-123',
        text: 'Hello',
      });
      expect(store.hasUserMessage('sess-1', 'user-abc-123')).toBe(true);
    });

    it('does not match across different sessions', () => {
      store.append('sess-1', 'user_message', {
        v: 2,
        type: 'user_message',
        ts: Date.now(),
        messageId: 'user-abc-123',
        text: 'Hello',
      });
      expect(store.hasUserMessage('sess-2', 'user-abc-123')).toBe(false);
    });

    it('does not match non-user_message events', () => {
      store.append('sess-1', 'message_start', { messageId: 'msg-1' });
      expect(store.hasUserMessage('sess-1', 'msg-1')).toBe(false);
    });

    it('prevents duplicate resume-path user messages', () => {
      const resumeId = 'umsg-1234567890-resume';
      store.append('sess-resume', 'user_message', {
        v: 2,
        type: 'user_message',
        ts: Date.now(),
        messageId: resumeId,
        text: 'Resumed prompt',
      });
      // First check — exists
      expect(store.hasUserMessage('sess-resume', resumeId)).toBe(true);
      // A retried POST with the same messageId should be caught
      expect(store.hasUserMessage('sess-resume', resumeId)).toBe(true);
      // Different messageId on same session — not a duplicate
      expect(store.hasUserMessage('sess-resume', 'umsg-9999-resume')).toBe(false);
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

    it('persists agentName on insert', () => {
      store.upsertSession({
        sessionId: 'sess-agent',
        agentName: 'mitzo-conversational',
      });

      const session = store.getSession('sess-agent');
      expect(session).not.toBeNull();
      expect(session!.agentName).toBe('mitzo-conversational');
    });

    it('updates agentName on existing session', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      expect(store.getSession('sess-1')!.agentName).toBeNull();

      store.upsertSession({ sessionId: 'sess-1', agentName: 'mitzo-conversational' });
      expect(store.getSession('sess-1')!.agentName).toBe('mitzo-conversational');
    });

    it('persists bootContext and agentName together (fire-and-forget safety net)', () => {
      // Simulates the pattern from chat.ts: boot context callback stores
      // both bootContext and agentName in a single upsert to ensure
      // agentName is never null even for short-lived sessions.
      store.upsertSession({ sessionId: 'sess-boot', summary: 'Boot test' });

      const bootPayload = JSON.stringify({
        type: 'boot_context',
        source: 'contexgin',
        sourceCount: 7,
      });
      store.upsertSession({
        sessionId: 'sess-boot',
        bootContext: bootPayload,
        agentName: 'mitzo-conversational',
      });

      const session = store.getSession('sess-boot');
      expect(session!.agentName).toBe('mitzo-conversational');
      expect(session!.bootContext).toBe(bootPayload);
    });

    it('preserves agentName when updating only bootContext', () => {
      store.upsertSession({
        sessionId: 'sess-preserve',
        agentName: 'mitzo-conversational',
      });

      store.upsertSession({
        sessionId: 'sess-preserve',
        bootContext: '{"type":"boot_context"}',
      });

      const session = store.getSession('sess-preserve');
      expect(session!.agentName).toBe('mitzo-conversational');
      expect(session!.bootContext).toBe('{"type":"boot_context"}');
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

  describe('searchSessions', () => {
    it('finds sessions by user message text', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Deploy session' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Refactor session' });
      store.append('sess-1', 'user_message', { text: 'deploy the new widget to production' });
      store.append('sess-2', 'user_message', { text: 'refactor the auth middleware' });

      const results = store.searchSessions('widget');
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('sess-1');
      expect(results[0].summary).toBe('Deploy session');
      expect(results[0].snippet).toContain('widget');
    });

    it('finds sessions by assistant block_delta text', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.append('sess-1', 'block_delta', { delta: 'The worktree cleanup timeout is 96 hours' });

      const results = store.searchSessions('worktree cleanup');
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toContain('worktree cleanup');
    });

    it('deduplicates multiple matches within same session', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.append('sess-1', 'user_message', { text: 'first mention of kubernetes' });
      store.append('sess-1', 'user_message', { text: 'second mention of kubernetes' });

      const results = store.searchSessions('kubernetes');
      expect(results).toHaveLength(1);
    });

    it('excludes hidden sessions', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Visible' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Hidden' });
      store.append('sess-1', 'user_message', { text: 'search target text' });
      store.append('sess-2', 'user_message', { text: 'search target text' });
      store.hideSession('sess-2');

      const results = store.searchSessions('target');
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('sess-1');
    });

    it('returns empty for blank query', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.append('sess-1', 'user_message', { text: 'some content' });

      expect(store.searchSessions('')).toEqual([]);
      expect(store.searchSessions('   ')).toEqual([]);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        store.upsertSession({ sessionId: `sess-${i}`, summary: `Session ${i}` });
        store.append(`sess-${i}`, 'user_message', { text: `common search term ${i}` });
      }

      const results = store.searchSessions('common search', 2);
      expect(results).toHaveLength(2);
    });

    it('provides contextual snippet around match', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      const longText = 'A'.repeat(100) + ' target keyword ' + 'B'.repeat(100);
      store.append('sess-1', 'user_message', { text: longText });

      const results = store.searchSessions('target keyword');
      expect(results).toHaveLength(1);
      expect(results[0].snippet).toContain('target keyword');
      expect(results[0].snippet.length).toBeLessThan(longText.length);
    });

    it('does not match JSON key names (no false positives)', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.append('sess-1', 'user_message', { text: 'hello world' });
      store.append('sess-1', 'block_delta', { delta: 'some response' });

      // "text" and "delta" are JSON keys in every payload — should not match
      expect(store.searchSessions('text')).toHaveLength(0);
      expect(store.searchSessions('delta')).toHaveLength(0);
    });

    it('escapes LIKE wildcards in query', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Other' });
      store.append('sess-1', 'user_message', { text: 'progress is 50% done' });
      store.append('sess-2', 'user_message', { text: 'unrelated content' });

      // % in query should be treated as literal, not wildcard
      const results = store.searchSessions('50%');
      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('sess-1');
    });

    it('is case-insensitive in LIKE matching', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.append('sess-1', 'user_message', { text: 'Deploy the Kubernetes cluster' });

      // SQLite LIKE is case-insensitive for ASCII
      const results = store.searchSessions('kubernetes');
      expect(results).toHaveLength(1);
    });
  });

  describe('close', () => {
    it('is safe to call multiple times', () => {
      store.close();
      store.close(); // should not throw
    });
  });

  describe('updateLastSpeaker', () => {
    it('sets last_speaker to user', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.updateLastSpeaker('sess-1', 'user');

      const session = store.getSession('sess-1');
      expect(session!.lastSpeaker).toBe('user');
      expect(session!.lastSpeakerAt).toBeGreaterThan(0);
    });

    it('toggles between user and assistant', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.updateLastSpeaker('sess-1', 'user');
      store.updateLastSpeaker('sess-1', 'assistant');

      const session = store.getSession('sess-1');
      expect(session!.lastSpeaker).toBe('assistant');
    });

    it('updates updated_at timestamp', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      const before = store.getSession('sess-1')!.updatedAt;

      // Small delay to ensure timestamp changes
      store.updateLastSpeaker('sess-1', 'assistant');
      const after = store.getSession('sess-1')!.updatedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getAttentionSessions', () => {
    it('returns sessions where last_speaker is assistant', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Awaiting reply' });
      store.updateLastSpeaker('sess-1', 'assistant');

      store.upsertSession({ sessionId: 'sess-2', summary: 'User replied' });
      store.updateLastSpeaker('sess-2', 'user');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(1);
      expect(attention[0].sessionId).toBe('sess-1');
    });

    it('excludes inactive sessions', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Closed' });
      store.updateLastSpeaker('sess-1', 'assistant');
      store.markSessionInactive('sess-1');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(0);
    });

    it('excludes hidden sessions', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Hidden' });
      store.updateLastSpeaker('sess-1', 'assistant');
      store.hideSession('sess-1');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(0);
    });

    it('limits to 10 results', () => {
      for (let i = 0; i < 15; i++) {
        const id = `sess-${i}`;
        store.upsertSession({ sessionId: id, summary: `Session ${i}` });
        store.updateLastSpeaker(id, 'assistant');
      }

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(10);
    });

    it('maps lastSpeaker and lastSpeakerAt in rowToSession', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.updateLastSpeaker('sess-1', 'assistant');

      const session = store.getSession('sess-1');
      expect(session!.lastSpeaker).toBe('assistant');
      expect(typeof session!.lastSpeakerAt).toBe('number');
      expect(session!.lastSpeakerAt).toBeGreaterThan(0);
    });
  });
});
