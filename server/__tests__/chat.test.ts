import { describe, it, expect, vi } from 'vitest';
import type { ManagedSession } from '@mitzo/harness';

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
    expect(typeof chat.hideAllSessions).toBe('function');
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

describe('getMessages', () => {
  it('returns an array for unknown session', async () => {
    const { getMessages } = await import('../chat.js');
    const messages = await getMessages('nonexistent-session-id');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(0);
  });
});

describe('cleanupSessionWorktrees', () => {
  it('skips primary worktree and only removes secondaries', async () => {
    vi.spyOn(await import('../worktree.js'), 'removeWorktree').mockImplementation(() => {});

    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map([
        ['primary', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }],
        ['mitzo', { path: '/tools/mitzo/.claude/worktrees/abc', wtId: 'abc' }],
        ['centaur', { path: '/projects/centaur/.claude/worktrees/abc', wtId: 'abc' }],
      ]),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    // Primary should be preserved in the map
    expect(session.worktreePaths.has('primary')).toBe(true);
    expect(session.worktreePaths.get('primary')?.wtId).toBe('abc');

    // Secondary entries should be removed from the map
    expect(session.worktreePaths.has('mitzo')).toBe(false);
    expect(session.worktreePaths.has('centaur')).toBe(false);
    expect(session.worktreePaths.size).toBe(1);

    vi.restoreAllMocks();
  });

  it('handles session with only primary worktree', async () => {
    vi.spyOn(await import('../worktree.js'), 'removeWorktree').mockImplementation(() => {});

    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map([
        ['primary', { path: '/repo/.claude/worktrees/abc', wtId: 'abc' }],
      ]),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    expect(session.worktreePaths.has('primary')).toBe(true);
    expect(session.worktreePaths.size).toBe(1);

    vi.restoreAllMocks();
  });

  it('handles session with no worktrees', async () => {
    const { cleanupSessionWorktrees } = await import('../chat.js');

    const session = {
      worktreePaths: new Map(),
    } as unknown as ManagedSession;

    cleanupSessionWorktrees(session);

    expect(session.worktreePaths.size).toBe(0);
  });
});
