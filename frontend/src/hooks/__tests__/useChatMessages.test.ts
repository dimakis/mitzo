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

describe('RESTORE with interrupted preserves optimistic user messages', () => {
  it('merges optimistic user sends not present in restored set', () => {
    const stateWithOptimistic: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'user-1234',
          role: 'user',
          blocks: [{ blockId: 'user-text-1234', blockType: 'text', content: 'my question' }],
        },
        {
          messageId: 'a1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'response' }],
        },
        {
          messageId: 'user-5678',
          role: 'user',
          blocks: [{ blockId: 'user-text-5678', blockType: 'text', content: 'follow-up' }],
        },
      ],
    };

    // Restored set includes first user + assistant, but NOT the optimistic follow-up
    const restoredMsgs = [
      {
        messageId: 'user-1234' as string,
        role: 'user' as const,
        blocks: [{ blockId: 'user-text-1234', blockType: 'text' as const, content: 'my question' }],
      },
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'response' }],
      },
    ];

    const result = chatMessagesReducer(stateWithOptimistic, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    // Should have: restored msgs + optimistic user + notice
    const userMsgs = result.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs.some((m) => m.messageId === 'user-5678')).toBe(true);

    // Verify ordering: restored messages come first, then optimistic user, then notice
    const ids = result.messages.map((m) => m.messageId);
    const optimisticIdx = ids.indexOf('user-5678');
    const a1Idx = ids.indexOf('a1');
    expect(optimisticIdx).toBeGreaterThan(a1Idx);

    // Verify the interruption notice is the last message
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect(lastMsg.blocks[0].content).toContain('interrupted');
    expect(result.messages).toHaveLength(4); // user-1234, a1, user-5678, notice
  });

  it('does not duplicate user messages already in restored set', () => {
    const stateWithOptimistic: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'user-1234',
          role: 'user',
          blocks: [{ blockId: 'user-text-1234', blockType: 'text', content: 'question' }],
        },
      ],
    };

    const restoredMsgs = [
      {
        messageId: 'user-1234' as string,
        role: 'user' as const,
        blocks: [{ blockId: 'user-text-1234', blockType: 'text' as const, content: 'question' }],
      },
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'answer' }],
      },
    ];

    const result = chatMessagesReducer(stateWithOptimistic, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    // user-1234 should appear only once (from restored set)
    const user1234 = result.messages.filter((m) => m.messageId === 'user-1234');
    expect(user1234).toHaveLength(1);
  });

  it('does not merge assistant messages as optimistic', () => {
    const stateWithOrphan: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'orphan-assistant',
          role: 'assistant',
          blocks: [{ blockId: 'ob1', blockType: 'text', content: 'stale' }],
        },
      ],
    };

    const restoredMsgs = [
      {
        messageId: 'a1' as string,
        role: 'assistant' as const,
        blocks: [{ blockId: 'b1', blockType: 'text' as const, content: 'fresh' }],
      },
    ];

    const result = chatMessagesReducer(stateWithOrphan, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    // Should NOT include the orphan assistant message — identify non-notice assistants by messageId
    const nonNoticeAssistantMsgs = result.messages.filter(
      (m) => m.role === 'assistant' && m.messageId === 'a1',
    );
    expect(nonNoticeAssistantMsgs).toHaveLength(1);

    // The orphan should not be present at all
    expect(result.messages.some((m) => m.messageId === 'orphan-assistant')).toBe(false);
  });
});

