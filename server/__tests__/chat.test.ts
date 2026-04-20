import { describe, it, expect, vi } from 'vitest';

describe('chat module exports', () => {
  it('exports expected functions', async () => {
    const chat = await import('../chat.js');
    expect(typeof chat.startChat).toBe('function');
    expect(typeof chat.stopChat).toBe('function');
    expect(typeof chat.isActive).toBe('function');
    expect(typeof chat.getSessions).toBe('function');
    expect(typeof chat.getMessages).toBe('function');
    expect(typeof chat.detachChat).toBe('function');
    expect(typeof chat.reattachChat).toBe('function');
    expect(typeof chat.hideSession).toBe('function');
    expect(typeof chat.clearHiddenSessions).toBe('function');
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
    const result = await getSessions();
    expect(Array.isArray(result.sessions)).toBe(true);
    expect(typeof result.hasMore).toBe('boolean');
  });

  it('session objects have expected shape', async () => {
    const { getSessions } = await import('../chat.js');
    const { sessions } = await getSessions();
    for (const s of sessions) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('summary');
      expect(s).toHaveProperty('lastModified');
    }
  });
});

describe('resolveResumeCwd', () => {
  it('falls back to BASE_REPO when stored CWD no longer exists', async () => {
    const chat = await import('../chat.js');

    const result = chat.resolveResumeCwd({ resume: 'sess-test' }, {
      getSession: () => ({ cwd: '/tmp/deleted-worktree' }),
      pathExists: () => false,
    });

    expect(result).toBe(chat.BASE_REPO);
  });

  it('uses stored CWD when it still exists', async () => {
    const chat = await import('../chat.js');

    const result = chat.resolveResumeCwd({ resume: 'sess-test' }, {
      getSession: () => ({ cwd: '/existing/path' }),
      pathExists: () => true,
    });

    expect(result).toBe('/existing/path');
  });

  it('returns explicit cwd when provided (ignores resume)', async () => {
    const chat = await import('../chat.js');
    const result = chat.resolveResumeCwd({ cwd: '/explicit', resume: 'sess-test' });
    expect(result).toBe('/explicit');
  });

  it('returns BASE_REPO when no resume or cwd', async () => {
    const chat = await import('../chat.js');
    const result = chat.resolveResumeCwd({});
    expect(result).toBe(chat.BASE_REPO);
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
