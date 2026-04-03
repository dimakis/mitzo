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
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('chatMessagesReducer', () => {
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
      result.current.handleWsMessage({ type: 'reattach_failed' });
    });

    await vi.waitFor(() => {
      expect(result.current.state.messages).toHaveLength(1);
    });

    expect(result.current.state.messages[0].messageId).toBe('r1');
    expect(result.current.state.running).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/sessions/test-session-id/messages',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
