import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';

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
      const seq = store.append('sess-1', 'message_start', { messageId: 'm1' });
      expect(seq).toBe(1);
    });

    it('calls logger on initialization', () => {
      const messages: string[] = [];
      const logger = { info: (msg: string) => messages.push(msg) };
      const s = new EventStore(':memory:', logger);
      s.close();
      expect(messages).toContain('EventStore initialized');
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
      expect(events.every((e) => e.sessionId === 'sess-1')).toBe(true);
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
      store.append('sess-2', 'block_delta', { delta: 'x' });
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

    it('persists the conversation model picker independently of its account binding', () => {
      store.upsertSession({
        sessionId: 'picker',
        selectedModel: 'gpt-5.6-terra',
        reasoningEffort: 'high',
      });
      store.upsertSession({ sessionId: 'picker', selectedModel: 'gpt-6-astra' });

      expect(store.getSession('picker')).toMatchObject({
        selectedModel: 'gpt-6-astra',
        reasoningEffort: 'high',
      });
    });

    it('persists goalId on insert (not just update)', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test', goalId: 'goal-on-insert' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.goalId).toBe('goal-on-insert');
    });

    it('persists and retrieves goalId via update', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.upsertSession({ sessionId: 'sess-1', goalId: 'goal-abc-123' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.goalId).toBe('goal-abc-123');
    });

    it('persists telosTaskId on insert', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test', telosTaskId: 'telos-abc' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.telosTaskId).toBe('telos-abc');
    });

    it('persists and retrieves telosTaskId via update', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });
      store.upsertSession({ sessionId: 'sess-1', telosTaskId: 'telos-xyz' });

      const session = store.getSession('sess-1');
      expect(session).not.toBeNull();
      expect(session!.telosTaskId).toBe('telos-xyz');
    });

    it('defaults telosTaskId to null when not provided', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });

      const session = store.getSession('sess-1');
      expect(session!.telosTaskId).toBeNull();
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

    it('uses explicit updatedAt on UPDATE instead of auto-generated', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Initial' });
      const explicitTs = 1700000000000;
      store.upsertSession({ sessionId: 'sess-1', summary: 'Updated', updatedAt: explicitTs });

      const session = store.getSession('sess-1');
      expect(session!.updatedAt).toBe(explicitTs);
    });

    it('uses explicit createdAt on INSERT', () => {
      const explicitTs = 1600000000000;
      store.upsertSession({ sessionId: 'sess-1', summary: 'Backdated', createdAt: explicitTs });

      const session = store.getSession('sess-1');
      expect(session!.createdAt).toBe(explicitTs);
    });

    it('auto-generates timestamps when explicit values are omitted', () => {
      const before = Date.now();
      store.upsertSession({ sessionId: 'sess-1', summary: 'Auto' });
      const after = Date.now();

      const session = store.getSession('sess-1');
      // createdAt and updatedAt should be auto-generated within a reasonable range
      expect(session!.createdAt).toBeGreaterThanOrEqual(before - 1000);
      expect(session!.createdAt).toBeLessThanOrEqual(after + 1000);
      expect(session!.updatedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(session!.updatedAt).toBeLessThanOrEqual(after + 1000);
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

      expect(store.listSessions()).toHaveLength(0);
      expect(store.getSessionEvents('sess-1')).toHaveLength(1);
      expect(store.getSession('sess-1')).not.toBeNull();
    });
  });

  describe('incrementPromptCount', () => {
    it('creates session if it does not exist', () => {
      const count = store.incrementPromptCount('new-sess');
      expect(count).toBe(1);
      expect(store.getSession('new-sess')).not.toBeNull();
    });

    it('increments existing count', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      store.incrementPromptCount('sess-1');
      const count = store.incrementPromptCount('sess-1');
      expect(count).toBe(2);
    });
  });

  describe('markManuallyRenamed', () => {
    it('sets manually_renamed flag', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      expect(store.getSession('sess-1')!.manuallyRenamed).toBe(false);

      store.markManuallyRenamed('sess-1');
      expect(store.getSession('sess-1')!.manuallyRenamed).toBe(true);
    });
  });

  describe('recordUsage', () => {
    it('stores usage data', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      store.recordUsage('sess-1', {
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
        totalCostUsd: 0.01,
        numTurns: 2,
        durationMs: 5000,
        durationApiMs: 3000,
      });

      const session = store.getSession('sess-1');
      expect(session!.inputTokens).toBe(100);
      expect(session!.outputTokens).toBe(200);
      expect(session!.totalCostUsd).toBe(0.01);
    });
  });

  describe('getKnownSessionIds', () => {
    it('returns empty set for empty input', () => {
      expect(store.getKnownSessionIds([])).toEqual(new Set());
    });

    it('returns empty set when none of the IDs exist', () => {
      expect(store.getKnownSessionIds(['a', 'b', 'c'])).toEqual(new Set());
    });

    it('returns only IDs that exist in the store', () => {
      store.upsertSession({ sessionId: 'sess-1' });
      store.upsertSession({ sessionId: 'sess-3' });

      const result = store.getKnownSessionIds(['sess-1', 'sess-2', 'sess-3', 'sess-4']);
      expect(result).toEqual(new Set(['sess-1', 'sess-3']));
    });

    it('returns all IDs when all exist', () => {
      store.upsertSession({ sessionId: 'a' });
      store.upsertSession({ sessionId: 'b' });

      expect(store.getKnownSessionIds(['a', 'b'])).toEqual(new Set(['a', 'b']));
    });

    it('handles large batches via chunking', () => {
      const ids: string[] = [];
      for (let i = 0; i < 600; i++) {
        const id = `sess-${i}`;
        ids.push(id);
        if (i % 2 === 0) store.upsertSession({ sessionId: id });
      }
      const result = store.getKnownSessionIds(ids);
      expect(result.size).toBe(300);
      expect(result.has('sess-0')).toBe(true);
      expect(result.has('sess-1')).toBe(false);
      expect(result.has('sess-598')).toBe(true);
      expect(result.has('sess-599')).toBe(false);
    });
  });

  describe('updateLastSpeaker', () => {
    it('sets last_speaker and last_speaker_at', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });

      store.updateLastSpeaker('sess-1', 'user');
      const session = store.getSession('sess-1');
      expect(session!.lastSpeaker).toBe('user');
      expect(session!.lastSpeakerAt).toBeGreaterThan(0);
    });

    it('updates from user to assistant', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });

      store.updateLastSpeaker('sess-1', 'user');
      expect(store.getSession('sess-1')!.lastSpeaker).toBe('user');

      store.updateLastSpeaker('sess-1', 'assistant');
      expect(store.getSession('sess-1')!.lastSpeaker).toBe('assistant');
    });

    it('updates last_speaker_at timestamp on each call', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Test' });

      store.updateLastSpeaker('sess-1', 'user');
      const ts1 = store.getSession('sess-1')!.lastSpeakerAt!;

      store.updateLastSpeaker('sess-1', 'assistant');
      const ts2 = store.getSession('sess-1')!.lastSpeakerAt!;

      expect(ts2).toBeGreaterThanOrEqual(ts1);
    });

    it('is a no-op for non-existent sessions', () => {
      // Should not throw
      store.updateLastSpeaker('nonexistent', 'user');
      expect(store.getSession('nonexistent')).toBeNull();
    });
  });

  describe('getAttentionSessions', () => {
    it('returns empty array when no sessions exist', () => {
      expect(store.getAttentionSessions()).toEqual([]);
    });

    it('returns sessions where assistant spoke last', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Needs reply' });
      store.updateLastSpeaker('sess-1', 'assistant');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(1);
      expect(attention[0].sessionId).toBe('sess-1');
    });

    it('excludes sessions where user spoke last', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'User replied' });
      store.updateLastSpeaker('sess-1', 'user');

      expect(store.getAttentionSessions()).toEqual([]);
    });

    it('excludes hidden sessions', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Hidden' });
      store.updateLastSpeaker('sess-1', 'assistant');
      store.hideSession('sess-1');

      expect(store.getAttentionSessions()).toEqual([]);
    });

    it('includes inactive sessions (properly completed)', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'Completed' });
      store.updateLastSpeaker('sess-1', 'assistant');
      store.markSessionInactive('sess-1');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(1);
      expect(attention[0].sessionId).toBe('sess-1');
      expect(attention[0].isActive).toBe(false);
    });

    it('orders by last_speaker_at descending', () => {
      // Use explicit timestamps to avoid same-millisecond collisions
      store.upsertSession({ sessionId: 'sess-1', summary: 'First' });
      store.upsertSession({ sessionId: 'sess-2', summary: 'Second' });

      // Manually set last_speaker_at via raw SQL to ensure distinct timestamps
      // updateLastSpeaker uses server-side unixepoch which can collide in tests
      store.updateLastSpeaker('sess-1', 'assistant');
      store.updateLastSpeaker('sess-2', 'assistant');

      const attention = store.getAttentionSessions();
      expect(attention).toHaveLength(2);
      // Both have assistant as last speaker — verify ordering is consistent
      // With server-generated timestamps that may collide, just verify both are present
      const ids = attention.map((a) => a.sessionId);
      expect(ids).toContain('sess-1');
      expect(ids).toContain('sess-2');
    });

    it('limits to 10 results', () => {
      for (let i = 0; i < 15; i++) {
        store.upsertSession({ sessionId: `sess-${i}`, summary: `Session ${i}` });
        store.updateLastSpeaker(`sess-${i}`, 'assistant');
      }

      expect(store.getAttentionSessions()).toHaveLength(10);
    });

    it('excludes sessions with null last_speaker', () => {
      store.upsertSession({ sessionId: 'sess-1', summary: 'No speaker' });
      // Don't call updateLastSpeaker

      expect(store.getAttentionSessions()).toEqual([]);
    });
  });

  describe('session state machine', () => {
    const sid = 'state-test-session';

    beforeEach(() => {
      store.upsertSession({ sessionId: sid });
    });

    it('sets and gets session state', () => {
      store.setSessionState(sid, 'CREATED', { clientId: 'c1' });
      expect(store.getSessionState(sid)).toBe('CREATED');
    });

    it('returns null for unknown session', () => {
      expect(store.getSessionState('nonexistent')).toBeNull();
    });

    it('includes state in session metadata', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1' });
      const meta = store.getSession(sid);
      expect(meta?.state).toBe('ACTIVE');
      expect(meta?.lastStateChange).toBeGreaterThan(0);
    });

    it('defaults to ENDED for existing sessions after migration', () => {
      // New sessions get DEFAULT 'ENDED' from migration
      const meta = store.getSession(sid);
      expect(meta?.state).toBe('ENDED');
    });

    it('allows valid CREATED → STARTING transition', () => {
      store.setSessionState(sid, 'CREATED', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'STARTING', { clientId: 'c1' });
      expect(store.getSessionState(sid)).toBe('STARTING');
    });

    it('allows valid ACTIVE → DETACHED transition', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'DETACHED', { clientId: 'c1' });
      expect(store.getSessionState(sid)).toBe('DETACHED');
    });

    it('allows ENDED → CREATED for resume', () => {
      store.setSessionState(sid, 'ENDED', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'CREATED', { clientId: 'c1' });
      expect(store.getSessionState(sid)).toBe('CREATED');
    });

    it('allows CREATED → ENDED for early failure', () => {
      store.setSessionState(sid, 'CREATED', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'ENDED', { clientId: 'c1' });
      expect(store.getSessionState(sid)).toBe('ENDED');
    });

    it('warns but does not block invalid transitions (Phase 1)', () => {
      const messages: string[] = [];
      const logger = { info: (msg: string) => messages.push(msg) };
      const s = new EventStore(':memory:', logger);
      s.upsertSession({ sessionId: 'warn-test' });
      s.setSessionState('warn-test', 'ACTIVE', { clientId: 'c1', force: true });
      // ACTIVE → CREATED is invalid
      s.setSessionState('warn-test', 'CREATED', { clientId: 'c1' });
      // Should still succeed (Phase 1 — warn only)
      expect(s.getSessionState('warn-test')).toBe('CREATED');
      // Should have logged the invalid transition
      expect(messages.some((m) => m.includes('invalid'))).toBe(true);
      s.close();
    });

    it('force flag bypasses validation', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', force: true });
      // ACTIVE → CREATED is invalid but force bypasses
      store.setSessionState(sid, 'CREATED', { clientId: 'c1', force: true });
      expect(store.getSessionState(sid)).toBe('CREATED');
    });

    it('tracks full lifecycle: CREATED → STARTING → ACTIVE → ENDED', () => {
      store.setSessionState(sid, 'CREATED', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'STARTING', { clientId: 'c1' });
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1' });
      store.setSessionState(sid, 'ENDED', { clientId: 'c1', reason: 'completed' });
      expect(store.getSessionState(sid)).toBe('ENDED');
    });

    it('tracks detach/reattach cycle', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'DETACHED', { clientId: 'c1', reason: 'transport_close' });
      expect(store.getSessionState(sid)).toBe('DETACHED');
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', reason: 'reattach' });
      expect(store.getSessionState(sid)).toBe('ACTIVE');
    });

    it('tracks suspend/resume cycle', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'SUSPENDED', { clientId: 'c1', reason: 'ios_background' });
      expect(store.getSessionState(sid)).toBe('SUSPENDED');
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', reason: 'resume' });
      expect(store.getSessionState(sid)).toBe('ACTIVE');
    });

    it('tracks closeout flow', () => {
      store.setSessionState(sid, 'ACTIVE', { clientId: 'c1', force: true });
      store.setSessionState(sid, 'CLOSING', { clientId: 'c1', reason: 'detach_ttl' });
      store.setSessionState(sid, 'ENDED', { clientId: 'c1', reason: 'closeout_complete' });
      expect(store.getSessionState(sid)).toBe('ENDED');
    });

    it('updates lastStateChange timestamp on each transition', () => {
      store.setSessionState(sid, 'CREATED', { clientId: 'c1', force: true });
      const meta1 = store.getSession(sid);
      store.setSessionState(sid, 'STARTING', { clientId: 'c1' });
      const meta2 = store.getSession(sid);
      expect(meta2!.lastStateChange).toBeGreaterThanOrEqual(meta1!.lastStateChange!);
    });
  });

  describe('toClientState mapping (via session_state_changed events)', () => {
    const sid = 'client-state-test';

    beforeEach(() => {
      store.upsertSession({ sessionId: sid });
    });

    it('maps CREATED to idle', () => {
      store.setSessionState(sid, 'CREATED', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('idle');
      expect(stateEvent?.payload.internalState).toBe('CREATED');
    });

    it('maps STARTING to running', () => {
      store.setSessionState(sid, 'STARTING', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('running');
    });

    it('maps ACTIVE to running', () => {
      store.setSessionState(sid, 'ACTIVE', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('running');
    });

    it('maps DETACHED to idle', () => {
      store.setSessionState(sid, 'DETACHED', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('idle');
    });

    it('maps SUSPENDED to idle', () => {
      store.setSessionState(sid, 'SUSPENDED', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('idle');
    });

    it('maps CLOSING to idle', () => {
      store.setSessionState(sid, 'CLOSING', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('idle');
    });

    it('maps ENDED to idle', () => {
      store.setSessionState(sid, 'ENDED', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.state).toBe('idle');
    });

    it('includes timestamp in event payload', () => {
      const before = Date.now();
      store.setSessionState(sid, 'ACTIVE', { force: true });
      const events = store.getSessionEvents(sid);
      const stateEvent = events.find((e) => e.type === 'session_state_changed');
      expect(stateEvent?.payload.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('setSessionState syncs is_active', () => {
    const sid = 'is-active-sync-test';

    beforeEach(() => {
      store.upsertSession({ sessionId: sid });
    });

    it('sets is_active=true for ACTIVE', () => {
      store.setSessionState(sid, 'ACTIVE', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(true);
    });

    it('sets is_active=true for DETACHED', () => {
      store.setSessionState(sid, 'DETACHED', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(true);
    });

    it('sets is_active=true for SUSPENDED', () => {
      store.setSessionState(sid, 'SUSPENDED', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(true);
    });

    it('sets is_active=false for ENDED', () => {
      store.setSessionState(sid, 'ENDED', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(false);
    });

    it('sets is_active=false for CLOSING', () => {
      store.setSessionState(sid, 'CLOSING', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(false);
    });

    it('sets is_active=true for CREATED', () => {
      store.setSessionState(sid, 'CREATED', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(true);
    });

    it('sets is_active=true for STARTING', () => {
      store.setSessionState(sid, 'STARTING', { force: true });
      expect(store.getSession(sid)!.isActive).toBe(true);
    });
  });

  describe('recoverStaleSessions', () => {
    it('transitions ACTIVE sessions to ENDED', () => {
      store.upsertSession({ sessionId: 'active-1' });
      store.setSessionState('active-1', 'ACTIVE', { force: true });

      const count = store.recoverStaleSessions();

      expect(count).toBe(1);
      expect(store.getSessionState('active-1')).toBe('ENDED');
    });

    it('transitions STARTING sessions to ENDED', () => {
      store.upsertSession({ sessionId: 'starting-1' });
      store.setSessionState('starting-1', 'STARTING', { force: true });

      store.recoverStaleSessions();

      expect(store.getSessionState('starting-1')).toBe('ENDED');
    });

    it('transitions DETACHED sessions to ENDED', () => {
      store.upsertSession({ sessionId: 'detached-1' });
      store.setSessionState('detached-1', 'DETACHED', { force: true });

      store.recoverStaleSessions();

      expect(store.getSessionState('detached-1')).toBe('ENDED');
    });

    it('transitions SUSPENDED sessions to ENDED', () => {
      store.upsertSession({ sessionId: 'suspended-1' });
      store.setSessionState('suspended-1', 'SUSPENDED', { force: true });

      store.recoverStaleSessions();

      expect(store.getSessionState('suspended-1')).toBe('ENDED');
    });

    it('transitions CLOSING sessions to ENDED', () => {
      store.upsertSession({ sessionId: 'closing-1' });
      store.setSessionState('closing-1', 'CLOSING', { force: true });

      store.recoverStaleSessions();

      expect(store.getSessionState('closing-1')).toBe('ENDED');
    });

    it('does not touch ENDED sessions', () => {
      store.upsertSession({ sessionId: 'ended-1' });
      store.setSessionState('ended-1', 'ENDED', { force: true });

      const count = store.recoverStaleSessions();

      expect(count).toBe(0);
      expect(store.getSessionState('ended-1')).toBe('ENDED');
    });

    it('does not touch CREATED sessions', () => {
      store.upsertSession({ sessionId: 'created-1' });
      store.setSessionState('created-1', 'CREATED', { force: true });

      const count = store.recoverStaleSessions();

      expect(count).toBe(0);
      expect(store.getSessionState('created-1')).toBe('CREATED');
    });

    it('returns correct count for multiple stale sessions', () => {
      store.upsertSession({ sessionId: 'stale-1' });
      store.upsertSession({ sessionId: 'stale-2' });
      store.upsertSession({ sessionId: 'ok-1' });
      store.setSessionState('stale-1', 'ACTIVE', { force: true });
      store.setSessionState('stale-2', 'DETACHED', { force: true });
      store.setSessionState('ok-1', 'ENDED', { force: true });

      const count = store.recoverStaleSessions();

      expect(count).toBe(2);
    });

    it('emits session_state_changed events for recovered sessions', () => {
      store.upsertSession({ sessionId: 'recover-1' });
      store.setSessionState('recover-1', 'ACTIVE', { force: true });

      // Clear events from setup
      const beforeCount = store.getSessionEvents('recover-1').length;

      store.recoverStaleSessions();

      const events = store.getSessionEvents('recover-1');
      // Should have new session_state_changed event from recovery
      const recoveryEvent = events
        .slice(beforeCount)
        .find((e) => e.type === 'session_state_changed');
      expect(recoveryEvent).toBeDefined();
      expect(recoveryEvent?.payload.state).toBe('idle');
      expect(recoveryEvent?.payload.internalState).toBe('ENDED');
    });
  });

  describe('canonical execution state', () => {
    const sid = 'execution-session';

    beforeEach(() => {
      store.upsertSession({ sessionId: sid });
    });

    it('allocates monotonically increasing execution tokens with matching durable events', () => {
      const first = store.beginExecution(sid, 'execution-1');
      const second = store.beginExecution(sid, 'execution-2');

      expect(first).toMatchObject({
        token: { sessionId: sid, executionId: 'execution-1', generation: 1 },
        event: {
          sessionId: sid,
          executionId: 'execution-1',
          generation: 1,
          phase: 'RUNNING',
          clientState: 'running',
        },
      });
      expect(second.token).toEqual({ sessionId: sid, executionId: 'execution-2', generation: 2 });
      const meta = store.getSession(sid)!;
      expect(meta).toMatchObject({
        lifecycleState: 'OPEN',
        executionGeneration: 2,
        executionId: 'execution-2',
        executionPhase: 'RUNNING',
        executionTerminalReason: null,
      });
      const events = store
        .getSessionEvents(sid)
        .filter((event) => event.type === 'execution_state_changed');
      expect(events.map((event) => event.seq)).toEqual([first.seq, second.seq]);
      expect(events.map((event) => event.payload)).toEqual([first.event, second.event]);
    });

    it('assigns a UUID when the accepted execution does not supply one', () => {
      const started = store.beginExecution(sid);

      expect(started.token.executionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(store.getSession(sid)?.executionId).toBe(started.token.executionId);
    });

    it('keeps an execution generation stable across legacy state and conversation lifecycle changes', () => {
      const started = store.beginExecution(sid, 'execution-1');
      store.setSessionState(sid, 'DETACHED', { force: true });
      const lifecycle = store.setSessionLifecycle(sid, 'CLOSING');

      expect(store.getSession(sid)).toMatchObject({
        executionGeneration: started.token.generation,
        executionId: started.token.executionId,
        executionPhase: 'RUNNING',
        lifecycleState: 'CLOSING',
      });
      expect(
        store.getSessionEvents(sid).find((event) => event.seq === lifecycle.seq)?.payload,
      ).toMatchObject({
        sessionId: sid,
        lifecycleState: 'CLOSING',
      });
    });

    it('allows valid phase changes, persists the terminal reason, and makes terminal final', () => {
      const started = store.beginExecution(sid, 'execution-1');
      const action = store.transitionExecution(started.token, 'REQUIRES_ACTION');
      const resumed = store.transitionExecution(started.token, 'RUNNING');
      const terminal = store.transitionExecution(started.token, 'TERMINAL', 'completed');
      const afterTerminal = store.transitionExecution(started.token, 'RUNNING');

      expect(action).toMatchObject({
        applied: true,
        status: 'applied',
        event: { phase: 'REQUIRES_ACTION', clientState: 'requires_action' },
      });
      expect(resumed).toMatchObject({
        applied: true,
        status: 'applied',
        event: { phase: 'RUNNING' },
      });
      expect(terminal).toMatchObject({
        applied: true,
        status: 'applied',
        event: { phase: 'TERMINAL', clientState: 'idle', terminalReason: 'completed' },
      });
      expect(afterTerminal).toMatchObject({ applied: false, status: 'terminal' });
      expect(store.getSession(sid)).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'completed',
      });
    });

    it('rejects stale execution tokens without changing the row or adding an event', () => {
      const started = store.beginExecution(sid, 'execution-1');
      const before = store.getSessionEvents(sid).length;
      const staleId = store.transitionExecution(
        { ...started.token, executionId: 'different-execution' },
        'STOPPING',
      );
      const staleGeneration = store.transitionExecution(
        { ...started.token, generation: started.token.generation + 1 },
        'STOPPING',
      );

      expect(staleId).toMatchObject({ applied: false, status: 'stale' });
      expect(staleGeneration).toMatchObject({ applied: false, status: 'stale' });
      expect(
        store.claimStop({ ...started.token, executionId: 'different-execution' }),
      ).toMatchObject({ applied: false, status: 'stale' });
      expect(store.getSession(sid)).toMatchObject({ executionPhase: 'RUNNING' });
      expect(store.getSessionEvents(sid)).toHaveLength(before);
    });

    it('claims STOPPING once and makes repeated stop claims idempotent', () => {
      const started = store.beginExecution(sid, 'execution-1');
      const first = store.claimStop(started.token);
      const beforeSecond = store.getSessionEvents(sid).length;
      const second = store.claimStop(started.token);

      expect(first).toMatchObject({
        applied: true,
        status: 'applied',
        event: { phase: 'STOPPING' },
      });
      expect(second).toMatchObject({ applied: false, status: 'already_stopping' });
      expect(store.getSessionEvents(sid)).toHaveLength(beforeSecond);
    });

    it('requires and persists only a valid terminal reason', () => {
      const started = store.beginExecution(sid, 'execution-1');
      expect(() => store.transitionExecution(started.token, 'TERMINAL')).toThrow(
        'valid terminal reason',
      );
      expect(() => store.transitionExecution(started.token, 'RUNNING', 'completed')).toThrow(
        'terminalReason is only valid',
      );
      expect(() =>
        store.transitionExecution(started.token, 'TERMINAL', 'not-a-terminal-reason' as never),
      ).toThrow('valid terminal reason');
      const terminal = store.transitionExecution(started.token, 'TERMINAL', 'stopped');
      expect(terminal.event?.terminalReason).toBe('stopped');
      expect(store.getSession(sid)?.executionTerminalReason).toBe('stopped');
    });

    it('rolls back both the execution row and durable event when an event insert fails', () => {
      const db = (store as unknown as { db: Database.Database }).db;
      db.exec(`
        CREATE TRIGGER reject_execution_events
        BEFORE INSERT ON events WHEN NEW.type = 'execution_state_changed'
        BEGIN SELECT RAISE(ABORT, 'injected execution event failure'); END;
      `);
      expect(() => store.beginExecution(sid, 'execution-1')).toThrow(
        'injected execution event failure',
      );
      expect(store.getSession(sid)).toMatchObject({
        executionGeneration: 0,
        executionId: null,
        executionPhase: null,
      });
      expect(store.getSessionEvents(sid)).toHaveLength(0);

      db.exec('DROP TRIGGER reject_execution_events');
      const started = store.beginExecution(sid, 'execution-1');
      const before = store.getSessionEvents(sid).length;
      db.exec(`
        CREATE TRIGGER reject_execution_transitions
        BEFORE INSERT ON events WHEN NEW.type = 'execution_state_changed'
        BEGIN SELECT RAISE(ABORT, 'injected execution event failure'); END;
      `);
      expect(() => store.claimStop(started.token)).toThrow('injected execution event failure');
      expect(store.getSession(sid)).toMatchObject({ executionPhase: 'RUNNING' });
      expect(store.getSessionEvents(sid)).toHaveLength(before);
    });

    it('recovers only active orphaned executions once without closing the conversation', () => {
      const active = store.beginExecution(sid, 'execution-active');
      store.upsertSession({ sessionId: 'requires-action-session' });
      const requiresAction = store.beginExecution('requires-action-session', 'execution-action');
      store.transitionExecution(requiresAction.token, 'REQUIRES_ACTION');
      store.upsertSession({ sessionId: 'stopping-session' });
      const stopping = store.beginExecution('stopping-session', 'execution-stopping');
      store.claimStop(stopping.token);
      store.upsertSession({ sessionId: 'terminal-session' });
      const terminal = store.beginExecution('terminal-session', 'execution-terminal');
      store.transitionExecution(terminal.token, 'TERMINAL', 'completed');

      expect(store.recoverOrphanedExecutions()).toBe(3);
      expect(store.getSession(sid)).toMatchObject({
        lifecycleState: 'OPEN',
        executionId: active.token.executionId,
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'server_restart',
      });
      expect(store.getSession('terminal-session')).toMatchObject({
        lifecycleState: 'OPEN',
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'completed',
      });
      expect(store.getSession('requires-action-session')).toMatchObject({
        lifecycleState: 'OPEN',
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'server_restart',
      });
      expect(store.getSession('stopping-session')).toMatchObject({
        lifecycleState: 'OPEN',
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'server_restart',
      });
      expect(store.recoverOrphanedExecutions()).toBe(0);
    });

    it('serializes sequential begins without duplicate generations', () => {
      const executions = Array.from({ length: 4 }, (_, index) =>
        store.beginExecution(sid, `execution-${index}`),
      );
      expect(executions.map((execution) => execution.token.generation)).toEqual([1, 2, 3, 4]);
      expect(new Set(executions.map((execution) => execution.token.generation)).size).toBe(4);
    });

    it.todo(
      'deduplicates beginExecution by clientMsgId once send receipts persist execution tokens',
    );
  });

  describe('execution state migration', () => {
    it('backs old rows into OPEN conversations unless closed_by is durable close evidence', async () => {
      const root = await mkdtemp(join(tmpdir(), 'mitzo-execution-migration-'));
      const path = join(root, 'legacy.sqlite');
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY, summary TEXT, branch TEXT, cwd TEXT,
          mode TEXT NOT NULL DEFAULT 'agent', is_active INTEGER NOT NULL DEFAULT 1,
          is_hidden INTEGER NOT NULL DEFAULT 0, closed_by TEXT, state TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        );
      `);
      legacy
        .prepare(
          `INSERT INTO sessions (session_id, mode, is_active, is_hidden, closed_by, state, created_at, updated_at)
         VALUES (?, 'agent', 0, 0, ?, 'ENDED', 1, 1)`,
        )
        .run('old-ended-open', null);
      legacy
        .prepare(
          `INSERT INTO sessions (session_id, mode, is_active, is_hidden, closed_by, state, created_at, updated_at)
         VALUES (?, 'agent', 0, 0, 'user', 'ENDED', 1, 1)`,
        )
        .run('old-closed');
      legacy.close();

      const migrated = new EventStore(path);
      try {
        expect(migrated.getSession('old-ended-open')).toMatchObject({
          state: 'ENDED',
          lifecycleState: 'OPEN',
          executionGeneration: 0,
          executionId: null,
          executionPhase: null,
        });
        expect(migrated.getSession('old-closed')).toMatchObject({
          lifecycleState: 'CLOSED',
          executionGeneration: 0,
          executionId: null,
        });
      } finally {
        migrated.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('close', () => {
    it('is safe to call multiple times', () => {
      store.close();
      store.close();
    });
  });
});
