import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  shouldAutoRename,
  extractRecentPrompts,
  generateSessionName,
  generateSessionNameFallback,
  setClientFactory,
  resetClientFactory,
  AUTO_RENAME_INTERVAL,
  AUTO_RENAME_MODEL,
} from '../auto-rename.js';
import type { StoredEvent } from '../event-store.js';

describe('shouldAutoRename', () => {
  it('returns true at prompt count 1', () => {
    expect(shouldAutoRename(1, false)).toBe(true);
  });

  it('returns false at prompt counts 2 and 3 (skip back-to-back with prompt 1)', () => {
    expect(shouldAutoRename(2, false)).toBe(false);
    expect(shouldAutoRename(3, false)).toBe(false);
  });

  it('returns true at prompt count 4 (first interval trigger)', () => {
    expect(shouldAutoRename(4, false)).toBe(true);
  });

  it('follows interval pattern after prompt 3 (4, 6, 8...)', () => {
    expect(shouldAutoRename(5, false)).toBe(false);
    expect(shouldAutoRename(6, false)).toBe(true);
    expect(shouldAutoRename(7, false)).toBe(false);
    expect(shouldAutoRename(8, false)).toBe(true);
  });

  it('returns false when manually renamed', () => {
    expect(shouldAutoRename(2, true)).toBe(false);
    expect(shouldAutoRename(1, true)).toBe(false);
    expect(shouldAutoRename(4, true)).toBe(false);
  });

  it('returns false at prompt count 0 or below', () => {
    expect(shouldAutoRename(0, false)).toBe(false);
    expect(shouldAutoRename(-1, false)).toBe(false);
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

describe('generateSessionNameFallback', () => {
  it('generates a name from prompts by extracting key words', () => {
    const prompts = [
      'Fix the authentication bug in login page',
      'Also update the password validation',
      'Add tests for the auth module',
      'Refactor the session handling code',
    ];
    const name = generateSessionNameFallback(prompts);
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(60);
  });

  it('returns empty string for empty prompts', () => {
    expect(generateSessionNameFallback([])).toBe('');
  });

  it('handles single prompt', () => {
    const name = generateSessionNameFallback(['Fix the login bug']);
    expect(name.length).toBeGreaterThan(0);
  });

  it('truncates very long results', () => {
    const prompts = [
      'Implement the comprehensive authentication and authorization system with multi-factor verification support',
      'Add database migration scripts for the new user management schema with role-based access control',
      'Create integration tests for all the new API endpoints including edge cases and error scenarios',
      'Deploy to staging environment and run the full regression test suite against the new authentication flow',
    ];
    const name = generateSessionNameFallback(prompts);
    expect(name.length).toBeLessThanOrEqual(60);
  });
});

describe('generateSessionName', () => {
  afterEach(() => {
    resetClientFactory();
  });

  it('returns empty string for empty prompts', async () => {
    expect(await generateSessionName([])).toBe('');
  });

  it('calls Haiku and returns the generated name', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Auth Bug Fix Session' }],
    });

    setClientFactory(
      () =>
        ({
          messages: { create: mockCreate },
        }) as never,
    );

    const result = await generateSessionName(['Fix the auth bug', 'Update login page']);

    expect(result).toBe('Auth Bug Fix Session');
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledWith(
      {
        model: AUTO_RENAME_MODEL,
        max_tokens: 20,
        system:
          'Generate a 3-6 word title for this chat session. Be specific and descriptive. Return only the title, nothing else.',
        messages: [
          {
            role: 'user',
            content: 'Fix the auth bug\nUpdate login page',
          },
        ],
      },
      { timeout: 5000 },
    );
  });

  it('falls back to keyword extraction when API call fails', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('API key invalid'));

    setClientFactory(
      () =>
        ({
          messages: { create: mockCreate },
        }) as never,
    );

    const prompts = ['Fix the authentication bug', 'Update the login page'];
    const result = await generateSessionName(prompts);

    // Should fall back to keyword extraction (same as generateSessionNameFallback)
    const fallback = generateSessionNameFallback(prompts);
    expect(result).toBe(fallback);
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back when API returns empty content', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [],
    });

    setClientFactory(
      () =>
        ({
          messages: { create: mockCreate },
        }) as never,
    );

    const prompts = ['Fix the authentication bug'];
    const result = await generateSessionName(prompts);
    const fallback = generateSessionNameFallback(prompts);
    expect(result).toBe(fallback);
  });

  it('truncates long Haiku responses', async () => {
    const longName = 'A'.repeat(80);
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: longName }],
    });

    setClientFactory(
      () =>
        ({
          messages: { create: mockCreate },
        }) as never,
    );

    const result = await generateSessionName(['Some prompt']);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe('AUTO_RENAME_INTERVAL', () => {
  it('is 2', () => {
    expect(AUTO_RENAME_INTERVAL).toBe(2);
  });
});
