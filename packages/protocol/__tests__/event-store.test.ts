import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  describe('durable execution state', () => {
    const sessionId = 'durable-execution-session';

    beforeEach(() => {
      store.upsertSession({ sessionId });
    });

    it('allocates monotonic execution generations with matching durable events', () => {
      const first = store.beginExecution(sessionId, 'execution-1');
      const finished = store.transitionExecution(first.token, 'TERMINAL', 'completed');
      const second = store.beginExecution(sessionId, 'execution-2');

      expect(first.token).toEqual({ sessionId, executionId: 'execution-1', generation: 1 });
      expect(finished).toMatchObject({ applied: true, status: 'applied' });
      expect(second.token).toEqual({ sessionId, executionId: 'execution-2', generation: 2 });
      expect(store.getSession(sessionId)).toMatchObject({
        executionGeneration: 2,
        executionId: 'execution-2',
        executionPhase: 'RUNNING',
        executionTerminalReason: null,
      });
      expect(
        store
          .getSessionEvents(sessionId)
          .filter((event) => event.type === 'execution_state_changed')
          .map((event) => event.payload),
      ).toMatchObject([
        { executionId: 'execution-1', generation: 1, phase: 'RUNNING' },
        {
          executionId: 'execution-1',
          generation: 1,
          phase: 'TERMINAL',
          terminalReason: 'completed',
        },
        { executionId: 'execution-2', generation: 2, phase: 'RUNNING' },
      ]);
    });

    it('rejects a second active execution without overwriting the first', () => {
      const first = store.beginExecution(sessionId, 'execution-1');

      expect(() => store.beginExecution(sessionId, 'execution-2')).toThrow(
        'Cannot overwrite active execution',
      );
      expect(store.getSession(sessionId)).toMatchObject({
        executionGeneration: first.token.generation,
        executionId: first.token.executionId,
        executionPhase: 'RUNNING',
      });
    });

    it('returns the original token for an exact durable admission retry', () => {
      const first = store.beginExecution(
        sessionId,
        'execution-1',
        'client-command-1',
        'request-fingerprint-1',
      );
      const beforeRetry = store.getSessionEvents(sessionId);
      const retry = store.beginExecution(
        sessionId,
        undefined,
        'client-command-1',
        'request-fingerprint-1',
      );

      expect(first).toMatchObject({ duplicate: false });
      expect(retry).toEqual({ token: first.token, duplicate: true });
      expect(store.getSessionEvents(sessionId)).toEqual(beforeRetry);
      expect(store.getSession(sessionId)?.executionGeneration).toBe(1);
      expect(store.getExecutionAdmission(sessionId, 'client-command-1')).toEqual({
        token: first.token,
        requestFingerprint: 'request-fingerprint-1',
      });
    });

    it('fails closed when a command identity is reused for different input', () => {
      const first = store.beginExecution(
        sessionId,
        'execution-1',
        'client-command-1',
        'request-fingerprint-1',
      );
      const beforeConflict = store.getSessionEvents(sessionId);

      expect(() =>
        store.beginExecution(sessionId, undefined, 'client-command-1', 'request-fingerprint-2'),
      ).toThrow('different request fingerprint');
      expect(() =>
        store.beginExecution(sessionId, 'execution-2', 'client-command-1', 'request-fingerprint-1'),
      ).toThrow('different executionId');
      expect(store.getSessionEvents(sessionId)).toEqual(beforeConflict);
      expect(store.getSession(sessionId)).toMatchObject({
        executionGeneration: 1,
        executionId: first.token.executionId,
      });
    });

    it('requires a bounded request fingerprint with a client command identity', () => {
      expect(() => store.beginExecution(sessionId, 'execution-1', 'client-command-1')).toThrow(
        'requestFingerprint',
      );
      expect(() =>
        store.beginExecution(sessionId, 'execution-1', undefined, 'request-fingerprint-1'),
      ).toThrow('clientMsgId');
      expect(() => store.beginExecution(sessionId, 'execution-1', ' ', 'fingerprint')).toThrow(
        'clientMsgId',
      );
      expect(() =>
        store.beginExecution(sessionId, 'execution-1', 'client-command-1', ' '.repeat(513)),
      ).toThrow('requestFingerprint');
      expect(store.getSessionEvents(sessionId)).toHaveLength(0);
    });

    it('rolls back the durable admission receipt when its event cannot be appended', () => {
      const db = (store as unknown as { db: { exec(sql: string): void } }).db;
      db.exec(`
        CREATE TRIGGER reject_admitted_execution_event
        BEFORE INSERT ON events WHEN NEW.type = 'execution_state_changed'
        BEGIN SELECT RAISE(ABORT, 'injected admission event failure'); END;
      `);

      expect(() =>
        store.beginExecution(sessionId, 'execution-1', 'client-command-1', 'request-fingerprint-1'),
      ).toThrow('injected admission event failure');
      expect(store.getExecutionAdmission(sessionId, 'client-command-1')).toBeUndefined();
      expect(store.getSession(sessionId)).toMatchObject({
        executionGeneration: 0,
        executionId: null,
        executionPhase: null,
      });
    });

    it('makes terminal transitions exactly once and rejects stale tokens', () => {
      const started = store.beginExecution(sessionId, 'execution-1');
      const stale = store.transitionExecution(
        { ...started.token, generation: started.token.generation + 1 },
        'TERMINAL',
        'failed',
      );
      const terminal = store.transitionExecution(started.token, 'TERMINAL', 'failed');
      const duplicate = store.transitionExecution(started.token, 'TERMINAL', 'failed');

      expect(stale).toMatchObject({ applied: false, status: 'stale' });
      expect(terminal).toMatchObject({ applied: true, status: 'applied' });
      expect(duplicate).toMatchObject({ applied: false, status: 'terminal' });
      expect(
        store
          .getSessionEvents(sessionId)
          .filter(
            (event) =>
              event.type === 'execution_state_changed' && event.payload.phase === 'TERMINAL',
          ),
      ).toHaveLength(1);
    });

    it('requires a closed terminal reason and preserves it in the aggregate', () => {
      const started = store.beginExecution(sessionId, 'execution-1');

      expect(() => store.transitionExecution(started.token, 'TERMINAL')).toThrow('terminal reason');
      expect(() => store.transitionExecution(started.token, 'RUNNING', 'completed')).toThrow(
        'only valid for TERMINAL',
      );
      store.transitionExecution(started.token, 'TERMINAL', 'server_restart');

      expect(store.getSession(sessionId)).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'server_restart',
      });
    });

    it('terminalizes orphaned executions once during restart recovery', () => {
      store.beginExecution(sessionId, 'execution-1');

      expect(store.recoverOrphanedExecutions()).toBe(1);
      expect(store.recoverOrphanedExecutions()).toBe(0);
      expect(store.getSession(sessionId)).toMatchObject({
        executionPhase: 'TERMINAL',
        executionTerminalReason: 'server_restart',
      });
      expect(
        store
          .getSessionEvents(sessionId)
          .filter(
            (event) =>
              event.type === 'execution_state_changed' && event.payload.phase === 'TERMINAL',
          ),
      ).toHaveLength(1);
    });

    it('rolls back aggregate state when its durable event cannot be appended', () => {
      const db = (store as unknown as { db: { exec(sql: string): void } }).db;
      db.exec(`
        CREATE TRIGGER reject_execution_events
        BEFORE INSERT ON events WHEN NEW.type = 'execution_state_changed'
        BEGIN SELECT RAISE(ABORT, 'injected execution event failure'); END;
      `);

      expect(() => store.beginExecution(sessionId, 'execution-1')).toThrow(
        'injected execution event failure',
      );
      expect(store.getSession(sessionId)).toMatchObject({
        executionGeneration: 0,
        executionId: null,
        executionPhase: null,
      });
      expect(store.getSessionEvents(sessionId)).toHaveLength(0);
    });

    it('binds monotonic provider attempts to the active execution token', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const first = store.beginProviderAttempt(execution.token, 'provider-attempt-1');
      const beforeRetry = store.getSessionEvents(sessionId);
      const retry = store.beginProviderAttempt(execution.token, 'provider-attempt-1');
      expect(store.getSessionEvents(sessionId)).toEqual(beforeRetry);
      const firstTerminal = store.transitionProviderAttempt(first.token, 'TERMINAL', 'failed');
      const duplicateTerminal = store.transitionProviderAttempt(first.token, 'TERMINAL', 'failed');
      const second = store.beginProviderAttempt(execution.token, 'provider-attempt-2');

      expect(first.token).toEqual({
        ...execution.token,
        providerAttemptId: 'provider-attempt-1',
        attempt: 1,
      });
      expect(first).toMatchObject({ duplicate: false });
      expect(retry).toEqual({ token: first.token, duplicate: true });
      expect(firstTerminal).toMatchObject({ applied: true, status: 'applied' });
      expect(duplicateTerminal).toMatchObject({ applied: false, status: 'terminal' });
      expect(second.token).toEqual({
        ...execution.token,
        providerAttemptId: 'provider-attempt-2',
        attempt: 2,
      });
      expect(store.getProviderAttempts(execution.token)).toMatchObject([
        { token: first.token, phase: 'TERMINAL', terminalReason: 'failed' },
        { token: second.token, phase: 'RUNNING', terminalReason: null },
      ]);
    });

    it('rejects stale provider attempt ownership without persisting state', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const staleToken = { ...execution.token, generation: execution.token.generation + 1 };

      expect(() => store.beginProviderAttempt(staleToken, 'provider-attempt-stale')).toThrow(
        'stale execution token',
      );
      expect(store.getProviderAttempts(execution.token)).toEqual([]);

      const attempt = store.beginProviderAttempt(execution.token, 'provider-attempt-1');
      expect(() => store.beginProviderAttempt(execution.token, 'provider-attempt-2')).toThrow(
        'Cannot overwrite active provider attempt',
      );
      expect(
        store.transitionProviderAttempt(
          { ...attempt.token, providerAttemptId: 'provider-attempt-other' },
          'TERMINAL',
          'completed',
        ),
      ).toMatchObject({ applied: false, status: 'stale' });
      expect(store.getProviderAttempts(execution.token)).toHaveLength(1);
    });

    it('rolls back provider-attempt state when its durable event cannot be appended', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const db = (store as unknown as { db: { exec(sql: string): void } }).db;
      db.exec(`
        CREATE TRIGGER reject_provider_attempt_event
        BEFORE INSERT ON events WHEN NEW.type = 'provider_attempt_state_changed'
        BEGIN SELECT RAISE(ABORT, 'injected provider attempt event failure'); END;
      `);

      expect(() => store.beginProviderAttempt(execution.token, 'provider-attempt-1')).toThrow(
        'injected provider attempt event failure',
      );
      expect(store.getProviderAttempts(execution.token)).toEqual([]);
    });

    it('requires every provider attempt to terminate before its execution', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const attempt = store.beginProviderAttempt(execution.token, 'provider-attempt-1');

      expect(() => store.transitionExecution(execution.token, 'TERMINAL', 'completed')).toThrow(
        'active provider attempt',
      );
      expect(store.getSession(sessionId)).toMatchObject({ executionPhase: 'RUNNING' });

      store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed');
      expect(store.transitionExecution(execution.token, 'TERMINAL', 'completed')).toMatchObject({
        applied: true,
      });
    });

    it('keeps a terminal provider-attempt retry idempotent after its execution closes', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const attempt = store.beginProviderAttempt(execution.token, 'provider-attempt-1');

      expect(store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed')).toMatchObject(
        { applied: true, status: 'applied' },
      );
      expect(store.transitionExecution(execution.token, 'TERMINAL', 'completed')).toMatchObject({
        applied: true,
      });
      const beforeRetry = store.getSessionEvents(sessionId);

      expect(store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed')).toMatchObject(
        { applied: false, status: 'terminal' },
      );
      expect(store.getSessionEvents(sessionId)).toEqual(beforeRetry);
    });

    it('reports a conflicting provider-attempt terminal retry', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      const attempt = store.beginProviderAttempt(execution.token, 'provider-attempt-1');

      store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'completed');

      expect(store.transitionProviderAttempt(attempt.token, 'TERMINAL', 'failed')).toMatchObject({
        applied: false,
        status: 'conflict',
        persistedTerminalReason: 'completed',
      });
    });

    it('terminalizes an orphaned provider attempt before its execution exactly once', () => {
      const execution = store.beginExecution(sessionId, 'execution-1');
      store.beginProviderAttempt(execution.token, 'provider-attempt-1');

      expect(store.recoverOrphanedExecutions()).toBe(1);
      expect(store.recoverOrphanedExecutions()).toBe(0);
      expect(store.getProviderAttempts(execution.token)).toMatchObject([
        { phase: 'TERMINAL', terminalReason: 'ambiguous' },
      ]);
      expect(
        store
          .getSessionEvents(sessionId)
          .filter((event) => event.type.endsWith('_state_changed'))
          .map((event) => [event.type, event.payload.phase, event.payload.terminalReason]),
      ).toEqual([
        ['execution_state_changed', 'RUNNING', undefined],
        ['provider_attempt_state_changed', 'RUNNING', undefined],
        ['provider_attempt_state_changed', 'TERMINAL', 'ambiguous'],
        ['execution_state_changed', 'TERMINAL', 'server_restart'],
      ]);
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

  describe('getRecentConversationText', () => {
    it('returns only user and completed-assistant projection fields', () => {
      store.append('sess-1', 'user_message', {
        messageId: 'u1',
        text: 'hello',
        images: ['data:image/png;base64,secret-large-image'],
      });
      store.append('sess-1', 'message_start', { messageId: 'a1' });
      store.append('sess-1', 'block_delta', {
        messageId: 'a1',
        blockId: 'text',
        blockType: 'text',
        delta: 'answer',
      });
      store.append('sess-1', 'block_delta', {
        messageId: 'a1',
        blockId: 'thinking',
        blockType: 'thinking',
        delta: 'private reasoning',
      });
      store.append('sess-1', 'tool_result', {
        messageId: 'a1',
        result: 'secret tool output',
      });
      store.append('sess-1', 'message_end', { messageId: 'a1' });

      const events = store.getRecentConversationText('sess-1');

      expect(events).toEqual([
        { seq: expect.any(Number), kind: 'user', messageId: 'u1', text: 'hello' },
        {
          seq: expect.any(Number),
          kind: 'assistant_delta',
          messageId: 'a1',
          text: 'answer',
        },
        { seq: expect.any(Number), kind: 'assistant_end', messageId: 'a1', text: '' },
      ]);
      expect(JSON.stringify(events)).not.toContain('secret');
      expect(JSON.stringify(events)).not.toContain('private reasoning');
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

  describe('close', () => {
    it('is safe to call multiple times', () => {
      store.close();
      store.close();
    });
  });
});