describe('USER_MESSAGE_RECEIVED deduplication', () => {
  it('adds user message when not already present', () => {
    const result = chatMessagesReducer(INITIAL_STATE, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-100',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageId).toBe('umsg-100');
    expect(result.messages[0].role).toBe('user');
  });

  it('skips duplicate when message with same ID already exists', () => {
    const stateWithMsg: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'umsg-100',
          role: 'user',
          blocks: [{ blockId: 'ut', blockType: 'text', content: 'hello' }],
        },
      ],
    };
    const result = chatMessagesReducer(stateWithMsg, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-100',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(1);
    expect(result).toBe(stateWithMsg); // reference equality — no state change
  });

  it('skips duplicate when ID collides with an existing assistant message', () => {
    const stateWithAssistant: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'shared-id',
          role: 'assistant',
          blocks: [{ blockId: 'ab1', blockType: 'text', content: 'response' }],
        },
      ],
    };
    const result = chatMessagesReducer(stateWithAssistant, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'shared-id',
      text: 'hello',
    });
    // Should not add a duplicate — ID already exists regardless of role
    expect(result.messages).toHaveLength(1);
    expect(result).toBe(stateWithAssistant);
  });

  it('adds message with different ID when no optimistic match exists', () => {
    const stateWithMsg: ChatMessagesState = {
      ...INITIAL_STATE,
      messages: [
        {
          messageId: 'umsg-100',
          role: 'user',
          blocks: [{ blockId: 'ut', blockType: 'text', content: 'hello' }],
        },
      ],
    };
    // umsg-100 is a server ID (not optimistic user-*), so same text should still add
    const result = chatMessagesReducer(stateWithMsg, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-200',
      text: 'hello',
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].messageId).toBe('umsg-200');
  });

  it('deduplicates optimistic USER_SEND when server echo arrives with different ID', () => {
    // Simulate: user sends message (optimistic), then server echoes it back
    const afterSend = chatMessagesReducer(INITIAL_STATE, {
      type: 'USER_SEND',
      text: "Yep. Let's go",
    });
    expect(afterSend.messages).toHaveLength(1);
    expect(afterSend.messages[0].messageId).toMatch(/^user-/);

    // Server echoes back with a different ID
    const afterEcho = chatMessagesReducer(afterSend, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-999-send',
      text: "Yep. Let's go",
    });
    // Should NOT duplicate — should upgrade the ID instead
    expect(afterEcho.messages).toHaveLength(1);
    expect(afterEcho.messages[0].messageId).toBe('umsg-999-send');
    expect(afterEcho.messages[0].blocks[0].content).toBe("Yep. Let's go");
  });

  it('adds server echo when no optimistic message matches the text', () => {
    // User sent "hello" optimistically, but server echoes "different text"
    const afterSend = chatMessagesReducer(INITIAL_STATE, {
      type: 'USER_SEND',
      text: 'hello',
    });
    const result = chatMessagesReducer(afterSend, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-999-send',
      text: 'different text',
    });
    // Different text — should add as a new message
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].messageId).toBe('umsg-999-send');
  });

  it('adds server message when no optimistic user-* message exists (reconnect)', () => {
    // Reconnect scenario: no optimistic message in state, server replays
    const result = chatMessagesReducer(INITIAL_STATE, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-500-send',
      text: 'reconnected message',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].messageId).toBe('umsg-500-send');
  });

  it('deduplicates after RESTORE with interrupted flow', () => {
    // Simulate: user sent a message, session was interrupted, RESTORE happened,
    // then the same USER_MESSAGE_RECEIVED arrives again
    const restoredMsgs = [
      {
        messageId: 'umsg-100',
        role: 'user' as const,
        blocks: [{ blockId: 'ut', blockType: 'text' as const, content: 'hello' }],
      },
    ];
    const restored = chatMessagesReducer(INITIAL_STATE, {
      type: 'RESTORE',
      messages: restoredMsgs,
      interrupted: true,
    });

    // Now a duplicate USER_MESSAGE_RECEIVED arrives
    const result = chatMessagesReducer(restored, {
      type: 'USER_MESSAGE_RECEIVED',
      messageId: 'umsg-100',
      text: 'hello',
    });

    const userMsgs = result.messages.filter((m) => m.messageId === 'umsg-100');
    expect(userMsgs).toHaveLength(1);
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
