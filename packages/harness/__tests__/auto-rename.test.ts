import { describe, it, expect, vi, afterEach } from 'vitest';

// Client selection is a unit test; constructing the real SDK starts ADC discovery.
vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: vi.fn(class AnthropicVertex {}),
}));
import {
  shouldAutoRename,
  extractRecentPrompts,
  generateSessionName,
  generateSessionNameFallback,
  sanitizeSessionName,
  setClientFactory,
  resetClientFactory,
  createAnthropicClient,
  AUTO_RENAME_INTERVAL,
  AUTO_RENAME_MODEL,
} from '../src/auto-rename.js';
import type { StoredEvent } from '@mitzo/protocol';

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

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const result = await generateSessionName(['Fix the auth bug', 'Update login page']);

    expect(result).toBe('Auth Bug Fix Session');
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0];
    expect(call[0].model).toBe(AUTO_RENAME_MODEL);
    expect(call[0].max_tokens).toBe(20);
    expect(call[0].messages[0].content).toBe('Fix the auth bug\n---\nUpdate login page');
    expect(call[1]).toEqual({ timeout: 5000 });
  });

  it('sanitizes Haiku output with embedded quotes', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '"Fix Auth Module"' }],
    });

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const result = await generateSessionName(['Fix the auth bug']);
    expect(result).toBe('Fix Auth Module');
  });

  it('falls back when Haiku generates conversational response', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'I apologize, but I cannot access the specific Jira ticket list',
        },
      ],
    });

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const prompts = ['check my jira tickets'];
    const result = await generateSessionName(prompts);
    const fallback = generateSessionNameFallback(prompts);
    expect(result).toBe(fallback);
  });

  it('truncates Haiku output at newlines', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '"OpenShift Agent Integration"\n\nWould you like me to',
        },
      ],
    });

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const result = await generateSessionName(['integrate openshift agent']);
    expect(result).toBe('OpenShift Agent Integration');
    expect(result).not.toContain('\n');
    expect(result).not.toContain('Would');
  });

  it('falls back to keyword extraction when API call fails', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('API key invalid'));

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const prompts = ['Fix the authentication bug', 'Update the login page'];
    const result = await generateSessionName(prompts);
    const fallback = generateSessionNameFallback(prompts);
    expect(result).toBe(fallback);
    expect(result.length).toBeGreaterThan(0);
  });

  it('truncates long Haiku responses', async () => {
    const longName = 'A'.repeat(80);
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: longName }],
    });

    setClientFactory(() => ({ messages: { create: mockCreate } }) as never);

    const result = await generateSessionName(['Some prompt']);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe('sanitizeSessionName', () => {
  it('passes through clean titles', () => {
    expect(sanitizeSessionName('Fix PR Shepherd CI Failures')).toBe('Fix PR Shepherd CI Failures');
  });

  it('strips surrounding double quotes', () => {
    expect(sanitizeSessionName('"Decoupling AI Architecture"')).toBe('Decoupling AI Architecture');
  });

  it('strips surrounding single quotes', () => {
    expect(sanitizeSessionName("'Some Title'")).toBe('Some Title');
  });

  it('truncates at first newline', () => {
    expect(sanitizeSessionName('Good Title\n\nWould you like me to')).toBe('Good Title');
  });

  it('rejects apology responses', () => {
    expect(sanitizeSessionName('I apologize, but I cannot access')).toBe('');
    expect(sanitizeSessionName("I can't determine the topic")).toBe('');
    expect(sanitizeSessionName("I don't have enough context")).toBe('');
    expect(sanitizeSessionName('I am sorry but')).toBe('');
  });

  it('rejects generic conversation starters', () => {
    expect(sanitizeSessionName('Start a Conversation')).toBe('');
    expect(sanitizeSessionName('Start A Conversation')).toBe('');
    expect(sanitizeSessionName('Begin New Chat Session')).toBe('');
    expect(sanitizeSessionName('New Conversation')).toBe('');
  });

  it('rejects conversational filler', () => {
    expect(sanitizeSessionName('Sure, here is the title')).toBe('');
    expect(sanitizeSessionName('Certainly! Fix the bug')).toBe('');
    expect(sanitizeSessionName('Here is the session name')).toBe('');
  });

  it('enforces max length', () => {
    const long = 'A'.repeat(80);
    const result = sanitizeSessionName(long);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('handles combined issues: quotes + newline + trailing text', () => {
    expect(sanitizeSessionName('"OpenShift Integration"\n\nWould you like me to elaborate?')).toBe(
      'OpenShift Integration',
    );
  });
});

describe('AUTO_RENAME_INTERVAL', () => {
  it('is 2', () => {
    expect(AUTO_RENAME_INTERVAL).toBe(2);
  });
});

describe('createAnthropicClient (Vertex)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns AnthropicVertex client when CLAUDE_CODE_USE_VERTEX is set', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'my-project';
    process.env.CLOUD_ML_REGION = 'us-east5';

    const { AnthropicVertex } = await import('@anthropic-ai/vertex-sdk');
    const client = createAnthropicClient();
    expect(client).toBeInstanceOf(AnthropicVertex);
    expect(AnthropicVertex).toHaveBeenCalledWith({ projectId: 'my-project', region: 'us-east5' });
  });

  it('returns standard Anthropic client when CLAUDE_CODE_USE_VERTEX is not set', async () => {
    delete process.env.CLAUDE_CODE_USE_VERTEX;
    const { default: Anthropic } = await import('@anthropic-ai/sdk');

    const client = createAnthropicClient();
    expect(client).toBeInstanceOf(Anthropic);
  });
});
