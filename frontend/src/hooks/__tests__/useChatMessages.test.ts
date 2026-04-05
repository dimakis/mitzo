// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/ws-pool', () => ({
  wsSetRunning: vi.fn(),
  wsSend: vi.fn(),
}));

import { chatMessagesReducer, useChatMessages } from '../useChatMessages';
import type { ChatMessagesState } from '../useChatMessages';

const INITIAL_STATE: ChatMessagesState = {
  messages: [],
  current: null,
  running: false,
  permission: null,
  branch: null,
  isWorktree: false,
  activeWorktrees: [],
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('chatMessagesReducer', () => {
  it('RESTORE with interrupted flag appends a notice message', () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hi' }],
      },
    ];
    const result = chatMessagesReducer(INITIAL_STATE, {
      type: 'RESTORE',
      messages: msgs,
      interrupted: true,
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].messageId).toBe('m1');
    // The notice message should be appended
    const notice = result.messages[1];
    expect(notice.role).toBe('assistant');
    expect(notice.blocks[0].content).toContain('interrupted');
  });

  it('RESTORE without interrupted flag does not append notice', () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hi' }],
      },
    ];
    const result = chatMessagesReducer(INITIAL_STATE, { type: 'RESTORE', messages: msgs });
    expect(result.messages).toHaveLength(1);
  });

  it('RESTORE does not replace when state has more messages than incoming', () => {
    const existing: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'first' }],
        },
        {
          messageId: 'm2',
          role: 'user',
          blocks: [{ blockId: 'b2', blockType: 'text', content: 'second' }],
        },
        {
          messageId: 'm3',
          role: 'assistant',
          blocks: [{ blockId: 'b3', blockType: 'text', content: 'third' }],
        },
      ],
    };
    // API returns fewer messages — should NOT replace
    const apiMsgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'first' }],
      },
    ];
    const result = chatMessagesReducer(existing, { type: 'RESTORE', messages: apiMsgs });
    expect(result.messages).toHaveLength(3); // kept existing
  });

  it('RESTORE replaces when incoming has more messages than state', () => {
    const existing: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'first' }],
        },
      ],
    };
    const apiMsgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'first' }],
      },
      {
        messageId: 'm2',
        role: 'user' as const,
        blocks: [{ blockId: 'b2', blockType: 'text' as const, content: 'second' }],
      },
    ];
    const result = chatMessagesReducer(existing, { type: 'RESTORE', messages: apiMsgs });
    expect(result.messages).toHaveLength(2); // replaced with API data
  });

  it('RESTORE replaces messages with valid v2 messages', () => {
    const msgs = [
      {
        messageId: 'm1',
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'hi' }],
      },
    ];
    const result = chatMessagesReducer(INITIAL_STATE, { type: 'RESTORE', messages: msgs });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageId).toBe('m1');
  });

  it('RESTORE filters out invalid messages', () => {
    const msgs = [
      { messageId: 'm1', role: 'assistant' as const, blocks: [] },
      { messageId: null as unknown as string, role: 'assistant' as const, blocks: [] },
      null as unknown as { messageId: string; role: 'assistant'; blocks: [] },
    ];
    const result = chatMessagesReducer(INITIAL_STATE, { type: 'RESTORE', messages: msgs });
    expect(result.messages).toHaveLength(1);
  });

  it('WORKTREE_OPENED adds a new worktree to activeWorktrees', () => {
    const result = chatMessagesReducer(INITIAL_STATE, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
    expect(result.activeWorktrees).toHaveLength(1);
    expect(result.activeWorktrees[0]).toEqual({
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
  });

  it('WORKTREE_OPENED ignores duplicate repo (first-write-wins)', () => {
    // The server is the source of truth for worktree paths. Once a repo
    // is opened, subsequent events for the same repo are ignored — the
    // original path is the canonical one for this session.
    const state1 = chatMessagesReducer(INITIAL_STATE, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-123',
    });
    const state2 = chatMessagesReducer(state1, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-456',
    });
    expect(state2.activeWorktrees).toHaveLength(1);
    expect(state2.activeWorktrees[0].path).toBe('/tmp/team_home-sessions/session-wt-123');
    expect(state2).toBe(state1); // reference equality — no state change
  });

  it('WORKTREE_OPENED tracks multiple repos', () => {
    const state1 = chatMessagesReducer(INITIAL_STATE, {
      type: 'WORKTREE_OPENED',
      repoName: 'mgmt',
      path: '/tmp/mgmt-sessions/session-wt-1',
    });
    const state2 = chatMessagesReducer(state1, {
      type: 'WORKTREE_OPENED',
      repoName: 'team_home',
      path: '/tmp/team_home-sessions/session-wt-2',
    });
    expect(state2.activeWorktrees).toHaveLength(2);
  });
});

describe('useChatMessages — reattach_failed handler', () => {
  it('restores messages from API array response on reattach_failed', async () => {
    const apiMessages = [
      {
        messageId: 'r1',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'restored' }],
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(apiMessages),
    });

    const onSessionAssigned = vi.fn();
    const onSessionExpired = vi.fn();

    const { result } = renderHook(() =>
      useChatMessages('session:test', 'test-session-id', onSessionAssigned, onSessionExpired),
    );

    act(() => {
      result.current.handleWsMessage({ type: 'reattach_failed', clientId: 'old-client' });
    });

    await vi.waitFor(() => {
      expect(result.current.state.messages.length).toBeGreaterThanOrEqual(1);
      expect(result.current.state.messages[0].messageId).toBe('r1');
    });

    // reattach_failed dispatches RESTORE with interrupted: true,
    // so a notice message is appended after the restored messages.
    expect(result.current.state.messages).toHaveLength(2);
    expect(result.current.state.messages[1].blocks[0].content).toContain('interrupted');
    expect(result.current.state.running).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/sessions/test-session-id/messages',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('calls onMessagesRestored callback after reattach restore', async () => {
    const apiMessages = [
      {
        messageId: 'r1',
        role: 'assistant',
        blocks: [{ blockId: 'b1', blockType: 'text', content: 'restored' }],
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(apiMessages),
    });

    const onMessagesRestored = vi.fn();

    const { result } = renderHook(() =>
      useChatMessages('session:test', 'test-session-id', vi.fn(), vi.fn(), onMessagesRestored),
    );

    act(() => {
      result.current.handleWsMessage({ type: 'reattach_failed', clientId: 'old-client' });
    });

    await vi.waitFor(() => {
      expect(onMessagesRestored).toHaveBeenCalledTimes(1);
    });
  });
});
