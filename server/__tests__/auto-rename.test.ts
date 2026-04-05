import { describe, it, expect } from 'vitest';
import {
  shouldAutoRename,
  extractRecentPrompts,
  generateSessionName,
  AUTO_RENAME_INTERVAL,
} from '../auto-rename.js';
import type { StoredEvent } from '../event-store.js';

describe('shouldAutoRename', () => {
  it('returns true at prompt count 4', () => {
    expect(shouldAutoRename(4, false)).toBe(true);
  });

  it('returns true at prompt count 8', () => {
    expect(shouldAutoRename(8, false)).toBe(true);
  });

  it('returns false at prompt count 3', () => {
    expect(shouldAutoRename(3, false)).toBe(false);
  });

  it('returns false at prompt count 5', () => {
    expect(shouldAutoRename(5, false)).toBe(false);
  });

  it('returns false when manually renamed', () => {
    expect(shouldAutoRename(4, true)).toBe(false);
  });

  it('returns false at prompt count 0', () => {
    expect(shouldAutoRename(0, false)).toBe(false);
  });
});

describe('extractRecentPrompts', () => {
  it('extracts user_message texts from events', () => {
    const events: StoredEvent[] = [
      { seq: 1, sessionId: 's1', type: 'user_message', payload: { text: 'Hello' }, createdAt: 1 },
      {
        seq: 2,
        sessionId: 's1',
        type: 'message_start',
        payload: { messageId: 'msg-1' },
        createdAt: 2,
      },
      {
        seq: 3,
        sessionId: 's1',
        type: 'user_message',
        payload: { text: 'Fix the bug' },
        createdAt: 3,
      },
    ];
    const prompts = extractRecentPrompts(events);
    expect(prompts).toEqual(['Hello', 'Fix the bug']);
  });

  it('returns empty array when no user messages', () => {
    const events: StoredEvent[] = [
      {
        seq: 1,
        sessionId: 's1',
        type: 'message_start',
        payload: { messageId: 'msg-1' },
        createdAt: 1,
      },
    ];
    expect(extractRecentPrompts(events)).toEqual([]);
  });

  it('limits to last 8 prompts', () => {
    const events: StoredEvent[] = Array.from({ length: 12 }, (_, i) => ({
      seq: i + 1,
      sessionId: 's1',
      type: 'user_message' as const,
      payload: { text: `prompt ${i + 1}` },
      createdAt: i + 1,
    }));
    const prompts = extractRecentPrompts(events);
    expect(prompts).toHaveLength(8);
    expect(prompts[0]).toBe('prompt 5');
    expect(prompts[7]).toBe('prompt 12');
  });
});

describe('generateSessionName', () => {
  it('generates a name from prompts by extracting key words', () => {
    const prompts = [
      'Fix the authentication bug in login page',
      'Also update the password validation',
      'Add tests for the auth module',
      'Refactor the session handling code',
    ];
    const name = generateSessionName(prompts);
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(60);
  });

  it('returns empty string for empty prompts', () => {
    expect(generateSessionName([])).toBe('');
  });

  it('handles single prompt', () => {
    const name = generateSessionName(['Fix the login bug']);
    expect(name.length).toBeGreaterThan(0);
  });

  it('truncates very long results', () => {
    const prompts = [
      'Implement the comprehensive authentication and authorization system with multi-factor verification support',
      'Add database migration scripts for the new user management schema with role-based access control',
      'Create integration tests for all the new API endpoints including edge cases and error scenarios',
      'Deploy to staging environment and run the full regression test suite against the new authentication flow',
    ];
    const name = generateSessionName(prompts);
    expect(name.length).toBeLessThanOrEqual(60);
  });
});

describe('AUTO_RENAME_INTERVAL', () => {
  it('is 4', () => {
    expect(AUTO_RENAME_INTERVAL).toBe(4);
  });
});
