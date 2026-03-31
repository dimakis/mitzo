import { describe, it, expect } from 'vitest';

// We can't easily test the full Agent SDK integration without mocking,
// but we can test the utility functions and message flow logic.
// The SDK itself is tested by Anthropic; we test our glue code.

// Import the summarizeToolInput function by extracting it.
// Since it's not exported, we test it indirectly through the module behavior.
// For now, test the public API shape.

describe('chat module exports', () => {
  it('exports expected functions', async () => {
    const chat = await import('../chat.js');
    expect(typeof chat.startChat).toBe('function');
    expect(typeof chat.stopChat).toBe('function');
    expect(typeof chat.isActive).toBe('function');
    expect(typeof chat.getSessions).toBe('function');
    expect(typeof chat.getMessages).toBe('function');
  });

  it('isActive returns false for unknown client', async () => {
    const { isActive } = await import('../chat.js');
    expect(isActive('nonexistent-client')).toBe(false);
  });

  it('stopChat is safe to call for unknown client', async () => {
    const { stopChat } = await import('../chat.js');
    expect(() => stopChat('nonexistent-client')).not.toThrow();
  });
});

describe('getSessions', () => {
  it('returns an array', async () => {
    const { getSessions } = await import('../chat.js');
    const sessions = await getSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('session objects have expected shape', async () => {
    const { getSessions } = await import('../chat.js');
    const sessions = await getSessions();
    for (const s of sessions) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('summary');
      expect(s).toHaveProperty('lastModified');
    }
  });
});

describe('getMessages', () => {
  it('returns an array for unknown session', async () => {
    const { getMessages } = await import('../chat.js');
    const messages = await getMessages('nonexistent-session-id');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(0);
  });
});
